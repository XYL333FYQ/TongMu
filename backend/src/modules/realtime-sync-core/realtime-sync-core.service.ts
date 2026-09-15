import type {
  MutationEnvelope,
  MutationGuardResult,
  RealtimeVersion,
} from './types';
import {
  MAX_CLIENT_CLOCK_SKEW_MS,
  MAX_MUTATION_ID_LENGTH,
  compareRealtimeVersion,
  isValidVersion,
  validateClientTimestamp,
} from './types';

interface RoomClock {
  version: RealtimeVersion;
  sourceGeneration: number;
  serverTimestamp: number;
  seenMutations: Map<string, number>;
  readiness: Map<string, number>;
}

/**
 * Shared ordering/identity primitive. It deliberately does not store video or
 * music domain state; domains provide state to snapshots and persist it in
 * their own storage.
 */
export class RealtimeSyncCore {
  private readonly rooms = new Map<string, RoomClock>();
  private readonly roomLocks = new Map<string, Promise<void>>();

  private getRoom(roomId: string): RoomClock {
    let clock = this.rooms.get(roomId);
    if (!clock) {
      clock = {
        version: 0,
        sourceGeneration: 0,
        serverTimestamp: Date.now(),
        seenMutations: new Map(),
        readiness: new Map(),
      };
      this.rooms.set(roomId, clock);
    }
    return clock;
  }

  /** Hydrate ordering metadata from a domain snapshot after process restart. */
  hydrate(roomId: string, version: number | undefined, sourceGeneration: number | undefined, serverTimestamp?: number): void {
    const clock = this.getRoom(roomId);
    if (isValidVersion(version) && version > clock.version) clock.version = version;
    if (isValidVersion(sourceGeneration) && sourceGeneration > clock.sourceGeneration) {
      clock.sourceGeneration = sourceGeneration;
    }
    if (typeof serverTimestamp === 'number' && Number.isFinite(serverTimestamp)) {
      clock.serverTimestamp = Math.max(clock.serverTimestamp, serverTimestamp);
    }
  }

  current(roomId: string): { version: number; sourceGeneration: number; serverTimestamp: number } {
    const clock = this.getRoom(roomId);
    return {
      version: clock.version,
      sourceGeneration: clock.sourceGeneration,
      serverTimestamp: clock.serverTimestamp,
    };
  }

  guardMutation(roomId: string, envelope: MutationEnvelope, now = Date.now()): MutationGuardResult {
    const clock = this.getRoom(roomId);
    if (!validateClientTimestamp(envelope.clientTimestamp, now)) {
      return { ok: false, code: 'INVALID_TIMESTAMP', message: '客户端时间戳超出允许范围' };
    }
    if (envelope.mutationId !== undefined &&
      (typeof envelope.mutationId !== 'string' || envelope.mutationId.length === 0 || envelope.mutationId.length > MAX_MUTATION_ID_LENGTH)) {
      return { ok: false, code: 'DUPLICATE', message: 'mutationId 无效' };
    }
    if (envelope.mutationId && clock.seenMutations.has(envelope.mutationId)) {
      return { ok: false, code: 'DUPLICATE', message: '重复 mutation 已忽略' };
    }

    const incomingGeneration = envelope.sourceGeneration ?? clock.sourceGeneration;
    if (!isValidVersion(incomingGeneration)) {
      return { ok: false, code: 'STALE_GENERATION', message: 'sourceGeneration 无效' };
    }
    if (incomingGeneration < clock.sourceGeneration) {
      return { ok: false, code: 'STALE_GENERATION', message: '旧 sourceGeneration 已失效' };
    }
    if (envelope.baseVersion !== undefined &&
      (!isValidVersion(envelope.baseVersion) || envelope.baseVersion !== clock.version)) {
      return { ok: false, code: 'STALE_VERSION', message: '基于旧 version 的 mutation 已失效' };
    }
    return { ok: true, version: clock.version + 1, sourceGeneration: incomingGeneration, serverTimestamp: now };
  }

  commit(roomId: string, envelope: MutationEnvelope, now = Date.now()): MutationGuardResult {
    const guard = this.guardMutation(roomId, envelope, now);
    if (!guard.ok) return guard;
    const clock = this.getRoom(roomId);
    clock.version = guard.version;
    clock.sourceGeneration = guard.sourceGeneration;
    clock.serverTimestamp = guard.serverTimestamp;
    if (envelope.mutationId) {
      clock.seenMutations.set(envelope.mutationId, now);
      if (clock.seenMutations.size > 512) {
        const cutoff = now - MAX_CLIENT_CLOCK_SKEW_MS * 2;
        for (const [id, timestamp] of clock.seenMutations) {
          if (timestamp < cutoff || clock.seenMutations.size > 512) clock.seenMutations.delete(id);
        }
      }
    }
    return guard;
  }

  shouldApplyEvent(currentGeneration: number | undefined, currentVersion: number | undefined, incomingGeneration: number | undefined, incomingVersion: number | undefined): boolean {
    if (incomingGeneration === undefined || incomingVersion === undefined) return true;
    if (currentGeneration === undefined || currentVersion === undefined) return true;
    return compareRealtimeVersion(currentGeneration, currentVersion, incomingGeneration, incomingVersion) > 0;
  }

  recordReadiness(roomId: string, socketId: string, sourceGeneration: number): boolean {
    const clock = this.getRoom(roomId);
    if (sourceGeneration !== clock.sourceGeneration) return false;
    clock.readiness.set(socketId, sourceGeneration);
    return true;
  }

  clearSocket(socketId: string): void {
    for (const clock of this.rooms.values()) clock.readiness.delete(socketId);
  }

  clearRoom(roomId: string): void {
    this.rooms.delete(roomId);
    this.roomLocks.delete(roomId);
  }

  /** Serialize single-node room mutations without introducing Redis/cluster semantics. */
  async withRoomLock<T>(roomId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.roomLocks.get(roomId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.roomLocks.set(roomId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.roomLocks.get(roomId) === queued) this.roomLocks.delete(roomId);
    }
  }
}

export const realtimeSyncCore = new RealtimeSyncCore();
