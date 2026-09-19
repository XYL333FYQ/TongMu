import type { MigrationInterface, QueryRunner } from 'typeorm';

function normalizeDefault(value: unknown): string {
  return String(value ?? '').replace(/[()\s]/g, '').toLowerCase();
}

export class CompletePhase1Schema1790100000000 implements MigrationInterface {
  name = 'CompletePhase1Schema1790100000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    // The older transitional media migration predates the committed baseline.
    // On a fresh install it runs before `movie` exists, so enforce the same
    // additive columns here after the historical baseline has been created.
    if (await queryRunner.hasTable('movie')) {
      if (!(await queryRunner.hasColumn('movie', 'sourceInput'))) {
        await queryRunner.query('ALTER TABLE "movie" ADD COLUMN "sourceInput" varchar');
      }
      if (!(await queryRunner.hasColumn('movie', 'mediaDescriptor'))) {
        await queryRunner.query('ALTER TABLE "movie" ADD COLUMN "mediaDescriptor" text');
      }
    }
    if (!(await queryRunner.hasTable('system_settings'))) return;
    const columns = await queryRunner.query('PRAGMA table_info("system_settings")');
    const mediaPolicyPresent = columns.some(
      (column: { name?: unknown }) => column.name === 'mediaPolicyVersion',
    );
    const dashColumn = columns.find(
      (column: { name?: unknown }) => column.name === 'dashDisabled',
    ) as { dflt_value?: unknown } | undefined;
    if (mediaPolicyPresent && normalizeDefault(dashColumn?.dflt_value) === '0') return;

    await queryRunner.query(`CREATE TABLE "system_settings_phase6a" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "autoDeleteInactiveRooms" boolean NOT NULL DEFAULT (1), "autoDeleteAfterHours" integer NOT NULL DEFAULT (24), "dataSourceConfig" json, "registrationMode" text NOT NULL DEFAULT ('approval'), "roomCreationMode" text NOT NULL DEFAULT ('admin-only'), "betaFeaturesEnabled" boolean NOT NULL DEFAULT (0), "dashDisabled" boolean NOT NULL DEFAULT (0), "mediaPolicyVersion" integer NOT NULL DEFAULT (0), "cdnAccelerate" boolean NOT NULL DEFAULT (0), "embeddedSubtitleEnabled" boolean NOT NULL DEFAULT (1), "playsvideoEnabled" boolean NOT NULL DEFAULT (1), "cdnProxyUrl" text NOT NULL DEFAULT ('https://gh-proxy.com'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`);
    const before = Number((await queryRunner.query('SELECT COUNT(*) AS count FROM "system_settings"'))[0]?.count || 0);
    const mediaPolicyExpression = mediaPolicyPresent ? '"mediaPolicyVersion"' : '0';
    await queryRunner.query(`INSERT INTO "system_settings_phase6a" ("id", "autoDeleteInactiveRooms", "autoDeleteAfterHours", "dataSourceConfig", "registrationMode", "roomCreationMode", "betaFeaturesEnabled", "dashDisabled", "mediaPolicyVersion", "cdnAccelerate", "embeddedSubtitleEnabled", "playsvideoEnabled", "cdnProxyUrl", "createdAt", "updatedAt") SELECT "id", "autoDeleteInactiveRooms", "autoDeleteAfterHours", "dataSourceConfig", "registrationMode", "roomCreationMode", "betaFeaturesEnabled", "dashDisabled", ${mediaPolicyExpression}, "cdnAccelerate", "embeddedSubtitleEnabled", "playsvideoEnabled", "cdnProxyUrl", "createdAt", "updatedAt" FROM "system_settings"`);
    const after = Number((await queryRunner.query('SELECT COUNT(*) AS count FROM "system_settings_phase6a"'))[0]?.count || 0);
    if (before !== after) throw new Error('system_settings shadow-table row-count verification failed');
    await queryRunner.query('DROP TABLE "system_settings"');
    await queryRunner.query('ALTER TABLE "system_settings_phase6a" RENAME TO "system_settings"');
  }

  async down(): Promise<void> {
    throw new Error('Destructive database downgrade is unsupported; restore the pre-upgrade backup instead.');
  }
}
