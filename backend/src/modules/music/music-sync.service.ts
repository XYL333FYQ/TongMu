import { randomUUID } from 'node:crypto';
import { IsNull, type DataSource, type EntityManager } from 'typeorm';
import { AppDataSource } from '../../data-source';
import { MusicQueueItem } from '../../entities/MusicQueueItem';
import { MusicRoomState } from '../../entities/MusicRoomState';
import { Session } from '../../entities/Session';
import type { UserRole } from '../../entities/User';
import {
  realtimeSyncCore,
  type DomainMutationGuardResult,
  type RealtimeSyncCore,
} from '../realtime-sync-core';
import {
  advanceMusicPosition,
  clampMusicPosition,
  createStableShuffleOrder,
  isMusicPlayMode,
  normalizeShuffleOrder,
  selectAdjacentQueueItemId,
  validateMusicQueueItemInput,
} from './music-sync.domain';
import {
  MAX_MUSIC_QUEUE_LENGTH,
  MUSIC_CONTROL_REQUEST_TTL_MS,
  MUSIC_HEARTBEAT_MAX_DELTA_MS,
  MUSIC_MAX_PENDING_CONTROL_REQUESTS,
  MUSIC_MAX_PENDING_TRACK_ACKS,
  MUSIC_TRACK_ACK_TTL_MS,
  type MusicControlAction,
  type MusicControlRequestNotice,
  type MusicHeartbeatPayload,
  type MusicHostFacts,
  type MusicMutationEnvelope,
  type MusicPlayMode,
  type MusicQueueItemInput,
  type MusicQueueItemPayload,
  type MusicSessionFacts,
  type MusicSnapshot,
  type MusicTrackAckPayload,
} from './types';

export interface MusicActor {
  socketId: string;
  userId: number | null;
  role: UserRole;
}

export interface MusicPendingControlRequest extends MusicControlRequestNotice {
  requestedAt: number;
}

export interface MusicTrackAckRecord extends MusicTrackAckPayload {
  socketId: string;
  userId: number | null;
  expiresAt: number;
}

export class MusicSyncError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MusicSyncError';
  }
}

interface MusicRuntime {
  queue: MusicQueueItemPayload[];
  playMode: MusicPlayMode;
  currentQueueItemId: number | null;
  shuffleSeed: string;
  shuffleOrder: number[];
  shuffleHistory: number[];
  state: {
    currentQueueItemId: number | null;
    currentIndex: number;
    currentSourceRef: string | null;
    isPlaying: boolean;
    positionSec: number;
    playbackRate: number;
    playMode: MusicPlayMode;
    musicGeneration: number;
    version: number;
    serverTimestamp: number;
  };
}

type MusicMutationOperation = (
  runtime: MusicRuntime,
  guard: Extract<DomainMutationGuardResult, { ok: true }>,
) => Promise<void>;

function isPositiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function cloneRuntime(runtime: MusicRuntime): MusicRuntime {
  return {
    queue: runtime.queue.map((item) => ({ ...item, metadata: { ...item.metadata } })),
    playMode: runtime.playMode,
    currentQueueItemId: runtime.currentQueueItemId,
    shuffleSeed: runtime.shuffleSeed,
    shuffleOrder: [...runtime.shuffleOrder],
    shuffleHistory: [...runtime.shuffleHistory],
    state: { ...runtime.state },
  };
}

function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function toPayload(row: MusicQueueItem): MusicQueueItemPayload {
  return {
    queueItemId: row.queueItemId,
    roomId: row.roomId,
    sourceRef: row.sourceRef,
    title: row.title,
    artist: row.artist || '',
    album: row.album || '',
    artworkUrl: row.artworkUrl || null,
    durationMs: Number.isFinite(row.durationMs) ? row.durationMs : 0,
    orderIndex: Number.isSafeInteger(row.orderIndex) ? row.orderIndex : 0,
    createdByUserId: row.createdByUserId ?? null,
    createdAt: row.createdAt instanceof Date
      ? row.createdAt.toISOString()
      : new Date().toISOString(),
    metadata: parseMetadata(row.metadataJson),
  };
}

function toSessionFacts(actor: MusicActor, session: Session | null): MusicSessionFacts {
  return {
    roomId: session?.roomId || '',
    sessionId: session ? String(session.id) : '',
    socketId: actor.socketId,
    userId: actor.userId,
    role: actor.role,
  };
}

