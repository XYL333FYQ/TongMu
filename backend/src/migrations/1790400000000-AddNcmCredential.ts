import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddNcmCredential1790400000000 implements MigrationInterface {
  name = 'AddNcmCredential1790400000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (await queryRunner.hasTable('ncm_credentials')) return;
    await queryRunner.query(`CREATE TABLE "ncm_credentials" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "userId" integer NOT NULL, "provider" varchar NOT NULL DEFAULT ('ncm'), "credentialEnvelope" text NOT NULL, "credentialVersion" integer NOT NULL DEFAULT (1), "status" varchar CHECK( "status" IN ('logged-in','invalid') ) NOT NULL DEFAULT ('logged-in'), "accountId" varchar, "displayName" varchar, "avatarUrl" varchar, "lastValidatedAt" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_556fd374fdfb0e24d830bd40dba" UNIQUE ("userId"))`);
  }

  async down(): Promise<void> {
    throw new Error('NCM downgrade can discard credential metadata; restore the pre-upgrade backup instead.');
  }
}
