const fs = require('node:fs');
const path = require('node:path');
const { DataSource } = require('typeorm');
const { CreateHistoricalBaseline1790000000000 } = require('../../dist/migrations/1790000000000-CreateHistoricalBaseline');
const { CompletePhase1Schema1790100000000 } = require('../../dist/migrations/1790100000000-CompletePhase1Schema');
const { AddRealtimePersistence1790200000000 } = require('../../dist/migrations/1790200000000-AddRealtimePersistence');
const { AddMusicPersistence1790300000000 } = require('../../dist/migrations/1790300000000-AddMusicPersistence');
const { AddNcmCredential1790400000000 } = require('../../dist/migrations/1790400000000-AddNcmCredential');
const { SecretVault } = require('../../dist/services/secret-vault');
const { sharedSqlJs } = require('../helpers/shared-sqljs');

const HISTORICAL_FIXTURES = [
  { id: 'tongmu-71ba034', evidence: 'commit 71ba034 entity snapshot', level: 0 },
  { id: 'tongmu-fe16563-media-core', evidence: 'commit fe16563 entity snapshot', level: 1 },
  { id: 'tongmu-f010531-phase1', evidence: 'commit f010531; c239ca6 changed only credential transformers', level: 2 },
  { id: 'tongmu-0e322a1-voice', evidence: 'commit 0e322a1 entity snapshot', level: 3 },
  { id: 'tongmu-98c6e71-realtime', evidence: 'commit 98c6e71 entity snapshot', level: 4 },
  { id: 'tongmu-0707e78-music', evidence: 'commit 0707e78 entity snapshot', level: 5 },
  { id: 'tongmu-8eea2bc-current-v2', evidence: 'commits 8eea2bc and 75ed7bd entity snapshots', level: 6 },
];

async function apply(queryRunner, migration) {
  await migration.up(queryRunner);
}

async function addMediaColumns(queryRunner) {
  await queryRunner.query('ALTER TABLE "movie" ADD COLUMN "sourceInput" varchar');
  await queryRunner.query('ALTER TABLE "movie" ADD COLUMN "mediaDescriptor" text');
}

async function addVoiceColumns(queryRunner) {
  await queryRunner.query(`ALTER TABLE "room" ADD COLUMN "moderators" text NOT NULL DEFAULT ('[]')`);
  await queryRunner.query(`ALTER TABLE "room" ADD COLUMN "voiceMuted" text NOT NULL DEFAULT ('[]')`);
}