/**
 * Server-owned music queue and playback state.
 *
 * This service owns music state only.  The shared RealtimeSyncCore is used
 * for ordering/deduplication/room locks, while video state stays in its own
 * VideoSyncDomain and video clock.
 */
export class MusicSyncService {
  private readonly runtimes = new Map<string, MusicRuntime>();
  private readonly loading = new Map<string, Promise<MusicRuntime>>();
  private readonly pendingControlRequests = new Map<string, MusicPendingControlRequest>();
  private readonly trackAcks = new Map<string, MusicTrackAckRecord>();
  private readonly dataSource: DataSource;
  private readonly core: RealtimeSyncCore;
  private onlineChecker: ((socketId: string) => boolean) | null = null;

  constructor(dataSource: DataSource = AppDataSource, core: RealtimeSyncCore = realtimeSyncCore) {
    this.dataSource = dataSource;
    this.core = core;
  }

  setOnlineChecker(checker: ((socketId: string) => boolean) | null): void {
    this.onlineChecker = checker;
  }

  private async readQueueRows(roomId: string): Promise<MusicQueueItem[]> {
    const rows = await this.dataSource.getRepository(MusicQueueItem).find({
      where: { roomId },
      order: { orderIndex: 'ASC', queueItemId: 'ASC' },
    });
    rows.sort((left, right) =>
      (left.orderIndex - right.orderIndex) || (left.queueItemId - right.queueItemId));
    const needsRepair = rows.some((row, index) => row.orderIndex !== index);
    if (needsRepair && this.dataSource.isInitialized) {
      await this.dataSource.transaction(async (manager) => {
        rows.forEach((row, index) => { row.orderIndex = index; });
        await manager.save(MusicQueueItem, rows);
      });
    }
    return rows;
  }

  private async loadRuntime(roomId: string): Promise<MusicRuntime> {
    const rows = await this.readQueueRows(roomId);
    const queue = rows.map(toPayload);
    const settings = await this.dataSource.getRepository(MusicRoomState).findOneBy({ roomId });
    const playMode = settings && isMusicPlayMode(settings.playMode)
      ? settings.playMode
      : 'sequential';
    const ids = queue.map((item) => item.queueItemId);
    const persistedCurrent = settings?.currentQueueItemId ?? null;
    const currentQueueItemId = persistedCurrent !== null && ids.includes(persistedCurrent)
      ? persistedCurrent
      : null;
    const shuffleSeed = settings?.shuffleSeed || `music:${roomId}`;
    let persistedShuffle: number[] = [];
    try {
      const parsed: unknown = JSON.parse(settings?.shuffleOrderJson || '[]');
      persistedShuffle = Array.isArray(parsed)
        ? parsed.filter(isPositiveId)
        : [];
    } catch {
      persistedShuffle = [];
    }
    const shuffleOrder = playMode === 'shuffle'
      ? normalizeShuffleOrder(
        persistedShuffle.length ? persistedShuffle : createStableShuffleOrder(ids, shuffleSeed),
        ids,
      )
      : normalizeShuffleOrder(persistedShuffle, ids);
    let shuffleHistory: number[] = [];
    try {
      const parsed: unknown = JSON.parse(settings?.shuffleHistoryJson || '[]');
      shuffleHistory = Array.isArray(parsed)
        ? parsed.filter(isPositiveId).filter((id, index, values) => values.indexOf(id) === index && ids.includes(id))
        : [];
    } catch {
      shuffleHistory = [];
    }

    this.core.hydrateDomain(
      roomId,
      settings?.version,
      settings?.musicGeneration,
      settings?.updatedAt instanceof Date ? settings.updatedAt.getTime() : undefined,
      'music',
    );
    const clock = this.core.currentDomain(roomId, 'music');
    const currentIndex = currentQueueItemId === null
      ? -1
      : queue.findIndex((item) => item.queueItemId === currentQueueItemId);
    const currentItem = currentIndex >= 0 ? queue[currentIndex] : null;
    return {
      queue,
      playMode,
      currentQueueItemId,
      shuffleSeed,
      shuffleOrder,
      shuffleHistory,
      state: {
        currentQueueItemId,
        currentIndex,
        currentSourceRef: currentItem?.sourceRef ?? null,
        isPlaying: false,
        positionSec: 0,
        playbackRate: 1,
        playMode,
        musicGeneration: clock.generation,
        version: clock.version,
        serverTimestamp: Date.now(),
      },
    };
  }

