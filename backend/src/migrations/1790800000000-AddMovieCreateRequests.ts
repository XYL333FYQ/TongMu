import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMovieCreateRequests1790800000000 implements MigrationInterface {
  name = 'AddMovieCreateRequests1790800000000';
  async up(runner: QueryRunner): Promise<void> {
    if (await runner.hasTable('movie_create_request')) return;
    await runner.query(`CREATE TABLE "movie_create_request" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar NOT NULL, "actorId" integer NOT NULL, "keyHash" varchar NOT NULL, "fingerprintEnvelope" text NOT NULL, "movieId" integer NOT NULL, CONSTRAINT "UQ_movie_create_request" UNIQUE ("roomId", "actorId", "keyHash"), CONSTRAINT "FK_movie_create_request_room" FOREIGN KEY ("roomId") REFERENCES "room" ("roomId") ON DELETE CASCADE ON UPDATE NO ACTION)`);
  }
  async down(): Promise<void> {
    throw new Error('Dropping durable receipts can duplicate delayed requests; restore the pre-upgrade backup instead.');
  }
}
