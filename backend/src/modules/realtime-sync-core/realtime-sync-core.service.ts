import type {
  DomainMutationEnvelope,
  DomainMutationGuardResult,
  MutationEnvelope,
  MutationGuardResult,
  RealtimeDomain,
  RealtimeVersion,
} from './types';
import { metrics } from '../../observability';

type RejectionCode = 'DUPLICATE' | 'STALE_VERSION' | 'STALE_GENERATION' | 'INVALID_TIMESTAMP';

function rejected(code: RejectionCode, message: string): { ok: false; code: RejectionCode; message: string } {
  metrics.increment('realtime_rejected_total', {
    reason: code === 'INVALID_TIMESTAMP' || code === 'DUPLICATE' ? 'invalid' : 'stale',
  });
  return { ok: false, code, message };
}
import {
  MAX_CLIENT_CLOCK_SKEW_MS,
  MAX_MUTATION_ID_LENGTH,
  compareRealtimeVersion,
  isValidVersion,
  validateClientTimestamp,
} from './types';

interface RoomClock {
  version: RealtimeVersion;
  generation: number;
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
  /** Music has an independent clock so it can never advance video ordering. */
  private readonly musicRooms = new Map<string, RoomClock>();
  private readonly roomLocks = new Map<string, Promise<void>>();

  private getRoom(roomId: string): RoomClock {
    let clock = this.rooms.get(roomId);
    if (!clock) {
      clock = {
        version: 0,
        generation: 0,
        serverTimestamp: Date.now(),
        seenMutations: new Map(),
        readiness: new Map(),
      };
      this.rooms.set(roomId, clock);
    }
    return clock;
  }

  private getMusicRoom(roomId: string): RoomClock {
    let clock = this.musicRooms.get(roomId);
    if (!clock) {
      clock = {
        version: 0,
        generation: 0,
        serverTimestamp: Date.now(),
        seenMutations: new Map(),
        readiness: new Map(),
      };
      this.musicRooms.set(roomId, clock);
    }
    return clock;
  }

  /** Hydrate ordering metadata from a domain snapshot after process restart. */
  hydrate(roomId: string, version: number | undefined, sourceGeneration: number | undefined, serverTimestamp?: number): void {
    const clock = this.getRoom(roomId);
    if (isValidVersion(version) && version > clock.version) clock.version = version;
    if (isValidVersion(sourceGeneration) && sourceGeneration > clock.generation) {
      clock.generation = sourceGeneration;
    }
    if (typeof serverTimestamp === 'number' && Number.isFinite(serverTimestamp)) {
      clock.serverTimestamp = Math.max(clock.serverTimestamp, serverTimestamp);
    }
  }

  current(roomId: string): { version: number; sourceGeneration: number; serverTimestamp: number } {
    const clock = this.getRoom(roomId);
    return {
      version: clock.version,
      sourceGeneration: clock.generation,
      serverTimestamp: clock.serverTimestamp,
    };
  }

  guardMutation(roomId: string, envelope: MutationEnvelope, now = Date.now()): MutationGuardResult {
    const clock = this.getRoom(roomId);
    if (!validateClientTimestamp(envelope.clientTimestamp, now)) {
      return rejected('INVALID_TIMESTAMP', '客户端时间戳超出允许范围');
    }
    if (envelope.mutationId !== undefined &&
      (typeof envelope.mutationId !== 'string' || envelope.mutationId.length === 0 || envelope.mutationId.length > MAX_MUTATION_ID_LENGTH)) {
      return rejected('DUPLICATE', 'mutationId 无效');
    }
    if (envelope.mutationId && clock.seenMutations.has(envelope.mutationId)) {
      return rejected('DUPLICATE', '重复 mutation 已忽略');
    }

    const incomingGeneration = envelope.sourceGeneration ?? clock.generation;
    if (!isValidVersion(incomingGeneration)) {
      return rejected('STALE_GENERATION', 'sourceGeneration 无效');
    }
    if (incomingGeneration < clock.generation) {
      return rejected('STALE_GENERATION', '旧 sourceGeneration 已失效');
    }
    if (envelope.baseVersion !== undefined &&
      (!isValidVersion(envelope.baseVersion) || envelope.baseVersion !== clock.version)) {
      return rejected('STALE_VERSION', '基于旧 version 的 mutation 已失效');
    }
    return { ok: true, version: clock.version + 1, sourceGeneration: incomingGeneration, serverTimestamp: now };
  }