  private async getRuntime(roomId: string): Promise<MusicRuntime> {
    const existing = this.runtimes.get(roomId);
    if (existing) return existing;
    const pending = this.loading.get(roomId);
    if (pending) return pending;
    const load = this.loadRuntime(roomId);
    this.loading.set(roomId, load);
    try {
      const runtime = await load;
      this.runtimes.set(roomId, runtime);
      return runtime;
    } finally {
      if (this.loading.get(roomId) === load) this.loading.delete(roomId);
    }
  }

  private async saveSettings(
    manager: EntityManager,
    roomId: string,
    runtime: MusicRuntime,
    guard: Extract<DomainMutationGuardResult, { ok: true }>,
  ): Promise<void> {
    let settings = await manager.findOne(MusicRoomState, { where: { roomId } });
    if (!settings) {
      settings = manager.create(MusicRoomState, { roomId });
    }
    settings.playMode = runtime.playMode;
    settings.currentQueueItemId = runtime.currentQueueItemId;
    settings.shuffleSeed = runtime.shuffleSeed;
    settings.shuffleOrderJson = JSON.stringify(runtime.shuffleOrder);
    settings.shuffleHistoryJson = JSON.stringify(runtime.shuffleHistory);
    settings.shuffleCursor = runtime.playMode === 'shuffle' && runtime.currentQueueItemId !== null
      ? runtime.shuffleOrder.indexOf(runtime.currentQueueItemId)
      : 0;
    settings.version = guard.version;
    settings.musicGeneration = guard.generation;
    await manager.save(MusicRoomState, settings);
  }

  private setCurrent(runtime: MusicRuntime, queueItemId: number | null): void {
    runtime.currentQueueItemId = queueItemId;
    runtime.state.currentQueueItemId = queueItemId;
    runtime.state.currentIndex = queueItemId === null
      ? -1
      : runtime.queue.findIndex((item) => item.queueItemId === queueItemId);
    const current = runtime.queue.find((item) => item.queueItemId === queueItemId);
    runtime.state.currentSourceRef = current?.sourceRef ?? null;
    if (runtime.playMode === 'shuffle' && queueItemId !== null) {
      runtime.shuffleHistory = [...runtime.shuffleHistory.filter((id) => id !== queueItemId), queueItemId].slice(-200);
    }
  }

  private async mutateRuntime(
    roomId: string,
    runtime: MusicRuntime,
    envelope: MusicMutationEnvelope,
    trackSwitch: boolean,
    operation: MusicMutationOperation,
    now = Date.now(),
  ): Promise<void> {
    const suppliedGeneration = envelope.generation;
    if (suppliedGeneration !== undefined && suppliedGeneration !== runtime.state.musicGeneration) {
      throw new MusicSyncError('STALE_GENERATION', '旧 musicGeneration 已失效');
    }
    const guardedEnvelope: MusicMutationEnvelope = {
      ...envelope,
      generation: runtime.state.musicGeneration + (trackSwitch ? 1 : 0),
    };
    const guard = this.core.guardDomainMutation(roomId, guardedEnvelope, now, 'music');
    if (!guard.ok) throw new MusicSyncError(guard.code, guard.message);

    const before = cloneRuntime(runtime);
    try {
      await operation(runtime, guard);
      const committed = this.core.commitDomain(roomId, guardedEnvelope, now, 'music');
      if (!committed.ok) throw new MusicSyncError(committed.code, committed.message);
      runtime.state.version = guard.version;
      runtime.state.musicGeneration = guard.generation;
      runtime.state.serverTimestamp = guard.serverTimestamp;
    } catch (error) {
      Object.assign(runtime, before);
      throw error;
    }
  }

  private async withMutationSnapshot(
    roomId: string,
    actor: MusicActor,
    envelope: MusicMutationEnvelope,
    trackSwitch: boolean | ((runtime: MusicRuntime) => boolean),
    operation: MusicMutationOperation,
  ): Promise<MusicSnapshot> {
    return this.core.withRoomLock(roomId, async () => {
      const runtime = await this.getRuntime(roomId);
      const shouldSwitch = typeof trackSwitch === 'function' ? trackSwitch(runtime) : trackSwitch;
      await this.mutateRuntime(roomId, runtime, envelope, shouldSwitch, operation);
      return this.snapshotFromRuntime(roomId, runtime, actor);
    });
  }

  private async persistRuntimeSettings(
    roomId: string,
    runtime: MusicRuntime,
    guard: Extract<DomainMutationGuardResult, { ok: true }>,
  ): Promise<void> {
    await this.dataSource.transaction((manager) => this.saveSettings(manager, roomId, runtime, guard));
  }

