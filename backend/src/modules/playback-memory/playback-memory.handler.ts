/**
 * Compatibility adapter for legacy watch-together event names.
 * Authoritative mutations pass through RealtimeSyncCore and VideoSyncDomain.
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { AckCallback, SocketEventHandler } from '../socket';
import { safeAck } from '../socket';
import { roomPermissionService } from '../room/room-permission.service';
import { roomSessionService } from '../room/room-session.service';
import { roomStateService } from '../room/room-state.service';
import { playbackMemoryService } from './playback-memory.service';
import { realtimeSyncCore, emitToAuthorizedMember } from '../realtime-sync-core';
import { VideoSyncDomain } from '../sync-playback/video-sync.domain';
import type { SyncControlPayload, SyncStatePayload } from '../shared/dto';
import type { AuthoritativeSnapshot, MutationEnvelope } from '../realtime-sync-core';

interface StateAckData {
  state: Awaited<ReturnType<typeof playbackMemoryService.getAdvancedPlayback>>;
  snapshot?: AuthoritativeSnapshot<NonNullable<StateAckData['state']>>;
  version?: number;
  sourceGeneration?: number;
  serverTimestamp?: number;
}

function validRoomId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function mutationEnvelope(payload: Partial<MutationEnvelope>): MutationEnvelope {
  return {
    baseVersion: payload.baseVersion,
    sourceGeneration: payload.sourceGeneration,
    mutationId: payload.mutationId,
    clientTimestamp: payload.clientTimestamp,
  };
}

export class PlaybackMemoryHandler implements SocketEventHandler {
  readonly name = 'PlaybackMemoryHandler';

  register(socket: Socket, io: SocketIOServer): void {
    const handleState = async (payload: SyncStatePayload, callback?: AckCallback): Promise<void> => {
      const roomId = payload?.roomId;
      if (!validRoomId(roomId) || !payload?.state) {
        safeAck(callback, { success: false, code: 'INVALID_PAYLOAD', message: '播放状态 payload 无效' });
        return;
      }
      await realtimeSyncCore.withRoomLock(roomId, async () => {
        try {
          const permission = await roomPermissionService.canPerform(socket, roomId, 'playback.play');
          if (!permission.allowed) {
            safeAck(callback, { success: false, code: 'FORBIDDEN', message: permission.reason });
            return;
          }
          if (!(await roomPermissionService.isWatchTogetherRoom(roomId))) {
            safeAck(callback, { success: false, code: 'ROOM_MODE', message: '当前房间模式不支持同步播放' });
            return;
          }
          const validated = VideoSyncDomain.validateState(payload.state);
          if (!validated.ok) {
            safeAck(callback, { success: false, code: 'INVALID_PAYLOAD', message: validated.message });
            return;
          }
          const current = await playbackMemoryService.getRawPlayback(roomId);
          realtimeSyncCore.hydrate(roomId, current?.version, current?.sourceGeneration, current?.serverTimestamp ?? current?.updatedAt);
          const envelope = mutationEnvelope({
            ...payload,
            baseVersion: payload.baseVersion ?? payload.state.version,
            sourceGeneration: payload.state.sourceGeneration,
          });
          const committed = realtimeSyncCore.commit(roomId, envelope);
          if (!committed.ok) {
            safeAck(callback, { success: false, code: committed.code, message: committed.message });
            return;
          }
          const authoritative = await playbackMemoryService.setPlayback(
            roomId,
            validated.state,
            socket.id,
            {
              version: committed.version,
              sourceGeneration: committed.sourceGeneration,
              serverTimestamp: committed.serverTimestamp,
            },
          );
          roomStateService.setPlayback(roomId, authoritative);
          socket.to(roomId).emit('watch-together-state', {
            state: authoritative,
            seq: authoritative.version,
            version: authoritative.version,
            sourceGeneration: authoritative.sourceGeneration,
            serverTimestamp: authoritative.serverTimestamp,
          });
          safeAck(callback, {
            success: true,
            data: {
              state: authoritative,
              version: authoritative.version,
              sourceGeneration: authoritative.sourceGeneration,
              serverTimestamp: authoritative.serverTimestamp,
            },
          });
        } catch (err) {
          console.error('[watch-together-state] error:', err);
          safeAck(callback, { success: false, message: '同步失败' });
        }
      });
    };

    socket.on('watch-together-state', (payload: SyncStatePayload, callback?: AckCallback) => {
      void handleState(payload, callback);
    });

    const handleGetState = async (payload: { roomId?: unknown }, callback?: AckCallback): Promise<void> => {
      const roomId = payload?.roomId;
      try {
        if (!validRoomId(roomId) || !(await roomPermissionService.isInRoom(socket, roomId))) {
          safeAck(callback, { success: false, code: 'FORBIDDEN', message: '不在该房间中' });
          return;
        }
        const state = await playbackMemoryService.getAdvancedPlayback(roomId);
        if (!state) {
          safeAck(callback, { success: true, data: null });
          return;
        }
        realtimeSyncCore.hydrate(roomId, state.version, state.sourceGeneration, state.serverTimestamp ?? state.updatedAt);
        const session = await roomPermissionService.getActiveSession(socket);
        const host = await roomSessionService.getSharer(roomId);
        const snapshot: AuthoritativeSnapshot<typeof state> = {
          roomId,
          session: {
            roomId,
            sessionId: session ? String(session.id) : `${roomId}:${socket.id}`,
            socketId: socket.id,
            userId: Number.isInteger(socket.data?.userId) ? Number(socket.data.userId) : null,
            role: socket.data?.role ?? 'guest',
          },
          version: state.version,
          sourceGeneration: state.sourceGeneration,
          serverTimestamp: state.serverTimestamp ?? state.updatedAt,
          domain: state,
          host: {
            socketId: host?.socketId ?? null,
            userId: host?.userId ?? null,
            online: !!host && io.sockets.sockets.has(host.socketId),
          },
        };
        const data: StateAckData = {
          state,
          snapshot,
          version: snapshot.version,
          sourceGeneration: snapshot.sourceGeneration,
          serverTimestamp: snapshot.serverTimestamp,
        };
        safeAck(callback, { success: true, data });
      } catch (err) {
        console.error('[watch-together-request-state] error:', err);
        safeAck(callback, { success: false, message: '请求失败' });
      }
    };

    socket.on('watch-together-request-state', handleGetState);
    socket.on('watch-together-get-state', handleGetState);
    socket.on('realtime:get-state', handleGetState);

    socket.on('watch-together-control', (payload: SyncControlPayload, callback?: AckCallback) => {
      void realtimeSyncCore.withRoomLock(payload?.roomId ?? '', async () => {
        try {
          if (!validRoomId(payload?.roomId) || !payload?.action) {
            safeAck(callback, { success: false, code: 'INVALID_PAYLOAD', message: '控制 payload 无效' });
            return;
          }
          const actionMap = {
            play: 'playback.play',
            pause: 'playback.pause',
            seek: 'playback.seek',
            rate: 'playback.rate',
          } as const;
          const permission = await roomPermissionService.canPerform(socket, payload.roomId, actionMap[payload.action]);
          if (!permission.allowed) {
            safeAck(callback, { success: false, code: 'FORBIDDEN', message: permission.reason });
            return;
          }
          if (!(await roomPermissionService.isWatchTogetherRoom(payload.roomId))) {
            safeAck(callback, { success: false, code: 'ROOM_MODE', message: '当前房间模式不支持同步播放' });
            return;
          }
          const raw = await playbackMemoryService.getRawPlayback(payload.roomId);
          const advanced = await playbackMemoryService.getAdvancedPlayback(payload.roomId);
          if (!raw || !advanced) {
            safeAck(callback, { success: false, code: 'NO_STATE', message: '房间暂无播放状态' });
            return;
          }
          realtimeSyncCore.hydrate(payload.roomId, raw.version, raw.sourceGeneration, raw.serverTimestamp ?? raw.updatedAt);
          if ((payload.sourceGeneration ?? raw.sourceGeneration) !== raw.sourceGeneration) {
            safeAck(callback, { success: false, code: 'STALE_GENERATION', message: '旧 sourceGeneration 已失效' });
            return;
          }
          const transition = VideoSyncDomain.applyControl(raw, payload.action, payload.value, advanced.currentTime);
          if (!transition.ok) {
            safeAck(callback, { success: false, code: 'INVALID_PAYLOAD', message: transition.message });
            return;
          }
          const committed = realtimeSyncCore.commit(payload.roomId, mutationEnvelope(payload));
          if (!committed.ok) {
            safeAck(callback, { success: false, code: committed.code, message: committed.message });
            return;
          }
          const authoritative = await playbackMemoryService.setPlayback(
            payload.roomId,
            transition.result.state,
            socket.id,
            {
              version: committed.version,
              sourceGeneration: committed.sourceGeneration,
              serverTimestamp: committed.serverTimestamp,
            },
          );
          roomStateService.setPlayback(payload.roomId, authoritative);
          socket.to(payload.roomId).emit('watch-together-control', {
            action: payload.action,
            value: transition.result.value,
            version: authoritative.version,
            sourceGeneration: authoritative.sourceGeneration,
            serverTimestamp: authoritative.serverTimestamp,
            state: authoritative,
          });
          safeAck(callback, {
            success: true,
            data: { state: authoritative, version: authoritative.version, sourceGeneration: authoritative.sourceGeneration, serverTimestamp: authoritative.serverTimestamp },
          });
        } catch (err) {
          console.error('[watch-together-control] error:', err);
          safeAck(callback, { success: false, message: '控制失败' });
        }
      });
    });

    socket.on('video-ready', async (payload: unknown, callback?: AckCallback) => {
      try {
        const value = payload as { roomId?: unknown; sourceGeneration?: unknown; requestId?: unknown };
        if (!validRoomId(value?.roomId) || !Number.isSafeInteger(value?.sourceGeneration)) {
          safeAck(callback, { success: false, code: 'INVALID_PAYLOAD', message: 'ready payload 无效' });
          return;
        }
        if (!(await roomPermissionService.isInRoom(socket, value.roomId))) {
          safeAck(callback, { success: false, code: 'FORBIDDEN', message: '不在该房间中' });
          return;
        }
        const roomId = value.roomId;
        const state = await playbackMemoryService.getRawPlayback(value.roomId);
        realtimeSyncCore.hydrate(value.roomId, state?.version, state?.sourceGeneration);
        if (!realtimeSyncCore.recordReadiness(value.roomId, socket.id, Number(value.sourceGeneration))) {
          safeAck(callback, { success: false, code: 'STALE_GENERATION', message: '旧 sourceGeneration 的 ready 已丢弃' });
          return;
        }
        const host = await roomSessionService.getSharer(value.roomId);
        if (host) {
          await emitToAuthorizedMember(io, value.roomId, host.socketId, 'video-ready', {
            roomId: value.roomId,
            from: socket.id,
            requestId: typeof value.requestId === 'string' ? value.requestId.slice(0, 128) : undefined,
            sourceGeneration: Number(value.sourceGeneration),
          }, async (target) => target.id === host.socketId && !!(await roomPermissionService.getActiveSharer(target, roomId)));
        }
        safeAck(callback, { success: true });
      } catch {
        safeAck(callback, { success: false, message: 'ready 处理失败' });
      }
    });

    socket.on('disconnect', () => realtimeSyncCore.clearSocket(socket.id));
  }
}
