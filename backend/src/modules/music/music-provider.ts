/**
 * Provider boundary for future music integrations.
 * Phase 5B-1 intentionally ships only a local fixture resolver.  A provider
 * may resolve an opaque sourceRef for an authorized client, but credentials,
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
