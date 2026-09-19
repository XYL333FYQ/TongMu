import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Exact first schema snapshot proven by TongMu commit 71ba034.
 *
 * This is intentionally static SQL. Production schema creation must not depend
 * on current entity metadata or synchronize.
 */
export class CreateHistoricalBaseline1790000000000 implements MigrationInterface {
  name = 'CreateHistoricalBaseline1790000000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    const existing = (await queryRunner.getTables()).filter(
      (table) => !['migrations', 'sqlite_sequence', 'typeorm_metadata'].includes(table.name.toLowerCase()),
    );
    if (existing.length > 0) return;

    const statements = [
      `CREATE TABLE "room" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar NOT NULL, "name" varchar, "password" varchar, "maxViewers" integer NOT NULL DEFAULT (10), "status" varchar CHECK( "status" IN ('active','closed') ) NOT NULL DEFAULT ('active'), "mode" varchar CHECK( "mode" IN ('screen-share','watch-together') ) NOT NULL DEFAULT ('screen-share'), "shareMethod" varchar CHECK( "shareMethod" IN ('webrtc','stream-push') ) NOT NULL DEFAULT ('webrtc'), "streamKey" varchar, "requireApproval" boolean NOT NULL DEFAULT (0), "ownerUserId" integer, "mutedViewers" text NOT NULL DEFAULT ('[]'), "approvedViewers" text NOT NULL DEFAULT ('[]'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), "lastAccessedAt" datetime NOT NULL DEFAULT (CURRENT_TIMESTAMP), CONSTRAINT "UQ_45770efde052e41dee06d89c85c" UNIQUE ("roomId"))`,
      `CREATE TABLE "user" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "username" varchar NOT NULL, "passwordHash" varchar NOT NULL, "role" varchar CHECK( "role" IN ('root','admin','user','guest') ) NOT NULL DEFAULT ('guest'), "status" varchar CHECK( "status" IN ('active','pending') ) NOT NULL DEFAULT ('pending'), "avatar" varchar, "tokenInvalidBefore" datetime, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_78a916df40e02a9deb1c4b75edb" UNIQUE ("username"))`,
      `CREATE TABLE "session" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar NOT NULL, "socketId" varchar NOT NULL, "role" varchar CHECK( "role" IN ('sharer','viewer') ) NOT NULL, "userId" integer, "startedAt" datetime NOT NULL DEFAULT (datetime('now')), "endedAt" datetime, CONSTRAINT "FK_6bfcd8b79900d13de31fc4098f2" FOREIGN KEY ("roomId") REFERENCES "room" ("roomId") ON DELETE CASCADE ON UPDATE NO ACTION)`,
      `CREATE TABLE "comment" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar NOT NULL, "username" varchar NOT NULL, "content" varchar NOT NULL, "isDanmaku" boolean NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`,
      `CREATE INDEX "IDX_1d0e34fea50c2dfd763a0de060" ON "comment" ("roomId")`,
      `CREATE TABLE "bilibili_credential" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "userId" varchar NOT NULL, "cookie" text NOT NULL, "refreshToken" text, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "UQ_584a7b84cd938ca2185390464c7" UNIQUE ("userId"))`,
      `CREATE TABLE "movie" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar NOT NULL, "url" varchar NOT NULL, "title" varchar NOT NULL, "cover" varchar, "source" varchar, "audioUrl" varchar, "format" varchar, "videoCodec" varchar, "audioCodec" varchar, "duration" float, "cid" integer, "currentQn" integer, "acceptQuality" text, "pages" text, "currentPage" integer, "serverUrl" varchar, "path" varchar, "username" varchar, "password" varchar, "directLink" boolean NOT NULL DEFAULT (0), "wasmEngine" boolean NOT NULL DEFAULT (0), "playsvideoEnabled" boolean NOT NULL DEFAULT (1), "sourceMeta" text, "order" integer NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "FK_57adbb52d507cee958568376a2b" FOREIGN KEY ("roomId") REFERENCES "room" ("roomId") ON DELETE CASCADE ON UPDATE NO ACTION)`,
      `CREATE INDEX "IDX_57adbb52d507cee958568376a2" ON "movie" ("roomId")`,
      `CREATE TABLE "user_mount" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "userId" integer NOT NULL, "type" varchar CHECK( "type" IN ('webdav','ftp','openlist','emby','jellyfin') ) NOT NULL, "name" varchar NOT NULL, "serverUrl" varchar, "port" integer, "path" varchar, "username" varchar, "password" varchar, "indexUrl" varchar, "apiKey" varchar, "embyUserId" varchar, "directLink" boolean NOT NULL DEFAULT (0), "httpsDirect" boolean, "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`,
      `CREATE INDEX "IDX_e7bf053316e2d11bc6b7138cfc" ON "user_mount" ("userId")`,
      `CREATE TABLE "system_settings" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "autoDeleteInactiveRooms" boolean NOT NULL DEFAULT (1), "autoDeleteAfterHours" integer NOT NULL DEFAULT (24), "dataSourceConfig" json, "registrationMode" text NOT NULL DEFAULT ('approval'), "roomCreationMode" text NOT NULL DEFAULT ('admin-only'), "betaFeaturesEnabled" boolean NOT NULL DEFAULT (0), "dashDisabled" boolean NOT NULL DEFAULT (1), "cdnAccelerate" boolean NOT NULL DEFAULT (0), "embeddedSubtitleEnabled" boolean NOT NULL DEFAULT (1), "playsvideoEnabled" boolean NOT NULL DEFAULT (1), "cdnProxyUrl" text NOT NULL DEFAULT ('https://gh-proxy.com'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`,
      `CREATE TABLE "playback_states" ("roomId" varchar(50) PRIMARY KEY NOT NULL, "sourceUrl" text NOT NULL, "sourceType" varchar(50) NOT NULL, "audioUrl" text, "format" varchar(20), "videoCodec" varchar(50), "audioCodec" varchar(50), "cid" bigint, "isPlaying" boolean NOT NULL DEFAULT (0), "currentTime" double NOT NULL, "playbackRate" double NOT NULL DEFAULT (1), "duration" double NOT NULL DEFAULT (0), "currentQn" integer, "acceptQuality" text, "headers" text, "isPreview" boolean NOT NULL DEFAULT (0), "previewTitle" varchar(200), "bufferMode" boolean NOT NULL DEFAULT (0), "currentMovieId" integer, "lastUpdatedAt" bigint NOT NULL, "hostSocketId" varchar(50), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')), CONSTRAINT "FK_0b6bb13f02277263045c6aa108e" FOREIGN KEY ("roomId") REFERENCES "room" ("roomId") ON DELETE CASCADE ON UPDATE NO ACTION)`,
      `CREATE TABLE "server_folder" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "name" varchar NOT NULL, "absPath" varchar NOT NULL, "readonly" boolean NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`,
      `CREATE TABLE "danmaku_track" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "trackId" varchar NOT NULL, "roomId" varchar NOT NULL, "label" varchar NOT NULL, "source" text NOT NULL, "items" text NOT NULL, "offset" double NOT NULL DEFAULT (0), "hidden" boolean NOT NULL DEFAULT (0), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`,
      `CREATE TABLE "room_danmaku_meta" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "roomId" varchar NOT NULL, "blockKeywords" text NOT NULL DEFAULT ('[]'), "deletedLog" text NOT NULL DEFAULT ('[]'), "realtimeLog" text NOT NULL DEFAULT ('[]'), "createdAt" datetime NOT NULL DEFAULT (datetime('now')), "updatedAt" datetime NOT NULL DEFAULT (datetime('now')))`,
      `CREATE UNIQUE INDEX "IDX_5e01f9cc481b0ec77c0e131f63" ON "room_danmaku_meta" ("roomId")`,
      `CREATE TABLE "audit_logs" ("id" integer PRIMARY KEY AUTOINCREMENT NOT NULL, "actorUserId" integer, "actorUsername" varchar, "actorRole" varchar NOT NULL DEFAULT ('system'), "action" varchar NOT NULL, "target" varchar, "ip" varchar, "success" boolean NOT NULL DEFAULT (1), "detail" varchar, "createdAt" datetime NOT NULL DEFAULT (datetime('now')))`,
      `CREATE INDEX "IDX_c69efb19bf127c97e6740ad530" ON "audit_logs" ("createdAt")`,
    ];
    for (const statement of statements) await queryRunner.query(statement);
  }

  async down(): Promise<void> {
    throw new Error('Destructive database downgrade is unsupported; restore the pre-upgrade backup instead.');
  }
}
