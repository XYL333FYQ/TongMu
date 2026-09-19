import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddRealtimePersistence1790200000000 implements MigrationInterface {
  name = 'AddRealtimePersistence1790200000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('room')) {
      if (!(await queryRunner.hasColumn('room', 'moderators'))) {
        await queryRunner.query(`ALTER TABLE "room" ADD COLUMN "moderators" text NOT NULL DEFAULT ('[]')`);
      }
      if (!(await queryRunner.hasColumn('room', 'voiceMuted'))) {
        await queryRunner.query(`ALTER TABLE "room" ADD COLUMN "voiceMuted" text NOT NULL DEFAULT ('[]')`);
      }
    }
    if (await queryRunner.hasTable('playback_states')) {
      if (!(await queryRunner.hasColumn('playback_states', 'version'))) {
        await queryRunner.query('ALTER TABLE "playback_states" ADD COLUMN "version" integer NOT NULL DEFAULT (0)');
      }
      if (!(await queryRunner.hasColumn('playback_states', 'sourceGeneration'))) {
        await queryRunner.query('ALTER TABLE "playback_states" ADD COLUMN "sourceGeneration" integer NOT NULL DEFAULT (0)');
      }
    }
  }

  async down(): Promise<void> {
    throw new Error('Destructive database downgrade is unsupported; restore the pre-upgrade backup instead.');
  }
}
