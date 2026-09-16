import { AppDataSource } from '../../../data-source';
import { NcmCredential } from '../../../entities/NcmCredential';
import {
  SecretVaultError,
  secretVault,
} from '../../../services/secret-vault';
import type {
  NcmCredentialSecrets,
  NcmCredentialStatusDto,
  NcmProfileFacts,
} from './types';

const MAX_COOKIE_HEADER_LENGTH = 64 * 1024;
const ENVELOPE_VERSION = 1;

interface StoredCredential {
  version: typeof ENVELOPE_VERSION;
  cookieHeader: string;
  csrfToken?: string;
}

type CredentialVault = Pick<typeof secretVault, 'encrypt' | 'decrypt'>;

function isPositiveUserId(userId: number): boolean {
  return Number.isSafeInteger(userId) && userId > 0;
}

function parseStoredCredential(value: string, vault: CredentialVault): NcmCredentialSecrets {
  const decrypted = vault.decrypt(value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(decrypted);
  } catch {
    throw new SecretVaultError('NCM 凭据内容无效');
  }
  if (!parsed || typeof parsed !== 'object') throw new SecretVaultError('NCM 凭据内容无效');
  const record = parsed as Partial<StoredCredential>;
  if (record.version !== ENVELOPE_VERSION || typeof record.cookieHeader !== 'string' ||
      !record.cookieHeader.trim() || record.cookieHeader.length > MAX_COOKIE_HEADER_LENGTH) {
    throw new SecretVaultError('NCM 凭据内容无效');
  }
  const secrets: NcmCredentialSecrets = {
    cookieHeader: record.cookieHeader,
    ...(typeof record.csrfToken === 'string' && record.csrfToken.length <= 4096
      ? { csrfToken: record.csrfToken }
      : {}),
  };
  validateSecrets(secrets);
  return secrets;
}

function validateSecrets(value: NcmCredentialSecrets): void {
  if (!value || typeof value.cookieHeader !== 'string' ||
      !value.cookieHeader.trim() || value.cookieHeader.length > MAX_COOKIE_HEADER_LENGTH ||
      /[\r\n]/.test(value.cookieHeader)) {
    throw new SecretVaultError('NCM Cookie 格式无效');
  }
  if (value.csrfToken !== undefined &&
      (value.csrfToken.length > 4096 || /[\r\n]/.test(value.csrfToken))) {
    throw new SecretVaultError('NCM CSRF 凭据格式无效');
  }
}

function profileValue(value?: NcmProfileFacts): Required<NcmProfileFacts> {
  return {
    accountId: value?.accountId || null,
    displayName: value?.displayName || null,
    avatarUrl: value?.avatarUrl || null,
  };
}

/**
 * Owns the only boundary that can decrypt an NCM credential. Callers receive
 * a private value for the duration of a server-side provider request; status
 * and profile methods never return that value.
 */
export class NcmCredentialService {
  private readonly dataSource: typeof AppDataSource;
  private vault: CredentialVault;
  private readonly locks = new Map<number, Promise<unknown>>();
  private readonly generations = new Map<number, number>();

  constructor(dataSource: typeof AppDataSource = AppDataSource, vault: CredentialVault = secretVault) {
    this.dataSource = dataSource;
    this.vault = vault;
  }

  private repository() {
    return this.dataSource.getRepository(NcmCredential);
  }

