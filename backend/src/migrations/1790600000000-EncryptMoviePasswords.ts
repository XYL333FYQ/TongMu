import type { MigrationInterface, QueryRunner } from 'typeorm';
import { decryptMovieField } from '../entities/Movie';
import { isSecretVaultEnvelope, secretVault } from '../services/secret-vault';

type MigrationVault = Pick<typeof secretVault, 'encrypt' | 'decrypt'>;
let migrationVault: MigrationVault = secretVault;

export class EncryptMoviePasswords1790600000000 implements MigrationInterface {
  name = 'EncryptMoviePasswords1790600000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('movie'))) throw new Error('影片表缺失，拒绝跳过密码迁移');
    const rows = await queryRunner.query('SELECT "id", "password" FROM "movie" ORDER BY "id"');
    const changes: Array<{ id: number; password: string }> = [];
    for (const row of rows as Array<Record<string, unknown>>) {
      const raw = row.password;
      if (raw === null || raw === undefined || raw === '') continue;
      if (typeof raw !== 'string') throw new Error('旧影片密码格式无效');
      if (isSecretVaultEnvelope(raw)) {
        migrationVault.decrypt(raw);
        continue;
      }
      const plain = decryptMovieField(raw);
      const password = migrationVault.encrypt(plain);
      if (migrationVault.decrypt(password) !== plain) throw new Error('影片密码迁移验证失败');
      changes.push({ id: Number(row.id), password });
    }
    for (const change of changes) {
      await queryRunner.query('UPDATE "movie" SET "password" = ? WHERE "id" = ?', [change.password, change.id]);
    }
  }

  async down(): Promise<void> {
    throw new Error('Movie password downgrade is unsupported; restore the backup instead.');
  }
}

/** Test-only injection; production always uses the installation SecretVault. */
export function __setMovieMigrationVaultForTests(vault?: MigrationVault): void {
  migrationVault = vault || secretVault;
}
