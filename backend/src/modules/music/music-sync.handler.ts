import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { SocketEventHandler, AckCallback } from '../socket';
import { safeAck } from '../socket';
import { emitToAuthorizedMember } from '../realtime-sync-core';
import { MAX_ROOM_ID_LENGTH, isBoundedIdentifier, isValidVersion } from '../realtime-sync-core';
import { roomPermissionService } from '../room/room-permission.service';
import type { RoomPermissionAction } from '../room/permission-core';
import {
  MusicSyncError,
  musicSyncService,
  type MusicActor,
  type MusicPendingControlRequest,
} from './music-sync.service';
import type {
  MusicControlAction,
  MusicHeartbeatPayload,
  MusicMutationEnvelope,
  MusicTrackAckPayload,
} from './types';

const MAX_REQUEST_ID_LENGTH = 256;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function roomIdOf(value: unknown): string | null {
  const candidate = asRecord(value)?.roomId;
  return isBoundedIdentifier(candidate, MAX_ROOM_ID_LENGTH) ? candidate : null;
}

function actorOf(socket: Socket): MusicActor {
  const rawUserId = socket.data?.userId;
  const userId = Number.isInteger(rawUserId) && rawUserId > 0 ? Number(rawUserId) : null;
  const role = socket.data?.role;
  return {
    socketId: socket.id,
    userId,
    role: role === 'root' || role === 'admin' || role === 'user' || role === 'guest' ? role : 'guest',
  };
}

function envelopeOf(value: unknown): MusicMutationEnvelope {
  const record = asRecord(value);
  if (!record) return {};
  const mutationId = record.mutationId;
  return {
    baseVersion: typeof record.baseVersion === 'number' ? record.baseVersion : undefined,
    generation: typeof record.musicGeneration === 'number'
      ? record.musicGeneration
      : typeof record.generation === 'number' ? record.generation : undefined,
    mutationId: typeof mutationId === 'string' ? mutationId : undefined,
    clientTimestamp: typeof record.clientTimestamp === 'number' ? record.clientTimestamp : undefined,
  };
}

function actionOf(value: unknown): MusicControlAction | null {
  return value === 'play' || value === 'pause' || value === 'seek' ||
    value === 'next' || value === 'previous' || value === 'select'
    ? value
    : null;
}

function actionPermission(action: MusicControlAction): RoomPermissionAction {
  if (action === 'play') return 'music.play';
  if (action === 'pause') return 'music.pause';
  if (action === 'seek') return 'music.seek';
  if (action === 'next') return 'music.next';
  if (action === 'previous') return 'music.previous';
  return 'music.track.select';
}

function errorResponse(error: unknown): { success: false; code?: string; message: string } {
  if (error instanceof MusicSyncError) return { success: false, code: error.code, message: error.message };
  return { success: false, message: '音乐操作失败' };
}

function ackFailure(callback: AckCallback | undefined, error: unknown): void {
  safeAck(callback, errorResponse(error));
}

/** Socket boundary for Together Listen. All authority remains in MusicSyncService. */
export class MusicSyncHandler implements SocketEventHandler {
  readonly name = 'music-sync';

