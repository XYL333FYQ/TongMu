import 'reflect-metadata';
import fs from 'node:fs';
import { DataSource } from 'typeorm';
import { Room } from './entities/Room';
import { Session } from './entities/Session';
import { User } from './entities/User';
import { Comment } from './entities/Comment';
import { BilibiliCredential } from './entities/BilibiliCredential';
import { Movie } from './entities/Movie';
import { UserMount } from './entities/UserMount';
import { SystemSettings } from './entities/SystemSettings';
import { PlaybackState } from './entities/PlaybackState';
import { ServerFolder } from './entities/ServerFolder';
import { DanmakuTrack } from './entities/DanmakuTrack';
import { RoomDanmakuMeta } from './entities/RoomDanmakuMeta';
import { AuditLog } from './entities/AuditLog';
import { MusicQueueItem } from './entities/MusicQueueItem';
import { MusicRoomState } from './entities/MusicRoomState';
import { NcmCredential } from './entities/NcmCredential';
import { DATABASE_PATH } from './services/paths';
import { AddMediaCoreMetadata1789160000000 } from './migrations/1789160000000-AddMediaCoreMetadata';
import { CreateHistoricalBaseline1790000000000 } from './migrations/1790000000000-CreateHistoricalBaseline';
import { CompletePhase1Schema1790100000000 } from './migrations/1790100000000-CompletePhase1Schema';
import { AddRealtimePersistence1790200000000 } from './migrations/1790200000000-AddRealtimePersistence';
import { AddMusicPersistence1790300000000 } from './migrations/1790300000000-AddMusicPersistence';
import { AddNcmCredential1790400000000 } from './migrations/1790400000000-AddNcmCredential';
import { EncryptLegacyCredentials1790500000000 } from './migrations/1790500000000-EncryptLegacyCredentials';

function persistSqlJsDatabase(database: Uint8Array): void {
  // sql.js invokes this after each committed write. Keep the callback
  // synchronous: it is already serialized by TypeORM, and avoiding an extra
  // fs.promises async-hook lifecycle prevents a Node/Windows teardown crash.
  fs.writeFileSync(DATABASE_PATH, Buffer.from(database));
  // sql.js export resets connection-local PRAGMAs. Restore FK enforcement
  // immediately after every auto-save so subsequent application writes never
  // run with foreign_keys disabled.
  const driver = AppDataSource.driver as typeof AppDataSource.driver & {
    databaseConnection?: { exec(sql: string): unknown };
  };
  driver.databaseConnection?.exec('PRAGMA foreign_keys = ON');
}

export const AppDataSource = new DataSource({
  // sql.js（wasm）驱动：纯 JS 实现，无原生模块，单文件版可在任意平台运行
  type: 'sqljs',
  // 数据库文件统一存放在 config/ 目录下，便于升级时整体保留。
  // 路径解析详见 services/paths.ts（支持 DATABASE_URL 环境变量覆盖）。
  location: DATABASE_PATH,
  // 变更后自动保存到文件（Node 环境使用文件系统持久化，而非浏览器 IndexedDB）
  autoSave: true,
  autoSaveCallback: persistSqlJsDatabase,
  useLocalForage: false,
  synchronize: false,
  // Startup performs inspection, backup, migration, and verification before
  // HTTP/Socket.IO is created. Never let DataSource mutate schema implicitly.
  migrationsRun: false,
  logging: process.env.NODE_ENV === 'development',
  entities: [Room, Session, User, Comment, BilibiliCredential, NcmCredential, Movie, UserMount, SystemSettings, PlaybackState, ServerFolder, DanmakuTrack, RoomDanmakuMeta, AuditLog, MusicQueueItem, MusicRoomState],
  migrations: [
    AddMediaCoreMetadata1789160000000,
    CreateHistoricalBaseline1790000000000,
    CompletePhase1Schema1790100000000,
    AddRealtimePersistence1790200000000,
    AddMusicPersistence1790300000000,
    AddNcmCredential1790400000000,
    EncryptLegacyCredentials1790500000000,
  ],
  subscribers: [],
});
