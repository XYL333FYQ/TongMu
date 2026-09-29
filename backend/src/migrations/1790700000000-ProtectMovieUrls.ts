import type { MigrationInterface, QueryRunner } from 'typeorm';
import { durableMovieUrl, requiresProtectedMovieUrl } from '../services/media/movie-url-storage';
import { isSecretVaultEnvelope, secretVault } from '../services/secret-vault';

type MigrationVault = Pick<typeof secretVault, 'encrypt' | 'decrypt'>;
let migrationVault: MigrationVault = secretVault;

function plaintext(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new Error('影片地址格式无效');
  return isSecretVaultEnvelope(value) ? migrationVault.decrypt(value) : value;
}

function protectedValue(raw: unknown, value: string | null): string | null {
  if (value === null) return null;
  if (isSecretVaultEnvelope(raw)) return String(raw);
  if (!requiresProtectedMovieUrl(value)) return value;
  const encrypted = migrationVault.encrypt(value);
  if (migrationVault.decrypt(encrypted) !== value) throw new Error('影片地址迁移验证失败');
  return encrypted;
}

export class ProtectMovieUrls1790700000000 implements MigrationInterface {
  name = 'ProtectMovieUrls1790700000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('movie'))) throw new Error('影片表缺失，拒绝跳过地址迁移');
    const rows = await queryRunner.query(
      'SELECT "id", "url", "sourceInput", "audioUrl", "mediaDescriptor" FROM "movie" ORDER BY "id"',
    );
    for (const row of rows as Array<Record<string, unknown>>) {
      const id = Number(row.id);
      const input = plaintext(row.sourceInput);
      const descriptor = typeof row.mediaDescriptor === 'string' ? row.mediaDescriptor : null;
      const originalUrl = plaintext(row.url);
      if (!originalUrl) throw new Error(`影片 ${id} 缺少 URL`);
      const durableUrl = durableMovieUrl(originalUrl, id, input, descriptor);
      const url = protectedValue(durableUrl === originalUrl ? row.url : durableUrl, durableUrl);
      const sourceInput = protectedValue(row.sourceInput, input);
      const audioUrl = protectedValue(row.audioUrl, plaintext(row.audioUrl));
      if (url !== row.url || sourceInput !== row.sourceInput || audioUrl !== row.audioUrl) {
        await queryRunner.query(
          'UPDATE "movie" SET "url" = ?, "sourceInput" = ?, "audioUrl" = ? WHERE "id" = ?',
          [url, sourceInput, audioUrl, id],
        );
      }
    }
    if (!(await queryRunner.hasTable('playback_states'))) throw new Error('播放状态表缺失，拒绝跳过地址迁移');
    const playbackRows = await queryRunner.query(
      'SELECT "roomId", "sourceUrl", "audioUrl", "headers" FROM "playback_states"',
    );
    for (const row of playbackRows as Array<Record<string, unknown>>) {
      const sourceUrl = protectedValue(row.sourceUrl, plaintext(row.sourceUrl));
      const audioUrl = protectedValue(row.audioUrl, plaintext(row.audioUrl));
      const headersPlaintext = plaintext(row.headers);
      const headers = headersPlaintext && !isSecretVaultEnvelope(row.headers)
        ? migrationVault.encrypt(headersPlaintext) : row.headers;
      if (headersPlaintext && migrationVault.decrypt(String(headers)) !== headersPlaintext) {
        throw new Error('播放凭证迁移验证失败');
      }
      if (sourceUrl !== row.sourceUrl || audioUrl !== row.audioUrl || headers !== row.headers) {
        await queryRunner.query(
          'UPDATE "playback_states" SET "sourceUrl" = ?, "audioUrl" = ?, "headers" = ? WHERE "roomId" = ?',
          [sourceUrl, audioUrl, headers, row.roomId],
        );
      }
    }
  }

  async down(): Promise<void> {
    throw new Error('Movie URL protection downgrade is unsupported; restore the backup instead.');
  }
}

/** Test-only injection; production always uses the installation SecretVault. */
export function __setMovieUrlMigrationVaultForTests(vault?: MigrationVault): void {
  migrationVault = vault || secretVault;
}