  async addQueueItem(
    roomId: string,
    input: unknown,
    envelope: MusicMutationEnvelope,
    actor: MusicActor,
  ): Promise<MusicSnapshot> {
    const validation = validateMusicQueueItemInput(input);
    if (!validation.ok) throw new MusicSyncError('INVALID_PAYLOAD', validation.message);
    return this.withMutationSnapshot(roomId, actor, envelope, (runtime) => runtime.currentQueueItemId === null,
      async (runtime, guard) => {
        if (runtime.queue.length >= MAX_MUSIC_QUEUE_LENGTH) {
          throw new MusicSyncError('QUEUE_FULL', '音乐队列已达到上限');
        }
        await this.dataSource.transaction(async (manager) => {
          const row = manager.create(MusicQueueItem, {
            roomId,
            sourceRef: validation.value.sourceRef,
            title: validation.value.title,
            artist: validation.value.artist,
            album: validation.value.album,
            artworkUrl: validation.value.artworkUrl,
            durationMs: validation.value.durationMs,
            orderIndex: runtime.queue.length,
            createdByUserId: actor.userId,
            metadataJson: JSON.stringify(validation.value.metadata),
          });
          await manager.save(MusicQueueItem, row);
          runtime.queue.push(toPayload(row));
          if (runtime.currentQueueItemId === null) {
            this.setCurrent(runtime, row.queueItemId);
            runtime.state.positionSec = 0;
            runtime.state.isPlaying = false;
          }
          await this.saveSettings(manager, roomId, runtime, guard);
        });
      });
  }

  async removeQueueItem(
    roomId: string,
    queueItemId: number,
    envelope: MusicMutationEnvelope,
    actor: MusicActor,
  ): Promise<MusicSnapshot> {
    if (!isPositiveId(queueItemId)) throw new MusicSyncError('INVALID_PAYLOAD', 'queueItemId 无效');
    return this.withMutationSnapshot(roomId, actor, envelope,
      (runtime) => runtime.currentQueueItemId === queueItemId,
      async (runtime, guard) => {
        await this.dataSource.transaction(async (manager) => {
          const removedIndex = runtime.queue.findIndex((item) => item.queueItemId === queueItemId);
          if (removedIndex < 0) throw new MusicSyncError('NOT_FOUND', '歌曲不在队列中');
          const rows = await manager.find(MusicQueueItem, {
            where: { roomId },
            order: { orderIndex: 'ASC', queueItemId: 'ASC' },
          });
          const target = rows.find((row) => row.queueItemId === queueItemId);
          if (!target) throw new MusicSyncError('NOT_FOUND', '歌曲不在队列中');
          const remaining = rows.filter((row) => row.queueItemId !== queueItemId);
          await manager.remove(MusicQueueItem, target);
          remaining.forEach((row, index) => { row.orderIndex = index; });
          if (remaining.length) await manager.save(MusicQueueItem, remaining);
          runtime.queue = remaining.map(toPayload);
          if (runtime.currentQueueItemId === queueItemId) {
            const next = runtime.queue[removedIndex] ?? runtime.queue[removedIndex - 1] ?? null;
            this.setCurrent(runtime, next?.queueItemId ?? null);
            runtime.state.positionSec = 0;
            runtime.state.isPlaying = false;
          } else {
            this.setCurrent(runtime, runtime.currentQueueItemId);
          }
          await this.saveSettings(manager, roomId, runtime, guard);
        });
      });
  }

  async reorderQueue(
    roomId: string,
    queueItemIds: number[],
    envelope: MusicMutationEnvelope,
    actor: MusicActor,
  ): Promise<MusicSnapshot> {
    if (!Array.isArray(queueItemIds) || queueItemIds.length > MAX_MUSIC_QUEUE_LENGTH ||
      !queueItemIds.every(isPositiveId) || new Set(queueItemIds).size !== queueItemIds.length) {
      throw new MusicSyncError('INVALID_PAYLOAD', '队列顺序无效');
    }
    return this.withMutationSnapshot(roomId, actor, envelope, false,
      async (runtime, guard) => {
        if (queueItemIds.length !== runtime.queue.length ||
          queueItemIds.some((id) => !runtime.queue.some((item) => item.queueItemId === id))) {
          throw new MusicSyncError('INVALID_BOUNDS', '队列顺序必须包含全部当前条目');
        }
        await this.dataSource.transaction(async (manager) => {
          const rows = await manager.find(MusicQueueItem, { where: { roomId } });
          const byId = new Map(rows.map((row) => [row.queueItemId, row]));
          for (const [index, id] of queueItemIds.entries()) {
            const row = byId.get(id);
            if (!row) throw new MusicSyncError('NOT_FOUND', '歌曲不在队列中');
            row.orderIndex = index;
          }
          await manager.save(MusicQueueItem, queueItemIds.map((id) => byId.get(id)!));
          runtime.queue = queueItemIds.map((id) => runtime.queue.find((item) => item.queueItemId === id)!);
          this.setCurrent(runtime, runtime.currentQueueItemId);
          await this.saveSettings(manager, roomId, runtime, guard);
        });
      });
  }

