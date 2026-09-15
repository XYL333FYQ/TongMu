import type { UserRole } from '../../entities/User';

export type RealtimeVersion = number;

export interface RealtimeSessionIdentity {
  roomId: string;
  sessionId: string;
  socketId: string;
  userId: number | null;
  role: UserRole;
}

export interface RealtimeHostFacts {
  socketId: string | null;
  userId: number | null;
  online: boolean;
}

export interface AuthoritativeSnapshot<TDomainState> {
  roomId: string;
  session: RealtimeSessionIdentity;
  version: RealtimeVersion;
  sourceGeneration: number;
  serverTimestamp: number;
  domain: TDomainState;
  host: RealtimeHostFacts;
}

export interface MutationEnvelope {
  baseVersion?: number;
  sourceGeneration?: number;
  mutationId?: string;
  clientTimestamp?: number;
}

export type MutationGuardResult =
  | { ok: true; version: number; sourceGeneration: number; serverTimestamp: number }
  | { ok: false; code: 'DUPLICATE' | 'STALE_VERSION' | 'STALE_GENERATION' | 'INVALID_TIMESTAMP'; message: string };

export const MAX_ROOM_ID_LENGTH = 128;
export const MAX_SOCKET_ID_LENGTH = 256;
export const MAX_MUTATION_ID_LENGTH = 128;
export const MAX_CLIENT_CLOCK_SKEW_MS = 5 * 60 * 1000;

export function isBoundedIdentifier(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

export function isValidVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function validateClientTimestamp(value: unknown, now = Date.now()): boolean {
  if (value === undefined) return true;
  return typeof value === 'number' && Number.isFinite(value) &&
    Math.abs(now - value) <= MAX_CLIENT_CLOCK_SKEW_MS;
}

export function compareRealtimeVersion(
  currentGeneration: number,
  currentVersion: number,
  incomingGeneration: number,
  incomingVersion: number,
): -1 | 0 | 1 {
  if (incomingGeneration < currentGeneration) return -1;
  if (incomingGeneration > currentGeneration) return 1;
  if (incomingVersion < currentVersion) return -1;
  if (incomingVersion > currentVersion) return 1;
  return 0;
}
