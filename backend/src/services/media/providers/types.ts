import { fetchWithProxyPolicy } from '../../proxy/safe-fetch';
import type { PlaybackClientProfileV1 } from '../playback-profile';
import type { PrivateMediaSource, PlaybackCandidate } from '../protocol';
import type { MediaDescriptor } from '../types';

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
  signal: AbortSignal;
  deadline: number;
  profile: PlaybackClientProfileV1;
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