  async clearQueue(
    roomId: string,
    envelope: MusicMutationEnvelope,
    actor: MusicActor,
  ): Promise<MusicSnapshot> {
    return this.withMutationSnapshot(roomId, actor, envelope,
      (runtime) => runtime.currentQueueItemId !== null,
      async (runtime, guard) => {
        await this.dataSource.transaction(async (manager) => {
          await manager.delete(MusicQueueItem, { roomId });
          runtime.queue = [];
          this.setCurrent(runtime, null);
          runtime.state.positionSec = 0;
          runtime.state.isPlaying = false;
          await this.saveSettings(manager, roomId, runtime, guard);
        });
      });
  }

  async selectTrack(
    roomId: string,
    queueItemId: number,
    envelope: MusicMutationEnvelope,
    actor: MusicActor,
  ): Promise<MusicSnapshot> {
    if (!isPositiveId(queueItemId)) throw new MusicSyncError('INVALID_PAYLOAD', 'queueItemId 无效');
    return this.withMutationSnapshot(roomId, actor, envelope, true,
      async (runtime, guard) => {
        if (!runtime.queue.some((item) => item.queueItemId === queueItemId)) {
          throw new MusicSyncError('NOT_FOUND', '歌曲不在队列中');
        }
        await this.dataSource.transaction(async (manager) => {
          this.setCurrent(runtime, queueItemId);
          runtime.state.positionSec = 0;
          runtime.state.isPlaying = false;
          await this.saveSettings(manager, roomId, runtime, guard);
        });
      });
  }

  async moveNext(
    roomId: string,
    direction: 1 | -1,
    envelope: MusicMutationEnvelope,
    actor: MusicActor,
  ): Promise<MusicSnapshot> {
    return this.withMutationSnapshot(roomId, actor, envelope,
      (runtime) => {
        const next = selectAdjacentQueueItemId(
          runtime.queue.map((item) => item.queueItemId),
          runtime.currentQueueItemId,
          runtime.playMode,
          direction,
          'manual',
          runtime.shuffleOrder,
        );
        return next !== null && next !== runtime.currentQueueItemId;
      },
      async (runtime, guard) => {
        await this.dataSource.transaction(async (manager) => {
          const next = selectAdjacentQueueItemId(
            runtime.queue.map((item) => item.queueItemId),
            runtime.currentQueueItemId,
            runtime.playMode,
            direction,
            'manual',
            runtime.shuffleOrder,
          );
          if (next === null) {
            runtime.state.isPlaying = false;
          } else if (next !== runtime.currentQueueItemId) {
            this.setCurrent(runtime, next);
            runtime.state.positionSec = 0;
          }
          await this.saveSettings(manager, roomId, runtime, guard);
        });
      });
  }

  async setPlayMode(
    roomId: string,
    playMode: unknown,
    envelope: MusicMutationEnvelope,
    actor: MusicActor,
  ): Promise<MusicSnapshot> {
    if (!isMusicPlayMode(playMode)) throw new MusicSyncError('INVALID_PAYLOAD', '播放模式无效');
    return this.withMutationSnapshot(roomId, actor, envelope, false,
      async (runtime, guard) => {
        await this.dataSource.transaction(async (manager) => {
          if (runtime.playMode !== playMode && playMode === 'shuffle') {
            runtime.shuffleSeed = `music:${roomId}:${randomUUID()}`;
            runtime.shuffleOrder = createStableShuffleOrder(
              runtime.queue.map((item) => item.queueItemId),
              runtime.shuffleSeed,
            );
          } else if (playMode === 'shuffle') {
            runtime.shuffleOrder = normalizeShuffleOrder(
              runtime.shuffleOrder,
              runtime.queue.map((item) => item.queueItemId),
            );
          }
          runtime.playMode = playMode;
          runtime.state.playMode = playMode;
          await this.saveSettings(manager, roomId, runtime, guard);
        });
      });
  }