  commit(roomId: string, envelope: MutationEnvelope, now = Date.now()): MutationGuardResult {
    const guard = this.guardMutation(roomId, envelope, now);
    if (!guard.ok) return guard;
    const clock = this.getRoom(roomId);
    clock.version = guard.version;
    clock.generation = guard.sourceGeneration;
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

  /** Read a domain-specific clock without exposing domain state. */
  currentDomain(
    roomId: string,
    domain: RealtimeDomain = 'music',
  ): { version: number; generation: number; serverTimestamp: number } {
    const clock = domain === 'music' ? this.getMusicRoom(roomId) : this.getRoom(roomId);
    return {
      version: clock.version,
      generation: clock.generation,
      serverTimestamp: clock.serverTimestamp,
    };
  }

  /** Hydrate only the selected domain's ordering metadata after a restart. */
  hydrateDomain(
    roomId: string,
    version: number | undefined,
    generation: number | undefined,
    serverTimestamp?: number,
    domain: RealtimeDomain = 'music',
  ): void {
    const clock = domain === 'music' ? this.getMusicRoom(roomId) : this.getRoom(roomId);
    if (isValidVersion(version) && version > clock.version) clock.version = version;
    if (isValidVersion(generation) && generation > clock.generation) {
      clock.generation = generation;
    }
    if (typeof serverTimestamp === 'number' && Number.isFinite(serverTimestamp)) {
      clock.serverTimestamp = Math.max(clock.serverTimestamp, serverTimestamp);
    }
  }

  guardDomainMutation(
    roomId: string,
    envelope: DomainMutationEnvelope,
    now = Date.now(),
    domain: RealtimeDomain = 'music',
  ): DomainMutationGuardResult {
    const clock = domain === 'music' ? this.getMusicRoom(roomId) : this.getRoom(roomId);
    if (!validateClientTimestamp(envelope.clientTimestamp, now)) {
      return rejected('INVALID_TIMESTAMP', '客户端时间戳超出允许范围');
    }
    if (envelope.mutationId !== undefined &&
      (typeof envelope.mutationId !== 'string' || envelope.mutationId.length === 0 || envelope.mutationId.length > MAX_MUTATION_ID_LENGTH)) {
      return rejected('DUPLICATE', 'mutationId 无效');
    }
    if (envelope.mutationId && clock.seenMutations.has(envelope.mutationId)) {
      return rejected('DUPLICATE', '重复 mutation 已忽略');
    }

    const incomingGeneration = envelope.generation ?? clock.generation;
    if (!isValidVersion(incomingGeneration)) {
      return rejected('STALE_GENERATION', 'generation 无效');
    }
    if (incomingGeneration < clock.generation) {
      return rejected('STALE_GENERATION', '旧 generation 已失效');
    }
    if (envelope.baseVersion !== undefined &&
      (!isValidVersion(envelope.baseVersion) || envelope.baseVersion !== clock.version)) {
      return rejected('STALE_VERSION', '基于旧 version 的 mutation 已失效');
    }
    return { ok: true, version: clock.version + 1, generation: incomingGeneration, serverTimestamp: now };
  }

  commitDomain(
    roomId: string,
    envelope: DomainMutationEnvelope,
    now = Date.now(),
    domain: RealtimeDomain = 'music',
  ): DomainMutationGuardResult {
    const guard = this.guardDomainMutation(roomId, envelope, now, domain);
    if (!guard.ok) return guard;
    const clock = domain === 'music' ? this.getMusicRoom(roomId) : this.getRoom(roomId);
    clock.version = guard.version;
    clock.generation = guard.generation;
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
    if (sourceGeneration !== clock.generation) return false;
    clock.readiness.set(socketId, sourceGeneration);
    return true;
  }

  clearSocket(socketId: string): void {
    for (const clock of this.rooms.values()) clock.readiness.delete(socketId);
    for (const clock of this.musicRooms.values()) clock.readiness.delete(socketId);
  }

  clearRoom(roomId: string): void {
    this.rooms.delete(roomId);
    this.musicRooms.delete(roomId);
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
