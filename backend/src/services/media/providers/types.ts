import { fetchWithProxyPolicy } from '../../proxy/safe-fetch';
import type { PlaybackClientProfileV1 } from '../playback-profile';
import type { PrivateMediaSource, PlaybackCandidate } from '../protocol';
import type { MediaDescriptor } from '../types';
import type { MediaServerSessionBinding } from './media-server-types';

export type ProviderActorKind = 'user' | 'guest' | 'system';
export type ProviderCredentialOwner = 'current-viewer' | 'room-owner' | 'source-creator' | 'system' | 'none';
export type ProviderCredentialRequirement = 'required' | 'optional';

export interface ProviderCredentialDependency {
  providerId: string;
  owner: ProviderCredentialOwner;
  requirement: ProviderCredentialRequirement;
  scope?: string;
}

/** Public/provider-generic execution facts. No credential value belongs here. */
export interface ProviderContext {
  actor: { kind: ProviderActorKind; userId?: string };
  userId?: string;
  roomId?: string;
  movieId?: number;
  sourceGeneration?: number;
  /** Credential owner resolved by the caller; never infer it from provider JSON. */
  credentialOwnerId?: string;
  /** Quality-changing provider transcode is opt-in and disabled by default. */
  qualityChangingTranscode?: 'disabled' | 'explicit';
  signal: AbortSignal;
  deadline: number;
  profile: PlaybackClientProfileV1;
  requestedQn?: number;
  preferMp4?: boolean;
  page?: number;
  cid?: number;
  credentialOwnerPolicy: ProviderCredentialOwner;
  safeFetch: typeof fetchWithProxyPolicy;
}

/** Server-private provider material, kept separate from ProviderContext/DTOs. */
export interface ProviderPrivateContext {
  providerCookie?: string;
  providerToken?: string;
  headers?: Record<string, string>;
}

export interface ProviderResolution {
  privateSource: PrivateMediaSource;
  descriptor: MediaDescriptor;
  candidates: PlaybackCandidate[];
  /** Stable credential-free identity after a provider selects a media source. */
  sourceReference?: string;
  /** Server-private session identity; never serialize this field. */
  session?: MediaServerSessionBinding;
}

export interface ProviderAvailability {
  available: boolean;
  reason?: 'disabled' | 'not-configured' | 'temporarily-unavailable';
}

export interface MediaProvider {
  readonly id: string;
  readonly sourceKinds: readonly string[];
  canHandle(input: string): boolean;
  validateInput(context: ProviderContext, input: string): Promise<void> | void;
  normalizeInput(input: string): string;
  resolve(context: ProviderContext, input: string, privateContext: ProviderPrivateContext): Promise<ProviderResolution>;
  credentialDependencies(context: ProviderContext, input: string): ProviderCredentialDependency[];
  availability(context: ProviderContext): Promise<ProviderAvailability> | ProviderAvailability;
  refresh?(context: ProviderContext, source: ProviderResolution): Promise<ProviderResolution>;
  cleanup?(context: ProviderContext, sourceGeneration: number): Promise<void>;
  playbackSession?: ProviderPlaybackSessionLifecycle;
}

export interface ProviderPlaybackSessionLifecycle {
  start(context: ProviderContext, session: MediaServerSessionBinding): Promise<void>;
  progress(context: ProviderContext, session: MediaServerSessionBinding, position: number, paused: boolean): Promise<void>;
  stop(context: ProviderContext, session: MediaServerSessionBinding, position: number): Promise<void>;
  cleanup(context: ProviderContext, session: MediaServerSessionBinding): Promise<void>;
}

export function assertProviderActive(context: Pick<ProviderContext, 'signal' | 'deadline'>): void {
  if (context.signal.aborted) throw new Error('provider resolution cancelled');
  if (Date.now() >= context.deadline) throw new Error('provider resolution deadline exceeded');
}

export function providerActorForUser(userId?: string): ProviderContext['actor'] {
  if (userId) return { kind: 'user', userId };
  return { kind: 'guest' };
}

export type ProviderSafeFetch = typeof fetchWithProxyPolicy;