  async applyPlayback(
    roomId: string,
    action: 'play' | 'pause' | 'seek',
    positionSec: number | undefined,
    envelope: MusicMutationEnvelope,
    actor: MusicActor,
  ): Promise<MusicSnapshot> {
    if (action === 'seek' && (typeof positionSec !== 'number' || !Number.isFinite(positionSec))) {
      throw new MusicSyncError('INVALID_PAYLOAD', '播放位置无效');
    }
    return this.withMutationSnapshot(roomId, actor, envelope, false,
      async (runtime, guard) => {
        const current = runtime.queue.find((item) => item.queueItemId === runtime.currentQueueItemId);
        if (!current) throw new MusicSyncError('EMPTY_QUEUE', '队列中没有当前歌曲');
        runtime.state.positionSec = clampMusicPosition(
          advanceMusicPosition(
            runtime.state.positionSec,
            runtime.state.isPlaying,
            runtime.state.playbackRate,
            runtime.state.serverTimestamp,
            guard.serverTimestamp,
          ),
          current.durationMs,
        );
        if (action === 'play') runtime.state.isPlaying = true;
        if (action === 'pause') runtime.state.isPlaying = false;
        if (action === 'seek') {
          runtime.state.positionSec = clampMusicPosition(positionSec!, current.durationMs);
        }
        await this.persistRuntimeSettings(roomId, runtime, guard);
      });
  }

