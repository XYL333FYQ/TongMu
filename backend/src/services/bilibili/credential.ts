import { AppDataSource } from '../../data-source';
import { BilibiliCredential } from '../../entities/BilibiliCredential';
import {
  isSecretVaultEnvelope,
  secretVault,
  SecretVaultError,
} from '../secret-vault';

const credentialRepository = () => AppDataSource.getRepository(BilibiliCredential);
let credentialVault: Pick<typeof secretVault, 'encrypt' | 'decrypt'> = secretVault;

type DecodedField = { value: string; legacy: boolean };

/** Strictly read the pre-V2 Base64 representation without treating arbitrary text as legacy. */
function decodeLegacyBase64(value: string): string {
  if (!value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new SecretVaultError('旧版凭据格式无效');
  }
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  if (!decoded || decoded.includes('\uFFFD') || !decoded.trim()) {
    throw new SecretVaultError('旧版凭据内容无效');
  }
  return decoded;
}

function decodeStoredField(value: string): DecodedField {
  if (isSecretVaultEnvelope(value)) {
    return { value: credentialVault.decrypt(value), legacy: false };
  }
  return { value: decodeLegacyBase64(value), legacy: true };
}

function encryptField(value: string): string {
  if (!value.trim()) throw new SecretVaultError('Bilibili credential 不能为空');
  return credentialVault.encrypt(value);
}

// A user can have QR polling, status checks and media requests in flight at
// the same time. Serializing reads per user makes legacy->V1 migration retry
// safe and prevents two saves from racing with one another.
const credentialLocks = new Map<string, Promise<unknown>>();

async function withCredentialLock<T>(userId: string, operation: () => Promise<T>): Promise<T> {
  const previous = credentialLocks.get(userId) || Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  credentialLocks.set(userId, current);
  try {
    return await current;
  } finally {
    if (credentialLocks.get(userId) === current) credentialLocks.delete(userId);
  }
}

async function migrateLegacyFields(
  credential: BilibiliCredential,
  storedCookie: string,
  storedRefreshToken: string | null,
  cookie: DecodedField,
  refreshToken: DecodedField | null,
): Promise<void> {
  if (!cookie.legacy && !(refreshToken?.legacy)) return;

  const originalCookie = credential.cookie;
  const originalRefreshToken = credential.refreshToken;
  try {
    // Encrypt all fields before touching the entity. If encryption fails, the
    // original database values remain untouched.
    const nextCookie = cookie.legacy ? credentialVault.encrypt(cookie.value) : originalCookie;
    const nextRefreshToken = refreshToken?.legacy
      ? credentialVault.encrypt(refreshToken.value)
      : originalRefreshToken;
    credential.cookie = nextCookie;
    credential.refreshToken = nextRefreshToken;
    await credentialRepository().save(credential);
  } catch {
    // Legacy reads remain usable even if the best-effort write-back fails.
    // Restore the in-memory entity so a retry cannot save partial garbage.
    credential.cookie = originalCookie || storedCookie;
    credential.refreshToken = originalRefreshToken ?? storedRefreshToken;
  }
}

export async function getCredential(
  userId: string,
): Promise<{ cookie: string; refreshToken?: string } | null> {
  return withCredentialLock(userId, async () => {
    const credential = await credentialRepository().findOneBy({ userId });
    if (!credential) return null;

    const storedCookie = credential.cookie;
    const storedRefreshToken = credential.refreshToken;
    const cookie = decodeStoredField(storedCookie);
    if (!cookie.value.trim()) return null;
    const refreshToken = storedRefreshToken ? decodeStoredField(storedRefreshToken) : null;

    await migrateLegacyFields(
      credential,
      storedCookie,
      storedRefreshToken,
      cookie,
      refreshToken,
    );
    return {
      cookie: cookie.value,
      refreshToken: refreshToken?.value || undefined,
    };
  });
}

export interface BilibiliCredentialStatus {
  loggedIn: boolean;
  credentialValid: boolean;
  credentialSource: 'none' | 'vault' | 'legacy' | 'invalid';
  updatedAt?: string;
}

/** Non-secret account status for UI/API consumers. */
export async function getCredentialStatus(userId: string): Promise<BilibiliCredentialStatus> {
  const credential = await credentialRepository().findOneBy({ userId });
  if (!credential) {
    return { loggedIn: false, credentialValid: false, credentialSource: 'none' };
  }
  const source = isSecretVaultEnvelope(credential.cookie) ? 'vault' : 'legacy';
  try {
    const value = await getCredential(userId);
    const latest = await credentialRepository().findOneBy({ userId });
    const persistedSource = latest && isSecretVaultEnvelope(latest.cookie) ? 'vault' : source;
    return {
      loggedIn: !!value?.cookie,
      credentialValid: !!value?.cookie,
      credentialSource: persistedSource,
      updatedAt: (latest || credential).updatedAt?.toISOString(),
    };
  } catch {
    return {
      loggedIn: false,
      credentialValid: false,
      credentialSource: 'invalid',
      updatedAt: credential.updatedAt?.toISOString(),
    };
  }
}

export async function saveCredential(
  userId: string,
  cookie: string,
  refreshToken?: string,
): Promise<void> {
  await withCredentialLock(userId, async () => {
    const repository = credentialRepository();
    const encryptedCookie = encryptField(cookie);
    const encryptedRefreshToken = refreshToken ? encryptField(refreshToken) : null;
    let credential = await repository.findOneBy({ userId });
    if (credential) {
      credential.cookie = encryptedCookie;
      credential.refreshToken = encryptedRefreshToken;
    } else {
      credential = repository.create({
        userId,
        cookie: encryptedCookie,
        refreshToken: encryptedRefreshToken,
      });
    }
    await repository.save(credential);
  });
}

export async function clearCredential(userId: string): Promise<void> {
  await withCredentialLock(userId, async () => {
    await credentialRepository().delete({ userId });
  });
}

/** Test hook; production uses the installation-persistent singleton above. */
export function __setCredentialVaultForTests(
  vault?: Pick<typeof secretVault, 'encrypt' | 'decrypt'>,
): void {
  credentialVault = vault || secretVault;
}
