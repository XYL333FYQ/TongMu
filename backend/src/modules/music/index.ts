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
export { createMusicRouter } from './music.routes';
export {
  NcmMusicProvider,
  ncmMusicProvider,
  credentialedMusicProviderRegistry,
  ncmTrackIdFromRef,
  ncmTrackRef,
  validateNcmAudioUrl,
} from './ncm/ncm-provider';
export { NcmCredentialService, ncmCredentialService } from './ncm/ncm-credential.service';
export { NcmLoginService, ncmLoginService } from './ncm/ncm-login.service';
export { NcmApiClient, ncmApiClient, stopNcmApiService } from './ncm/ncm-client';
export {
  MusicPlaybackService,
  musicPlaybackService,
  type MusicResolveRequest,
} from './ncm/music-playback.service';
export * from './ncm/types';
export {
  FixtureMusicProvider,
  fixtureMusicProvider,
  type MusicProvider,
  type MusicProviderContext,
  type ResolvedMusicSource,
  type CredentialedMusicProvider,
  type CredentialedMusicProviderContext,
  type CredentialedMusicProviderResolution,
  type MusicCodec,
  type MusicPrivateSource,
  type MusicPublicDescriptor,
  type MusicQuality,
} from './music-provider';
export * from './music-sync.domain';
export * from './types';