  async applyHeartbeat(
    roomId: string,
    payload: MusicHeartbeatPayload,
    actor: MusicActor = { socketId: '', userId: null, role: 'guest' },
  ): Promise<MusicSnapshot> {
    return this.core.withRoomLock(roomId, async () => {
      const runtime = await this.getRuntime(roomId);
      const now = Date.now();
      if (payload.baseVersion !== runtime.state.version) {
        throw new MusicSyncError('STALE_VERSION', '心跳基于旧 music version');
      }
      if (payload.musicGeneration !== runtime.state.musicGeneration) {
        throw new MusicSyncError('STALE_GENERATION', '旧 musicGeneration 心跳已忽略');
      }
      if (payload.queueItemId !== runtime.currentQueueItemId) {
        throw new MusicSyncError('STALE_GENERATION', '旧歌曲心跳已忽略');
      }
      if (typeof payload.positionSec !== 'number' || !Number.isFinite(payload.positionSec) ||
        typeof payload.isPlaying !== 'boolean') {
        throw new MusicSyncError('INVALID_PAYLOAD', '心跳播放状态无效');
      }
      if (payload.clientTimestamp !== undefined &&
        Math.abs(now - payload.clientTimestamp) > MUSIC_HEARTBEAT_MAX_DELTA_MS * 10) {
        throw new MusicSyncError('INVALID_TIMESTAMP', '心跳时间戳无效');
      }
      const current = runtime.queue.find((item) => item.queueItemId === runtime.currentQueueItemId);
      const rate = payload.playbackRate ?? 1;
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0 || rate > 4) {
        throw new MusicSyncError('INVALID_PAYLOAD', '播放倍速无效');
      }
      runtime.state.positionSec = clampMusicPosition(payload.positionSec, current?.durationMs ?? 0);
      runtime.state.isPlaying = payload.isPlaying && current !== undefined;
      runtime.state.playbackRate = rate;
      runtime.state.serverTimestamp = now;
      return this.snapshotFromRuntime(roomId, runtime, actor);
    });
  }

  async applyEnded(
    roomId: string,
    envelope: MusicMutationEnvelope,
    actor: MusicActor,
    queueItemId?: number,
  ): Promise<MusicSnapshot> {
    return this.withMutationSnapshot(roomId, actor, envelope,
      (runtime) => runtime.currentQueueItemId !== null,
      async (runtime, guard) => {
        if (queueItemId !== undefined && queueItemId !== runtime.currentQueueItemId) {
          throw new MusicSyncError('STALE_GENERATION', '旧歌曲 ended 已忽略');
        }
        await this.dataSource.transaction(async (manager) => {
          const next = selectAdjacentQueueItemId(
            runtime.queue.map((item) => item.queueItemId),
            runtime.currentQueueItemId,
            runtime.playMode,
            1,
            'ended',
            runtime.shuffleOrder,
          );
          if (next === null) {
            runtime.state.isPlaying = false;
            const current = runtime.queue.find((item) => item.queueItemId === runtime.currentQueueItemId);
            runtime.state.positionSec = current ? current.durationMs / 1000 : 0;
          } else {
            this.setCurrent(runtime, next);
            runtime.state.positionSec = 0;
            runtime.state.isPlaying = true;
          }
          await this.saveSettings(manager, roomId, runtime, guard);
        });
      });
  }

  async getSessionFacts(roomId: string, actor: MusicActor): Promise<MusicSessionFacts> {
    const session = await this.dataSource.getRepository(Session).findOneBy({
      roomId,
      socketId: actor.socketId,
      endedAt: IsNull(),
    });
    return toSessionFacts(actor, session);
  }

  async getHostFacts(roomId: string): Promise<MusicHostFacts> {
    const session = await this.dataSource.getRepository(Session).findOneBy({
      roomId,
      role: 'sharer',
      endedAt: IsNull(),
    });
    if (!session) return { socketId: null, userId: null, online: false };
    const online = this.onlineChecker ? this.onlineChecker(session.socketId) : true;
    return {
      socketId: online ? session.socketId : null,
      userId: online ? session.userId : null,
      online,
    };
  }

  private async snapshotFromRuntime(
    roomId: string,
    runtime: MusicRuntime,
    actor: MusicActor,
  ): Promise<MusicSnapshot> {
    const session = await this.dataSource.getRepository(Session).findOneBy({
      roomId,
      socketId: actor.socketId,
      endedAt: IsNull(),
    });
    const host = await this.getHostFacts(roomId);
    const state = { ...runtime.state, playMode: runtime.playMode };
    return {
      roomId,
      session: toSessionFacts(actor, session),
      ...state,
      queue: runtime.queue.map((item) => ({ ...item, metadata: { ...item.metadata } })),
      currentItem: runtime.queue.find((item) => item.queueItemId === runtime.currentQueueItemId) ?? null,
      host,
      hostOffline: !host.online,
      state,
    };
  }

  async getSnapshot(roomId: string, actor: MusicActor): Promise<MusicSnapshot> {
    return this.core.withRoomLock(roomId, async () => {
      const runtime = await this.getRuntime(roomId);
      return this.snapshotFromRuntime(roomId, runtime, actor);
    });
  }

  async createControlRequest(
    roomId: string,
    actor: MusicActor,
    action: MusicControlAction,
    envelope: MusicMutationEnvelope,
    positionSec?: number,
    queueItemId?: number,
  ): Promise<MusicPendingControlRequest> {
    return this.core.withRoomLock(roomId, async () => {
      const runtime = await this.getRuntime(roomId);
      const host = await this.getHostFacts(roomId);
      if (!host.online || !host.socketId) throw new MusicSyncError('HOST_OFFLINE', '房主当前不在线');
      if (envelope.generation !== undefined && envelope.generation !== runtime.state.musicGeneration) {
        throw new MusicSyncError('STALE_GENERATION', '控制申请来自旧歌曲');
      }
      if (envelope.baseVersion !== undefined && envelope.baseVersion !== runtime.state.version) {
        throw new MusicSyncError('STALE_VERSION', '控制申请来自旧 music version');
      }
      if (this.pendingControlRequests.size >= MUSIC_MAX_PENDING_CONTROL_REQUESTS) {
        this.expirePending(Date.now());
        if (this.pendingControlRequests.size >= MUSIC_MAX_PENDING_CONTROL_REQUESTS) {
          throw new MusicSyncError('RATE_LIMITED', '控制申请过多');
        }
      }
      const now = Date.now();
      const requestedId = typeof envelope.mutationId === 'string' && envelope.mutationId.length <= 128
        ? envelope.mutationId
        : randomUUID();
      const requestId = `${actor.socketId}:${requestedId}`.slice(0, 256);
      const request: MusicPendingControlRequest = {
        roomId,
        requestId,
        action,
        positionSec,
        queueItemId,
        musicGeneration: runtime.state.musicGeneration,
        version: runtime.state.version,
        clientTimestamp: envelope.clientTimestamp,
        actorSocketId: actor.socketId,
        actorUserId: actor.userId,
        targetHostSocketId: host.socketId,
        expiresAt: now + MUSIC_CONTROL_REQUEST_TTL_MS,
        requestedAt: now,
      };
      this.pendingControlRequests.set(requestId, request);
      return request;
    });
  }

  getControlRequest(requestId: string): MusicPendingControlRequest | null {
    const request = this.pendingControlRequests.get(requestId);
    if (!request) return null;
    if (request.expiresAt <= Date.now()) {
      this.pendingControlRequests.delete(requestId);
      return null;
    }
    return request;
  }

  completeControlRequest(requestId: string): MusicPendingControlRequest | null {
    const request = this.getControlRequest(requestId);
    if (request) this.pendingControlRequests.delete(requestId);
    return request;
  }

  async applyRequestedControl(
    request: MusicPendingControlRequest,
    actor: MusicActor,
  ): Promise<MusicSnapshot> {
    if (request.expiresAt <= Date.now()) {
      throw new MusicSyncError('STALE_REQUEST', '控制申请已过期');
    }
    if (actor.socketId !== request.targetHostSocketId) {
      throw new MusicSyncError('FORBIDDEN', '只有当前房主可以响应控制申请');
    }
    const envelope: MusicMutationEnvelope = {
      baseVersion: request.version,
      generation: request.musicGeneration,
      mutationId: `control:${request.requestId}`,
    };
    if (request.action === 'next') return this.moveNext(request.roomId, 1, envelope, actor);
    if (request.action === 'previous') return this.moveNext(request.roomId, -1, envelope, actor);
    if (request.action === 'select') return this.selectTrack(request.roomId, request.queueItemId!, envelope, actor);
    return this.applyPlayback(request.roomId, request.action, request.positionSec, envelope, actor);
  }

  async recordTrackAck(
    actor: MusicActor,
    payload: MusicTrackAckPayload,
  ): Promise<MusicTrackAckRecord> {
    return this.core.withRoomLock(payload.roomId, async () => {
      const runtime = await this.getRuntime(payload.roomId);
      if (payload.musicGeneration !== runtime.state.musicGeneration ||
        payload.queueItemId !== runtime.currentQueueItemId) {
        throw new MusicSyncError('STALE_GENERATION', '旧歌曲 ACK 已忽略');
      }
      if (payload.version !== runtime.state.version) {
        throw new MusicSyncError('STALE_VERSION', '旧 music version ACK 已忽略');
      }
      if (this.trackAcks.size >= MUSIC_MAX_PENDING_TRACK_ACKS) {
        this.expirePending(Date.now());
        if (this.trackAcks.size >= MUSIC_MAX_PENDING_TRACK_ACKS) {
          throw new MusicSyncError('RATE_LIMITED', 'track ACK 过多');
        }
      }
      const record: MusicTrackAckRecord = {
        ...payload,
        socketId: actor.socketId,
        userId: actor.userId,
        expiresAt: Date.now() + MUSIC_TRACK_ACK_TTL_MS,
      };
      this.trackAcks.set(`${payload.roomId}:${actor.socketId}:${payload.musicGeneration}`, record);
      return record;
    });
  }

  private expirePending(now: number): void {
    for (const [id, request] of this.pendingControlRequests) {
      if (request.expiresAt <= now) this.pendingControlRequests.delete(id);
    }
    for (const [id, ack] of this.trackAcks) {
      if (ack.expiresAt <= now) this.trackAcks.delete(id);
    }
  }

  handleSocketDisconnect(socketId: string): string[] {
    const affectedRooms = new Set<string>();
    for (const [id, request] of this.pendingControlRequests) {
      if (request.actorSocketId === socketId || request.targetHostSocketId === socketId) {
        affectedRooms.add(request.roomId);
        this.pendingControlRequests.delete(id);
      }
    }
    for (const [id, ack] of this.trackAcks) {
      if (ack.socketId === socketId) {
        affectedRooms.add(ack.roomId);
        this.trackAcks.delete(id);
      }
    }
    this.core.clearSocket(socketId);
    return [...affectedRooms];
  }

  clearRuntime(roomId: string): void {
    this.runtimes.delete(roomId);
    this.loading.delete(roomId);
    for (const [id, request] of this.pendingControlRequests) {
      if (request.roomId === roomId) this.pendingControlRequests.delete(id);
    }
    for (const [id, ack] of this.trackAcks) {
      if (ack.roomId === roomId) this.trackAcks.delete(id);
    }
    this.core.clearRoom(roomId);
  }

  async deletePersistedRoomData(roomId: string): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      await manager.delete(MusicQueueItem, { roomId });
      await manager.delete(MusicRoomState, { roomId });
    });
    this.clearRuntime(roomId);
  }
}

export const musicSyncService = new MusicSyncService();
