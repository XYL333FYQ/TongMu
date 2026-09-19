import type { MigrationInterface, QueryRunner } from 'typeorm';
import {
  isSecretVaultEnvelope,
  secretVault,
  SecretVaultError,
} from '../services/secret-vault';

type MigrationVault = Pick<typeof secretVault, 'encrypt' | 'decrypt'>;
let migrationVault: MigrationVault = secretVault;

function decodeLegacyBase64(value: string): string {
  if (!value || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 === 1) {
    throw new SecretVaultError('旧版 Bilibili 凭据格式无效');
  }
  const decoded = Buffer.from(value, 'base64').toString('utf8');
  if (!decoded || decoded.includes('\uFFFD') || !decoded.trim()) {
    throw new SecretVaultError('旧版 Bilibili 凭据内容无效');
  }
  return decoded;
}

function verifiedEnvelope(plaintext: string): string {
  const envelope = migrationVault.encrypt(plaintext);
  if (migrationVault.decrypt(envelope) !== plaintext) {
    throw new SecretVaultError('SecretVault migration round-trip verification failed');
  }
  return envelope;
}

function validateOrEncrypt(value: string, kind: 'base64' | 'plaintext'): string {
  if (isSecretVaultEnvelope(value)) {
    migrationVault.decrypt(value);
    return value;
  }
  return verifiedEnvelope(kind === 'base64' ? decodeLegacyBase64(value) : value);
}

export class EncryptLegacyCredentials1790500000000 implements MigrationInterface {
  name = 'EncryptLegacyCredentials1790500000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('bilibili_credential')) {
      const rows = await queryRunner.query(
        'SELECT "id", "cookie", "refreshToken" FROM "bilibili_credential" ORDER BY "id"',
      );
      const changes: Array<{ id: number; cookie: string; refreshToken: string | null }> = [];
      for (const row of rows as Array<Record<string, unknown>>) {
        const cookie = validateOrEncrypt(String(row.cookie || ''), 'base64');
        const rawRefresh = row.refreshToken === null || row.refreshToken === undefined
          ? null
          : String(row.refreshToken);
        const refreshToken = rawRefresh === null ? null : validateOrEncrypt(rawRefresh, 'base64');
        if (cookie !== row.cookie || refreshToken !== rawRefresh) {
          changes.push({ id: Number(row.id), cookie, refreshToken });
        }
      }
      for (const change of changes) {
        await queryRunner.query(
          'UPDATE "bilibili_credential" SET "cookie" = ?, "refreshToken" = ? WHERE "id" = ?',
          [change.cookie, change.refreshToken, change.id],
        );
      }
    }

    if (await queryRunner.hasTable('user_mount')) {
      const rows = await queryRunner.query(
        'SELECT "id", "password", "apiKey" FROM "user_mount" ORDER BY "id"',
      );
      const changes: Array<{ id: number; password: string | null; apiKey: string | null }> = [];
      for (const row of rows as Array<Record<string, unknown>>) {
        const rawPassword = row.password === null || row.password === undefined ? null : String(row.password);
        const rawApiKey = row.apiKey === null || row.apiKey === undefined ? null : String(row.apiKey);
        const password = rawPassword === null || rawPassword === ''
          ? rawPassword
          : validateOrEncrypt(rawPassword, 'plaintext');
        const apiKey = rawApiKey === null || rawApiKey === ''
          ? rawApiKey
          : validateOrEncrypt(rawApiKey, 'plaintext');
        if (password !== rawPassword || apiKey !== rawApiKey) {
          changes.push({ id: Number(row.id), password, apiKey });
        }
      }
      for (const change of changes) {
        await queryRunner.query(
          'UPDATE "user_mount" SET "password" = ?, "apiKey" = ? WHERE "id" = ?',
          [change.password, change.apiKey, change.id],
        );
      }
    }

    // NCM did not exist in a historical TongMu schema. Existing rows can only
    // come from the current V2 synchronize-created schema and must already be
    // valid SecretVault envelopes. Never invent a plaintext NCM conversion.
    if (await queryRunner.hasTable('ncm_credentials')) {
      const rows = await queryRunner.query(
        'SELECT "credentialEnvelope" FROM "ncm_credentials" ORDER BY "id"',
      );
      for (const row of rows as Array<Record<string, unknown>>) {
        const value = String(row.credentialEnvelope || '');
        if (!isSecretVaultEnvelope(value)) {
          throw new SecretVaultError('NCM credential 不是受支持的 SecretVault envelope');
        }
        migrationVault.decrypt(value);
      }
    }
  }

  async down(): Promise<void> {
    throw new Error('Credential downgrade to plaintext/Base64 is unsupported; restore the backup instead.');
  }
}

/** Test-only injection; production always uses the installation SecretVault. */
export function __setMigrationVaultForTests(vault?: MigrationVault): void {
  migrationVault = vault || secretVault;
}
