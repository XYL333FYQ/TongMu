export {
  MusicSyncError,
  MusicSyncService,
  musicSyncService,
  type MusicActor,
  type MusicPendingControlRequest,
  type MusicTrackAckRecord,
} from './music-sync.service';
export { MusicSyncHandler } from './music-sync.handler';
export { createMusicFixtureRouter } from './music-fixture.routes';
export {
  FixtureMusicProvider,
  fixtureMusicProvider,
  type MusicProvider,
  type MusicProviderContext,
  type ResolvedMusicSource,
} from './music-provider';
export * from './music-sync.domain';
export * from './types';