  private async withLock<T>(userId: number, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(userId) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.locks.set(userId, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(userId) === current) this.locks.delete(userId);
    }
  }

  private currentGeneration(userId: number, row?: NcmCredential | null): number {
    const persisted = row?.credentialVersion || 0;
    const current = Math.max(this.generations.get(userId) || 0, persisted);
    this.generations.set(userId, current);
    return current;
  }

  async getCredentialVersion(userId: number): Promise<number | null> {
    if (!isPositiveUserId(userId)) return null;
    const row = await this.repository().findOneBy({ userId });
    return row ? this.currentGeneration(userId, row) : null;
  }

  async getCurrentGeneration(userId: number): Promise<number> {
    if (!isPositiveUserId(userId)) return 0;
    const row = await this.repository().findOneBy({ userId });
    return this.currentGeneration(userId, row);
  }

  async isGenerationCurrent(userId: number, expected: number): Promise<boolean> {
    return (await this.getCurrentGeneration(userId)) === expected;
  }

  async getPrivateCredential(userId: number): Promise<NcmCredentialSecrets | null> {
    if (!isPositiveUserId(userId)) return null;
    return this.withLock(userId, async () => {
      const row = await this.repository().findOneBy({ userId });
      if (!row || row.status !== 'logged-in') return null;
      try {
        return parseStoredCredential(row.credentialEnvelope, this.vault);
      } catch {
        return null;
      }
    });
  }

  async getStatus(userId: number): Promise<NcmCredentialStatusDto> {
    if (!isPositiveUserId(userId)) {
      return {
        provider: 'ncm', loggedIn: false, credentialValid: false,
        status: 'none', accountId: null, displayName: null, avatarUrl: null,
        credentialVersion: null, updatedAt: null,
      };
    }
    const row = await this.repository().findOneBy({ userId });
    if (!row) {
      return {
        provider: 'ncm', loggedIn: false, credentialValid: false,
        status: 'none', accountId: null, displayName: null, avatarUrl: null,
        credentialVersion: null, updatedAt: null,
      };
    }
    let valid = false;
    try {
      valid = row.status === 'logged-in' && !!parseStoredCredential(row.credentialEnvelope, this.vault).cookieHeader;
    } catch {
      valid = false;
    }
    return {
      provider: 'ncm',
      loggedIn: valid,
      credentialValid: valid,
      status: valid ? 'logged-in' : 'invalid',
      accountId: row.accountId || null,
      displayName: row.displayName || null,
      avatarUrl: row.avatarUrl || null,
      credentialVersion: row.credentialVersion,
      updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : null,
    };
  }

  async saveCredential(
    userId: number,
    secrets: NcmCredentialSecrets,
    profile?: NcmProfileFacts,
  ): Promise<number> {
    if (!isPositiveUserId(userId)) throw new SecretVaultError('NCM 用户身份无效');
    validateSecrets(secrets);
    return this.withLock(userId, async () => {
      const repository = this.repository();
      const existing = await repository.findOneBy({ userId });
      const current = this.currentGeneration(userId, existing);
      const nextVersion = Math.max(1, current + 1);
      const stored: StoredCredential = {
        version: ENVELOPE_VERSION,
        cookieHeader: secrets.cookieHeader,
        ...(secrets.csrfToken ? { csrfToken: secrets.csrfToken } : {}),
      };
      const facts = profileValue(profile);
      const row = existing || repository.create({ userId, provider: 'ncm' });
      row.provider = 'ncm';
      row.credentialEnvelope = this.vault.encrypt(JSON.stringify(stored));
      row.credentialVersion = nextVersion;
      row.status = 'logged-in';
      row.accountId = facts.accountId;
      row.displayName = facts.displayName;
      row.avatarUrl = facts.avatarUrl;
      row.lastValidatedAt = new Date();
      await repository.save(row);
      this.generations.set(userId, nextVersion);
      return nextVersion;
    });
  }

  async saveCredentialIfCurrent(
    userId: number,
    expectedGeneration: number,
    secrets: NcmCredentialSecrets,
    profile?: NcmProfileFacts,
  ): Promise<number> {
    return this.withLock(userId, async () => {
      const row = await this.repository().findOneBy({ userId });
      if (this.currentGeneration(userId, row) !== expectedGeneration) {
        throw new Error('NCM credential operation was replaced');
      }
      return this.saveCredentialUnlocked(userId, secrets, profile, row, expectedGeneration);
    });
  }

  private async saveCredentialUnlocked(
    userId: number,
    secrets: NcmCredentialSecrets,
    profile: NcmProfileFacts | undefined,
    existing: NcmCredential | null,
    current: number,
  ): Promise<number> {
    validateSecrets(secrets);
    const repository = this.repository();
    const nextVersion = Math.max(1, current + 1);
    const stored: StoredCredential = {
      version: ENVELOPE_VERSION,
      cookieHeader: secrets.cookieHeader,
      ...(secrets.csrfToken ? { csrfToken: secrets.csrfToken } : {}),
    };
    const facts = profileValue(profile);
    const row = existing || repository.create({ userId, provider: 'ncm' });
    row.provider = 'ncm';
    row.credentialEnvelope = this.vault.encrypt(JSON.stringify(stored));
    row.credentialVersion = nextVersion;
    row.status = 'logged-in';
    row.accountId = facts.accountId;
    row.displayName = facts.displayName;
    row.avatarUrl = facts.avatarUrl;
    row.lastValidatedAt = new Date();
    await repository.save(row);
    this.generations.set(userId, nextVersion);
    return nextVersion;
  }

  async clearCredential(userId: number): Promise<void> {
    if (!isPositiveUserId(userId)) return;
    await this.withLock(userId, async () => {
      const repository = this.repository();
      const row = await repository.findOneBy({ userId });
      const current = this.currentGeneration(userId, row);
      const nextVersion = current + 1;
      // Keep a versioned, credential-free tombstone so an old capability
      // cannot become valid again after a process restart and a later login.
      // The stored envelope contains no usable Cookie; getPrivateCredential
      // also refuses every row whose status is not logged-in.
      const revokedEnvelope = this.vault.encrypt(JSON.stringify({
        version: ENVELOPE_VERSION,
        cookieHeader: '',
      } satisfies StoredCredential));
      const revoked = row || repository.create({ userId, provider: 'ncm' });
      revoked.provider = 'ncm';
      revoked.credentialEnvelope = revokedEnvelope;
      revoked.credentialVersion = nextVersion;
      revoked.status = 'invalid';
      revoked.accountId = null;
      revoked.displayName = null;
      revoked.avatarUrl = null;
      revoked.lastValidatedAt = null;
      await repository.save(revoked);
      this.generations.set(userId, nextVersion);
    });
  }

  /** Test-only dependency injection; production remains SecretVault-backed. */
  setVaultForTests(vault?: CredentialVault): void {
    this.vault = vault || secretVault;
  }
}

export const ncmCredentialService = new NcmCredentialService();