  register(socket: Socket, io: SocketIOServer): void {
    musicSyncService.setOnlineChecker((socketId) => io.sockets.sockets.has(socketId));

    const requireMember = async (roomId: string): Promise<boolean> => {
      const facts = await roomPermissionService.getRoleFacts(socket, roomId);
      return facts.isRoomMember;
    };

    const requireAction = async (
      roomId: string,
      action: RoomPermissionAction,
    ): Promise<{ allowed: true } | { allowed: false; reason: string }> => {
      const decision = await roomPermissionService.canPerform(socket, roomId, action);
      return decision.allowed ? { allowed: true } : { allowed: false, reason: decision.reason };
    };

    const lastMusicGeneration = new Map<string, number>();

    const broadcastSnapshot = (snapshot: unknown, roomId: string): void => {
      io.to(roomId).emit('music:state', snapshot);
      io.to(roomId).emit('music:sync-state', snapshot);
      io.to(roomId).emit('music:queue-changed', snapshot);
      const generation = asRecord(snapshot)?.musicGeneration;
      if (typeof generation === 'number') {
        const previous = lastMusicGeneration.get(roomId);
        if (previous !== undefined && previous !== generation) {
          io.to(roomId).emit('music:track-switch', snapshot);
        }
        lastMusicGeneration.set(roomId, generation);
      }
    };

    const runMutation = async (
      roomId: string,
      permission: RoomPermissionAction,
      callback: AckCallback | undefined,
      operation: () => Promise<import('./types').MusicSnapshot>,
    ): Promise<void> => {
      const decision = await requireAction(roomId, permission);
      if (!decision.allowed) {
        safeAck(callback, { success: false, code: 'FORBIDDEN', message: decision.reason });
        return;
      }
      const snapshot = await operation();
      broadcastSnapshot(snapshot, roomId);
      safeAck(callback, { success: true, data: snapshot });
    };

    const emitControlResponse = async (
      request: MusicPendingControlRequest,
      accepted: boolean,
      reason?: string,
      snapshot?: import('./types').MusicSnapshot,
    ): Promise<Record<string, unknown>> => {
      const response: Record<string, unknown> = {
        roomId: request.roomId,
        requestId: request.requestId,
        accepted,
        musicGeneration: snapshot?.musicGeneration ?? request.musicGeneration,
        version: snapshot?.version ?? request.version,
        ...(reason ? { reason: reason.slice(0, 300) } : {}),
        ...(snapshot ? { snapshot } : {}),
      };
      await emitToAuthorizedMember(
        io,
        request.roomId,
        request.actorSocketId,
        'music:control-response',
        response,
        async (target) =>
          (await roomPermissionService.getRoleFacts(target, request.roomId))
            .isRoomMember,
      );
      return response;
    };

    const registerMutation = (
      events: string[],
      permission: RoomPermissionAction,
      operation: (roomId: string, payload: Record<string, unknown>, actor: MusicActor) => Promise<import('./types').MusicSnapshot>,
    ): void => {
      for (const event of events) {
        socket.on(event, (rawPayload: unknown, callback?: AckCallback) => {
          void (async () => {
            const payload = asRecord(rawPayload);
            const roomId = roomIdOf(rawPayload);
            if (!payload || !roomId) {
              safeAck(callback, { success: false, code: 'INVALID_PAYLOAD', message: 'roomId 无效' });
              return;
            }
            await runMutation(roomId, permission, callback, () => operation(roomId, payload, actorOf(socket)));
          })().catch((error: unknown) => ackFailure(callback, error));
        });
      }
    };

    const handleGetState = (rawPayload: unknown, callback?: AckCallback): void => {
      void (async () => {
        const roomId = roomIdOf(rawPayload);
        if (!roomId || !(await requireMember(roomId))) {
          safeAck(callback, { success: false, code: 'FORBIDDEN', message: '不在该房间中' });
          return;
        }
        const snapshot = await musicSyncService.getSnapshot(roomId, actorOf(socket));
        lastMusicGeneration.set(roomId, snapshot.musicGeneration);
        safeAck(callback, { success: true, data: snapshot });
        socket.emit('music:snapshot', snapshot);
      })().catch((error: unknown) => ackFailure(callback, error));
    };
    socket.on('music:get-state', handleGetState);
    socket.on('music:request-state', handleGetState);

    registerMutation(['music:queue-add', 'music:queue-upsert'], 'music.queue.add',
      (roomId, payload, actor) => musicSyncService.addQueueItem(roomId, payload.item ?? payload, envelopeOf(payload), actor));
    registerMutation(['music:queue-remove'], 'music.queue.remove',
      (roomId, payload, actor) => musicSyncService.removeQueueItem(roomId, payload.queueItemId as number, envelopeOf(payload), actor));
    registerMutation(['music:queue-reorder'], 'music.queue.reorder',
      (roomId, payload, actor) => musicSyncService.reorderQueue(roomId, payload.queueItemIds as number[], envelopeOf(payload), actor));
    registerMutation(['music:queue-clear'], 'music.queue.clear',
      (roomId, payload, actor) => musicSyncService.clearQueue(roomId, envelopeOf(payload), actor));
    registerMutation(['music:queue-select', 'music:track-select'], 'music.track.select',
      (roomId, payload, actor) => musicSyncService.selectTrack(roomId, payload.queueItemId as number, envelopeOf(payload), actor));
    registerMutation(['music:play'], 'music.play',
      (roomId, payload, actor) => musicSyncService.applyPlayback(roomId, 'play', undefined, envelopeOf(payload), actor));
    registerMutation(['music:pause'], 'music.pause',
      (roomId, payload, actor) => musicSyncService.applyPlayback(roomId, 'pause', undefined, envelopeOf(payload), actor));
    registerMutation(['music:seek'], 'music.seek',
      (roomId, payload, actor) => musicSyncService.applyPlayback(roomId, 'seek', payload.positionSec as number, envelopeOf(payload), actor));
    registerMutation(['music:next'], 'music.next',
      (roomId, payload, actor) => musicSyncService.moveNext(roomId, 1, envelopeOf(payload), actor));
    registerMutation(['music:previous', 'music:prev'], 'music.previous',
      (roomId, payload, actor) => musicSyncService.moveNext(roomId, -1, envelopeOf(payload), actor));
    registerMutation(['music:mode-change', 'music:play-mode'], 'music.mode.change',
      (roomId, payload, actor) => musicSyncService.setPlayMode(roomId, payload.playMode ?? payload.mode, envelopeOf(payload), actor));

    const registerHostHeartbeat = (event: string): void => {
      socket.on(event, (rawPayload: unknown, callback?: AckCallback) => {
        void (async () => {
          const payload = asRecord(rawPayload);
          const roomId = roomIdOf(rawPayload);
          if (!payload || !roomId) {
            safeAck(callback, { success: false, code: 'INVALID_PAYLOAD', message: '心跳 payload 无效' });
            return;
          }
          const decision = await requireAction(roomId, 'music.heartbeat');
          if (!decision.allowed) {
            safeAck(callback, { success: false, code: 'FORBIDDEN', message: decision.reason });
            return;
          }
          const heartbeat: MusicHeartbeatPayload = {
            roomId,
            queueItemId: payload.queueItemId === null ? null : payload.queueItemId as number,
            musicGeneration: (payload.musicGeneration ?? payload.generation) as number,
            positionSec: payload.positionSec as number,
            isPlaying: payload.isPlaying as boolean,
            playbackRate: payload.playbackRate as number | undefined,
            baseVersion: payload.baseVersion as number,
            clientTimestamp: payload.clientTimestamp as number | undefined,
          };
          const snapshot = await musicSyncService.applyHeartbeat(roomId, heartbeat, actorOf(socket));
          io.to(roomId).emit('music:heartbeat', snapshot);
          safeAck(callback, { success: true, data: snapshot });
        })().catch((error: unknown) => ackFailure(callback, error));
      });
    };
    registerHostHeartbeat('music:heartbeat');
    registerHostHeartbeat('music:sync-state');

    socket.on('music:ended', (rawPayload: unknown, callback?: AckCallback) => {
      void (async () => {
        const payload = asRecord(rawPayload);
        const roomId = roomIdOf(rawPayload);
        if (!payload || !roomId) {
          safeAck(callback, { success: false, code: 'INVALID_PAYLOAD', message: 'ended payload 无效' });
          return;
        }
        const decision = await requireAction(roomId, 'music.track.ended');
        if (!decision.allowed) {
          safeAck(callback, { success: false, code: 'FORBIDDEN', message: decision.reason });
          return;
        }
        const envelope = envelopeOf(payload);
        if (!isValidVersion(payload.queueItemId) || payload.queueItemId <= 0) {
          safeAck(callback, { success: false, code: 'INVALID_PAYLOAD', message: 'ended 歌曲无效' });
          return;
        }
        const snapshot = await musicSyncService.applyEnded(
          roomId,
          envelope,
          actorOf(socket),
          payload.queueItemId,
        );
        broadcastSnapshot(snapshot, roomId);
        safeAck(callback, { success: true, data: snapshot });
      })().catch((error: unknown) => ackFailure(callback, error));
    });

    socket.on('music:control-request', (rawPayload: unknown, callback?: AckCallback) => {
      void (async () => {
        const payload = asRecord(rawPayload);
        const roomId = roomIdOf(rawPayload);
        const action = actionOf(payload?.action);
        if (!payload || !roomId || !action) {
          safeAck(callback, { success: false, code: 'INVALID_PAYLOAD', message: '控制申请无效' });
          return;
        }
        const decision = await requireAction(roomId, 'music.control.request');
        if (!decision.allowed) {
          safeAck(callback, { success: false, code: 'FORBIDDEN', message: decision.reason });
          return;
        }
        const controlEnvelope = envelopeOf(payload);
        if (!controlEnvelope.mutationId && typeof payload.requestId === 'string') {
          controlEnvelope.mutationId = payload.requestId.slice(0, MAX_REQUEST_ID_LENGTH);
        }
        if (action === 'seek' && (typeof payload.positionSec !== 'number' || !Number.isFinite(payload.positionSec))) {
          safeAck(callback, { success: false, code: 'INVALID_PAYLOAD', message: '控制申请位置无效' });
          return;
        }
        if (action === 'select' && !isValidVersion(payload.queueItemId)) {
          safeAck(callback, { success: false, code: 'INVALID_PAYLOAD', message: '控制申请歌曲无效' });
          return;
        }
        const request = await musicSyncService.createControlRequest(
          roomId,
          actorOf(socket),
          action,
          controlEnvelope,
          payload.positionSec as number | undefined,
          payload.queueItemId as number | undefined,
        );
        const delivered = await emitToAuthorizedMember(
          io,
          roomId,
          request.targetHostSocketId,
          'music:control-request',
          request,
          async (target) => (await roomPermissionService.getRoleFacts(target, roomId)).isRoomMember,
        );
        if (!delivered) {
          musicSyncService.completeControlRequest(request.requestId);
          safeAck(callback, { success: false, code: 'HOST_OFFLINE', message: '房主当前不在线' });
          return;
        }
        safeAck(callback, {
          success: true,
          data: { requestId: request.requestId, expiresAt: request.expiresAt },
        });
      })().catch((error: unknown) => ackFailure(callback, error));
    });

    socket.on('music:control-response', (rawPayload: unknown, callback?: AckCallback) => {
      void (async () => {
        const payload = asRecord(rawPayload);
        const roomId = roomIdOf(rawPayload);
        const requestId = payload?.requestId;
        if (!payload || !roomId || !isBoundedIdentifier(requestId, MAX_REQUEST_ID_LENGTH) || typeof payload.accepted !== 'boolean') {
          safeAck(callback, { success: false, code: 'INVALID_PAYLOAD', message: '控制响应无效' });
          return;
        }
        const request = musicSyncService.getControlRequest(requestId);
        if (!request || request.roomId !== roomId || request.targetHostSocketId !== socket.id) {
          safeAck(callback, { success: false, code: 'STALE_REQUEST', message: '控制申请已过期或目标不匹配' });
          return;
        }
        if (payload.musicGeneration !== request.musicGeneration || payload.version !== request.version) {
          musicSyncService.completeControlRequest(requestId);
          const response = await emitControlResponse(request, false, '控制响应基于旧状态');
          safeAck(callback, { success: false, code: 'STALE_VERSION', message: '控制响应基于旧状态', data: response });
          return;
        }
        const decision = await requireAction(roomId, actionPermission(request.action));
        if (!decision.allowed) {
          musicSyncService.completeControlRequest(requestId);
          const response = await emitControlResponse(request, false, decision.reason);
          safeAck(callback, { success: false, code: 'FORBIDDEN', message: decision.reason, data: response });
          return;
        }
        const actor = actorOf(socket);
        musicSyncService.completeControlRequest(requestId);
        if (!payload.accepted) {
          const response = await emitControlResponse(
            request,
            false,
            typeof payload.reason === 'string' ? payload.reason : '房主拒绝了控制申请',
          );
          safeAck(callback, { success: true, data: response });
          return;
        }
        let snapshot: import('./types').MusicSnapshot;
        try {
          snapshot = await musicSyncService.applyRequestedControl(request, actor);
        } catch (error) {
          const failure = errorResponse(error);
          const response = await emitControlResponse(request, false, failure.message);
          safeAck(callback, { ...failure, data: response });
          return;
        }
        broadcastSnapshot(snapshot, roomId);
        const response = await emitControlResponse(request, true, undefined, snapshot);
        safeAck(callback, { success: true, data: response });
      })().catch((error: unknown) => ackFailure(callback, error));
    });

    const registerTrackAck = (event: string): void => {
      socket.on(event, (rawPayload: unknown, callback?: AckCallback) => {
        void (async () => {
          const payload = asRecord(rawPayload);
          const roomId = roomIdOf(rawPayload);
          if (!payload || !roomId ||
            (payload.queueItemId !== null && !isValidVersion(payload.queueItemId)) ||
            !isValidVersion(payload.musicGeneration) || !isValidVersion(payload.version) ||
            typeof payload.ready !== 'boolean') {
            safeAck(callback, { success: false, code: 'INVALID_PAYLOAD', message: 'track ACK 无效' });
            return;
          }
          const decision = await requireAction(roomId, 'music.track.ack');
          if (!decision.allowed) {
            safeAck(callback, { success: false, code: 'FORBIDDEN', message: decision.reason });
            return;
          }
          const record = await musicSyncService.recordTrackAck(actorOf(socket), {
            roomId,
            requestId: typeof payload.requestId === 'string' ? payload.requestId : undefined,
            queueItemId: payload.queueItemId as number | null,
            musicGeneration: payload.musicGeneration as number,
            version: payload.version as number,
            ready: payload.ready,
          });
          const host = await musicSyncService.getHostFacts(roomId);
          if (host.socketId) {
            await emitToAuthorizedMember(io, roomId, host.socketId, 'music:track-ack', record,
              async (target) => (await roomPermissionService.getRoleFacts(target, roomId)).isRoomMember);
          }
          safeAck(callback, { success: true, data: { accepted: true } });
        })().catch((error: unknown) => ackFailure(callback, error));
      });
    };
    registerTrackAck('music:track-ack');
    registerTrackAck('music:sync-ack');

    socket.on('disconnect', () => {
      const roomIds = [...socket.rooms].filter((roomId) => roomId !== socket.id);
      musicSyncService.handleSocketDisconnect(socket.id);
      // RoomDisconnectHandler closes the DB session asynchronously. Delay the
      // read just enough to publish an explicit host-offline music snapshot.
      setTimeout(() => {
        void Promise.all(roomIds.map(async (roomId) => {
          try {
            const snapshot = await musicSyncService.getSnapshot(roomId, {
              socketId: '',
              userId: null,
              role: 'guest',
            });
            io.to(roomId).emit('music:state', snapshot);
          } catch {
            // The room may already have been deleted during disconnect cleanup.
          }
        }));
      }, 50);
    });
  }
}
