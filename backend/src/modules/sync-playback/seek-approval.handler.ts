/** Viewer control request/response primitive for the video domain. */
import { randomUUID } from 'node:crypto';
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { AckCallback, SocketEventHandler } from '../socket';
import { safeAck } from '../socket';
import { roomPermissionService } from '../room/room-permission.service';
import { roomSessionService } from '../room/room-session.service';
import { emitToAuthorizedMember } from '../realtime-sync-core';
import { playbackMemoryService } from '../playback-memory';
import type {
  PauseRequestPayload,
  PauseResponsePayload,
  PlayRequestPayload,
  PlayResponsePayload,
  SeekRequestPayload,
  SeekResponsePayload,
} from '../shared/dto';

const REQUEST_TTL_MS = 30_000;
type RequestKind = 'seek' | 'pause' | 'play';
interface PendingRequest {
  requestId: string;
  kind: RequestKind;
  roomId: string;
  viewerSocketId: string;
  hostSocketId: string;
  sourceGeneration?: number;
  version?: number;
  expiresAt: number;
}

const pendingRequests = new Map<string, PendingRequest>();

function cleanupRequests(now = Date.now()): void {
  for (const [id, request] of pendingRequests) {
    if (request.expiresAt <= now) pendingRequests.delete(id);
  }
}

function validRoomId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128;
}

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 7 * 24 * 60 * 60;
}

export class SeekApprovalHandler implements SocketEventHandler {
  readonly name = 'SeekApprovalHandler';

  register(socket: Socket, io: SocketIOServer): void {
    const forward = async (
      kind: RequestKind,
      roomId: unknown,
      time: unknown,
      event: string,
      callback?: AckCallback,
    ): Promise<void> => {
      cleanupRequests();
      if (!validRoomId(roomId) || (kind === 'seek' && !validTime(time))) {
        safeAck(callback, { success: false, code: 'INVALID_PAYLOAD', message: '请求 payload 无效' });
        return;
      }
      if (!(await roomPermissionService.isInRoom(socket, roomId))) {
        safeAck(callback, { success: false, code: 'FORBIDDEN', message: '不在该房间中' });
        return;
      }
      const host = await roomSessionService.getSharer(roomId);
      if (!host) {
        safeAck(callback, { success: false, code: 'HOST_OFFLINE', message: '房主不在线' });
        return;
      }
      const requestId = randomUUID();
      const rawState = await playbackMemoryService.getRawPlayback(roomId);
      const request: PendingRequest = {
        requestId,
        kind,
        roomId,
        viewerSocketId: socket.id,
        hostSocketId: host.socketId,
        sourceGeneration: rawState?.sourceGeneration,
        version: rawState?.version,
        expiresAt: Date.now() + REQUEST_TTL_MS,
      };
      pendingRequests.set(requestId, request);
      const outgoing = {
        roomId,
        requestId,
        viewerSocketId: socket.id,
        viewerUsername: typeof socket.data?.username === 'string' ? socket.data.username.slice(0, 128) : '未知用户',
        time: kind === 'seek' ? time : undefined,
        sourceGeneration: request.sourceGeneration,
        version: request.version,
        expiresAt: request.expiresAt,
      };
      const emitted = await emitToAuthorizedMember(
        io,
        roomId,
        host.socketId,
        event,
        outgoing,
        async (target) => target.id === host.socketId && !!(await roomPermissionService.getActiveSharer(target, roomId)),
      );
      if (!emitted) pendingRequests.delete(requestId);
      safeAck(callback, emitted ? { success: true, data: { requestId, expiresAt: request.expiresAt } } : { success: false, message: '房主已离线' });
    };

    const respond = async (
      kind: RequestKind,
      payload: { roomId?: unknown; viewerSocketId?: unknown; requestId?: unknown; accept?: unknown; time?: unknown },
      event: string,
      callback?: AckCallback,
    ): Promise<void> => {
      cleanupRequests();
      if (!validRoomId(payload?.roomId) || typeof payload?.accept !== 'boolean') {
        safeAck(callback, { success: false, code: 'INVALID_PAYLOAD', message: '回应 payload 无效' });
        return;
      }
      const permission = await roomPermissionService.canPerform(socket, payload.roomId, 'playback.play');
      if (!permission.allowed) {
        safeAck(callback, { success: false, code: 'FORBIDDEN', message: permission.reason });
        return;
      }
      let request: PendingRequest | undefined;
      if (typeof payload.requestId === 'string') request = pendingRequests.get(payload.requestId);
      if (!request && typeof payload.viewerSocketId === 'string') {
        request = Array.from(pendingRequests.values()).reverse().find((item) =>
          item.kind === kind && item.roomId === payload.roomId && item.viewerSocketId === payload.viewerSocketId,
        );
      }
      if (!request || request.roomId !== payload.roomId || request.kind !== kind || request.hostSocketId !== socket.id || request.expiresAt <= Date.now()) {
        safeAck(callback, { success: false, code: 'INVALID_REQUEST', message: '请求不存在或已过期' });
        return;
      }
      if (kind === 'seek' && payload.accept && !validTime(payload.time)) {
        safeAck(callback, { success: false, code: 'INVALID_PAYLOAD', message: 'seek time 无效' });
        return;
      }
      const target = io.sockets.sockets.get(request.viewerSocketId);
      const emitted = target ? await emitToAuthorizedMember(
        io,
        request.roomId,
        request.viewerSocketId,
        event,
        {
          requestId: request.requestId,
          accept: payload.accept,
          time: kind === 'seek' ? payload.time : undefined,
          sourceGeneration: request.sourceGeneration,
          version: request.version,
        },
        async (candidate) => candidate.id === target.id && !!(await roomPermissionService.isInRoom(candidate, request!.roomId)),
      ) : false;
      pendingRequests.delete(request.requestId);
      safeAck(callback, emitted ? { success: true } : { success: false, code: 'TARGET_OFFLINE', message: '申请者已离开房间' });
    };

    socket.on('seek-request', (payload: SeekRequestPayload, callback?: AckCallback) => {
      void forward('seek', payload?.roomId, payload?.time, 'seek-request', callback).catch(() => safeAck(callback, { success: false, message: '申请跳转失败' }));
    });
    socket.on('seek-response', (payload: SeekResponsePayload, callback?: AckCallback) => {
      void respond('seek', payload, 'seek-response', callback).catch(() => safeAck(callback, { success: false, message: '回应失败' }));
    });
    socket.on('pause-request', (payload: PauseRequestPayload, callback?: AckCallback) => {
      void forward('pause', payload?.roomId, undefined, 'pause-request', callback).catch(() => safeAck(callback, { success: false, message: '申请暂停失败' }));
    });
    socket.on('pause-response', (payload: PauseResponsePayload, callback?: AckCallback) => {
      void respond('pause', payload, 'pause-response', callback).catch(() => safeAck(callback, { success: false, message: '回应失败' }));
    });
    socket.on('play-request', (payload: PlayRequestPayload, callback?: AckCallback) => {
      void forward('play', payload?.roomId, undefined, 'play-request', callback).catch(() => safeAck(callback, { success: false, message: '申请继续播放失败' }));
    });
    socket.on('play-response', (payload: PlayResponsePayload, callback?: AckCallback) => {
      void respond('play', payload, 'play-response', callback).catch(() => safeAck(callback, { success: false, message: '回应失败' }));
    });
  }
}