async function insertRepresentativeData(queryRunner, fixture, configDir) {
  const now = '2026-09-15 12:00:00.000';
  const roomExtraColumns = fixture.level >= 3 ? ', "moderators", "voiceMuted"' : '';
  const roomExtraValues = fixture.level >= 3 ? `, '[12]', '[13]'` : '';
  await queryRunner.query(`INSERT INTO "user" ("id", "username", "passwordHash", "role", "status", "avatar", "tokenInvalidBefore", "createdAt", "updatedAt") VALUES (11, '历史用户', 'bcrypt-hash-preserved', 'root', 'active', '/uploads/avatars/11.png', '2026-09-01 00:00:00.000', ?, ?)`, [now, now]);
  await queryRunner.query(`INSERT INTO "room" ("id", "roomId", "name", "password", "maxViewers", "status", "mode", "shareMethod", "streamKey", "requireApproval", "ownerUserId", "mutedViewers", "approvedViewers"${roomExtraColumns}, "createdAt", "updatedAt", "lastAccessedAt") VALUES (21, '历史 房间 α', 'Golden Room', 'room-pass', 8, 'active', 'watch-together', 'webrtc', 'stream-key', 1, 11, '[13]', '[12]'${roomExtraValues}, ?, ?, ?)`, [now, now, now]);
  await queryRunner.query(`INSERT INTO "session" ("id", "roomId", "socketId", "role", "userId", "startedAt", "endedAt") VALUES (31, '历史 房间 α', 'socket-history', 'sharer', 11, ?, NULL)`, [now]);
  const movieColumns = fixture.level >= 1 ? ', "sourceInput", "mediaDescriptor"' : '';
  const movieValues = fixture.level >= 1 ? `, 'provider://anime/legacy', '{"protocol":"hls","quality":"original"}'` : '';
  await queryRunner.query(`INSERT INTO "movie" ("id", "roomId", "url", "title", "cover", "source"${movieColumns}, "sourceMeta", "password", "directLink", "wasmEngine", "playsvideoEnabled", "order", "createdAt", "updatedAt") VALUES (41, '历史 房间 α', 'https://media.example/legacy.m3u8', 'Legacy Movie', 'https://img.example/cover.jpg', 'anime'${movieValues}, '{"sourceId":"legacy-anime","episode":1}', 'legacy-movie-ciphertext', 0, 0, 1, 7, ?, ?)`, [now, now]);
  const mounts = [
    [51, 'webdav', 'WebDAV', 'webdav-password', null],
    [52, 'ftp', 'FTP', 'ftp-password', null],
    [53, 'openlist', 'OpenList', 'openlist-password', null],
    [54, 'emby', 'Emby', 'emby-password', 'emby-api-key'],
    [55, 'jellyfin', 'Jellyfin', 'jellyfin-password', 'jellyfin-api-key'],
  ];
  for (const [id, type, name, password, apiKey] of mounts) {
    await queryRunner.query(`INSERT INTO "user_mount" ("id", "userId", "type", "name", "serverUrl", "port", "path", "username", "password", "indexUrl", "apiKey", "embyUserId", "directLink", "httpsDirect", "createdAt", "updatedAt") VALUES (?, 11, ?, ?, 'https://provider.example', 443, '/媒体', 'provider-user', ?, NULL, ?, 'provider-user-id', 1, 1, ?, ?)`, [id, type, name, password, apiKey, now, now]);
  }
  await queryRunner.query(`INSERT INTO "bilibili_credential" ("id", "userId", "cookie", "refreshToken", "createdAt", "updatedAt") VALUES (61, '11', ?, ?, ?, ?)`, [Buffer.from('SESSDATA=legacy-secret; bili_jct=csrf', 'utf8').toString('base64'), Buffer.from('legacy-refresh-token', 'utf8').toString('base64'), now, now]);

  const settingsMediaColumn = fixture.level >= 2 ? ', "mediaPolicyVersion"' : '';
  const settingsMediaValue = fixture.level >= 2 ? ', 3' : '';
  await queryRunner.query(`INSERT INTO "system_settings" ("id", "autoDeleteInactiveRooms", "autoDeleteAfterHours", "dataSourceConfig", "registrationMode", "roomCreationMode", "betaFeaturesEnabled", "dashDisabled"${settingsMediaColumn}, "cdnAccelerate", "embeddedSubtitleEnabled", "playsvideoEnabled", "cdnProxyUrl", "createdAt", "updatedAt") VALUES (71, 0, 72, '{"anime":"persisted"}', 'open', 'all-users', 1, 1${settingsMediaValue}, 1, 1, 1, 'https://proxy.example', ?, ?)`, [now, now]);

  const playbackExtraColumns = fixture.level >= 4 ? ', "version", "sourceGeneration"' : '';
  const playbackExtraValues = fixture.level >= 4 ? ', 9, 4' : '';
  await queryRunner.query(`INSERT INTO "playback_states" ("roomId", "sourceUrl", "sourceType", "currentTime", "lastUpdatedAt"${playbackExtraColumns}, "hostSocketId", "createdAt", "updatedAt") VALUES ('历史 房间 α', 'https://media.example/legacy.m3u8', 'hls', 123.5, 1789473600000${playbackExtraValues}, 'socket-history', ?, ?)`, [now, now]);
  await queryRunner.query(`INSERT INTO "comment" ("id", "roomId", "username", "content", "isDanmaku", "createdAt") VALUES (81, '历史 房间 α', '历史用户', 'preserved comment', 1, ?)`, [now]);

  if (fixture.level >= 5) {
    await queryRunner.query(`INSERT INTO "music_queue_items" ("queueItemId", "roomId", "sourceRef", "title", "artist", "album", "artworkUrl", "durationMs", "orderIndex", "createdByUserId", "metadataJson", "createdAt") VALUES (91, '历史 房间 α', 'music://fixture/golden-a', 'Golden A', 'Artist', 'Album', NULL, 180000, 0, 11, '{"quality":"lossless"}', ?), (92, '历史 房间 α', 'music://fixture/golden-b', 'Golden B', 'Artist', 'Album', NULL, 200000, 1, 11, '{}', ?)`, [now, now]);
    await queryRunner.query(`INSERT INTO "music_room_states" ("roomId", "playMode", "currentQueueItemId", "shuffleSeed", "shuffleOrderJson", "shuffleHistoryJson", "shuffleCursor", "version", "musicGeneration", "updatedAt") VALUES ('历史 房间 α', 'shuffle', 92, 'seed-历史', '[92,91]', '[91]', 1, 14, 6, ?)`, [now]);
  }
  if (fixture.level >= 6) {
    const vault = new SecretVault({ configDir });
    const envelope = vault.encrypt(JSON.stringify({ version: 1, cookieHeader: 'MUSIC_U=ncm-secret', csrfToken: 'csrf' }));
    await queryRunner.query(`INSERT INTO "ncm_credentials" ("id", "userId", "provider", "credentialEnvelope", "credentialVersion", "status", "accountId", "displayName", "avatarUrl", "lastValidatedAt", "createdAt", "updatedAt") VALUES (101, 11, 'ncm', ?, 7, 'logged-in', 'ncm-account', 'NCM User', 'https://img.example/ncm.jpg', ?, ?, ?)`, [envelope, now, now, now]);
  }
}

async function buildHistoricalFixture({ fixtureId, databasePath, configDir }) {
  const fixture = HISTORICAL_FIXTURES.find((item) => item.id === fixtureId);
  if (!fixture) throw new Error(`Unknown historical fixture: ${fixtureId}`);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  const dataSource = new DataSource({
    type: 'sqljs',
    driver: await sharedSqlJs,
    autoSave: false,
    synchronize: false,
    entities: [],
  });
  await dataSource.initialize();
  const runner = dataSource.createQueryRunner();
  try {
    await runner.startTransaction();
    await apply(runner, new CreateHistoricalBaseline1790000000000());
    if (fixture.level >= 1) await addMediaColumns(runner);
    if (fixture.level >= 2) await apply(runner, new CompletePhase1Schema1790100000000());
    if (fixture.level >= 3) await addVoiceColumns(runner);
    if (fixture.level >= 4) await apply(runner, new AddRealtimePersistence1790200000000());
    if (fixture.level >= 5) await apply(runner, new AddMusicPersistence1790300000000());
    if (fixture.level >= 6) await apply(runner, new AddNcmCredential1790400000000());
    await insertRepresentativeData(runner, fixture, configDir);
    await runner.commitTransaction();
    fs.writeFileSync(databasePath, Buffer.from(dataSource.driver.export()));
  } catch (error) {
    if (runner.isTransactionActive) await runner.rollbackTransaction();
    throw error;
  } finally {
    await runner.release();
    await dataSource.destroy();
  }
  return fixture;
}

module.exports = { HISTORICAL_FIXTURES, buildHistoricalFixture };
