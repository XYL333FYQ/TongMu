import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMusicPersistence1790300000000 implements MigrationInterface {
  name = 'AddMusicPersistence1790300000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('music_queue_items'))) {
      await queryRunner.query(`CREATE TABLE "music_queue_items" ("queueItemId" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar(128) NOT NULL, "sourceRef" varchar(512) NOT NULL, "title" varchar(200) NOT NULL, "artist" varchar(200) NOT NULL DEFAULT (''), "album" varchar(200) NOT NULL DEFAULT (''), "artworkUrl" varchar(2048), "durationMs" integer NOT NULL DEFAULT (0), "orderIndex" integer NOT NULL, "createdByUserId" integer, "metadataJson" text NOT NULL DEFAULT ('{}'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "FK_ed9bebee334b502bf869c401974" FOREIGN KEY ("roomId") REFERENCES "room" ("roomId") ON DELETE CASCADE ON UPDATE NO ACTION)`);
    }
    if (!(await queryRunner.hasTable('music_room_states'))) {
      await queryRunner.query(`CREATE TABLE "music_room_states" ("roomId" varchar(128) PRIMARY KEY NOT NULL, "playMode" varchar CHECK( "playMode" IN ('sequential','repeat-one','repeat-all','shuffle') ) NOT NULL DEFAULT ('sequential'), "currentQueueItemId" integer, "shuffleSeed" varchar(128) NOT NULL DEFAULT (''), "shuffleOrderJson" text NOT NULL DEFAULT ('[]'), "shuffleHistoryJson" text NOT NULL DEFAULT ('[]'), "shuffleCursor" integer NOT NULL DEFAULT (0), "version" integer NOT NULL DEFAULT (0), "musicGeneration" integer NOT NULL DEFAULT (0), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "FK_95326e1b96c930b1540fc888ae4" FOREIGN KEY ("roomId") REFERENCES "room" ("roomId") ON DELETE CASCADE ON UPDATE NO ACTION)`);
    }
  }

  async down(): Promise<void> {
    throw new Error('Music downgrade can discard queue data; restore the pre-upgrade backup instead.');
  }
}
