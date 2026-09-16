/**
 * Provider boundary for future music integrations.
 * The fixture and credentialed provider paths resolve opaque sourceRefs for
 * authorized clients, but credentials,
 * cookies, Authorization headers, and raw stream URLs never enter queue DTOs.
 */
export interface MusicProviderContext {
  roomId: string;
  userId: number | null;
}

export interface ResolvedMusicSource {
  url: string;
  contentType?: string;
  durationMs?: number;
}

export interface MusicProvider {
  readonly name: string;
  canResolve(sourceRef: string): boolean;
  resolve(context: MusicProviderContext, sourceRef: string): Promise<ResolvedMusicSource>;
}

export const MUSIC_QUALITY_VALUES = [
  'standard',
  'higher',
  'exhigh',
  'lossless',
  'hires',
  'jyeffect',
  'sky',
  'dolby',
] as const;

export type MusicQuality = typeof MUSIC_QUALITY_VALUES[number];

export type MusicCodec = 'mp3' | 'aac' | 'flac' | 'wav' | 'unknown';

export function isMusicQuality(value: unknown): value is MusicQuality {
  return typeof value === 'string' &&
    (MUSIC_QUALITY_VALUES as readonly string[]).includes(value);
}

export interface CredentialedMusicProviderContext {
  roomId: string;
  userId: number | null;
  credentialOwnerId: number;
  requestedQuality: MusicQuality;
  signal?: AbortSignal;
}

/** Private source data exists only during a server-side provider operation. */
export interface MusicPrivateSource {
  provider: string;
  trackId: string;
  stableRef: string;
  credentialOwnerId: number;
  url: string;
  headers?: Record<string, string>;
  requestedQuality: MusicQuality;
  actualQuality: MusicQuality;
  availableQualities: MusicQuality[];
  availableMaximum: MusicQuality;
  expiresAt: number;
  contentType: string;
  codec: MusicCodec;
}

/** Public descriptor deliberately excludes URL, headers and credential data. */
export interface MusicPublicDescriptor {
  provider: string;
  trackId: string;
  sourceRef: string;
  title: string | null;
  artist: string | null;
  album: string | null;
  durationMs: number | null;
  codec: MusicCodec;
  container: string;
  mimeType: string;
  requestedQuality: MusicQuality;
  actualQuality: MusicQuality | null;
  availableMaximum: MusicQuality | null;
  availableQualities: MusicQuality[];
  availability: 'available' | 'quality-unavailable';
  expiresAt: number | null;
}

export interface CredentialedMusicProviderResolution {
  privateSource: MusicPrivateSource;
  descriptor: MusicPublicDescriptor;
}

export interface CredentialedMusicProvider {
  readonly providerId: string;
  canResolve(sourceRef: string): boolean;
  resolve(
    context: CredentialedMusicProviderContext,
    sourceRef: string,
  ): Promise<CredentialedMusicProviderResolution>;
}

/** Registry boundary used by routes; providers are never selected from URLs. */
export class CredentialedMusicProviderRegistry {
  private readonly providers = new Map<string, CredentialedMusicProvider>();

  register(provider: CredentialedMusicProvider): void {
    this.providers.set(provider.providerId, provider);
  }

  get(providerId: string): CredentialedMusicProvider | undefined {
    return this.providers.get(providerId);
  }

  findFor(sourceRef: string): CredentialedMusicProvider | undefined {
    for (const provider of this.providers.values()) {
      if (provider.canResolve(sourceRef)) return provider;
    }
    return undefined;
  }
}

export class FixtureMusicProvider implements MusicProvider {
  readonly name = 'fixture';

  canResolve(sourceRef: string): boolean {
    return /^music:\/\/fixture\/[a-zA-Z0-9_-]{1,64}$/.test(sourceRef);
  }

  async resolve(_context: MusicProviderContext, sourceRef: string): Promise<ResolvedMusicSource> {
    if (!this.canResolve(sourceRef)) throw new Error('fixture sourceRef 无效');
    const id = sourceRef.slice('music://fixture/'.length);
    return {
      url: `/api/music/fixture/${encodeURIComponent(id)}`,
      contentType: 'audio/wav',
      durationMs: 4_000,
    };
  }
}

export const fixtureMusicProvider = new FixtureMusicProvider();
