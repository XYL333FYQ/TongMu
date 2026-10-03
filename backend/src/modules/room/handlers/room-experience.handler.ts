import type { Server, Socket } from 'socket.io';
import type { AckCallback, SocketEventHandler } from '../../socket';
import { safeAck } from '../../socket';
import { isBoundedIdentifier } from '../../realtime-sync-core';
import { roomExperienceService } from '../room-experience.service';
import { roomSessionService } from '../room-session.service';
import { roomPermissionService } from '../room-permission.service';
import { roomScreenPresenters } from '../room-policy';
import { realtimeSyncCore } from '../../realtime-sync-core';

export class RoomExperienceHandler implements SocketEventHandler {
  readonly name = 'room-experience';
  register(socket: Socket, io: Server): void {
    const register = (event: string, operation: (payload: Record<string, unknown>, roomId: string) => Promise<unknown>) => {
      socket.on(event, (payload: unknown, callback?: AckCallback) => {
        void (async () => {
          if (!payload || typeof payload !== 'object' || !isBoundedIdentifier((payload as Record<string, unknown>).roomId, 128)) throw new Error('房间编号无效');
          const p = payload as Record<string, unknown>;
          const data = await operation(p, p.roomId as string);
          safeAck(callback, { success: true, data });
        })().catch(error => safeAck(callback, { success: false, message: error instanceof Error ? error.message : '房间操作失败' }));
      });
    };
    register('room:experience:get', (_p, id) => roomExperienceService.snapshot(socket, id, io));
    register('room:activity:switch', (p, id) => roomExperienceService.switchActivity(socket, io, id, p.activity));
    register('room:activity:request', (p, id) => roomExperienceService.requestActivity(socket, io, id, p.activity));
    register('room:activity:resolve', (p, id) => roomExperienceService.resolveRequest(socket, io, id, String(p.requestId), p.decision));
    register('room:activity:vote', (p, id) => roomExperienceService.vote(socket, io, id, String(p.pollId), p.value));
    register('room:content:suggest', (p, id) => roomExperienceService.suggestContent(socket, io, id, p.content));
    register('room:content:resolve', (p, id) => roomExperienceService.resolveContent(socket, io, id, String(p.suggestionId), p.accepted));
    register('room:screen:stop', async (_p, id) => {
      await realtimeSyncCore.withRoomLock(id, async () => {
        const permission = await roomPermissionService.canPerform(socket, id, 'screen.start');
        if (!permission.allowed) throw new Error(permission.reason);
        roomScreenPresenters.delete(id);
        io.to(id).emit('room:stop-screen', { roomId: id });
      });
      await roomExperienceService.broadcast(io, id);
    });
    register('room:leave', async (_p, id) => {
      if (!(await roomPermissionService.isInRoom(socket, id))) throw new Error('不在该房间中');
      const session = await roomSessionService.endSession(socket.id);
      if (!session || session.roomId !== id) throw new Error('不在该房间中');
      await socket.leave(id);
      io.to(id).emit('viewer-left', { viewerSocketId: socket.id });
      await roomExperienceService.memberLeft(io, id, socket.id, session.role === 'sharer');
    });
  }
}
