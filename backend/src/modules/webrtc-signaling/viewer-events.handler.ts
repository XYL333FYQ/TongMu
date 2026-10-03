/**
 * 观众就绪事件处理器。
 *
 * 职责：
 * - viewer-ready：观众就绪通知房主 + 推送影片列表
 * - sharer-ready：房主开始共享时广播通知观众重发 viewer-ready
 *
 * 设计：实现 SocketEventHandler 接口，由 SocketRegistry 统一注册。
 * 迁移自 services/screen-sharing/viewer-events.ts。
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../../data-source';
import { Session } from '../../entities/Session';
import { roomStateService } from '../room/room-state.service';
import { roomPermissionService } from '../room/room-permission.service';
import { Room } from '../../entities/Room';
import { roomScreenPresenters, roomDelegates } from '../room/room-policy';
import { roomExperienceService } from '../room/room-experience.service';
import { realtimeSyncCore } from '../realtime-sync-core';
import type { SocketEventHandler } from '../socket';

export class ViewerEventsHandler implements SocketEventHandler {
  readonly name = 'webrtc-viewer-events';

  register(socket: Socket, io: SocketIOServer): void {
    // --- 观众就绪：通知房主可以开始推送流 ---
    socket.on(
      'viewer-ready',
      async (
        payload: { roomId: string },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          if (!socket.rooms.has(payload.roomId)) {
            return callback?.({ success: false, message: '不在该房间中' });
          }

          const sessionRepo = AppDataSource.getRepository(Session);
          const sharer = await sessionRepo.findOneBy({
            roomId: payload.roomId,
            role: 'sharer',
            endedAt: IsNull(),
          });
          const presenterId = roomScreenPresenters.get(payload.roomId) ?? roomDelegates.get(payload.roomId) ?? sharer?.socketId;
          if (!presenterId) {
            return callback?.({ success: false, message: '分享端不在线' });
          }

          console.log(
            `[viewer-ready] forward from viewer=${socket.id} to sharer=${presenterId} room=${payload.roomId}`,
          );
          io.to(presenterId).emit('viewer-ready', {
            from: socket.id,
          });

          // 推送影片列表与当前影片
          io.to(socket.id).emit('movie-list', {
            movies: roomStateService.getMovies(payload.roomId),
          });
          io.to(socket.id).emit('current-movie', {
            movieId: roomStateService.getCurrentMovieId(payload.roomId),
          });

          callback?.({ success: true });
        } catch (err) {
          console.error('[viewer-ready] error:', err);
          callback?.({ success: false, message: '处理失败' });
        }
      },
    );

    // --- 房主共享就绪：通知房间内所有观众重新发送 viewer-ready ---
    socket.on(
      'sharer-ready',
      async (
        payload: { roomId: string },
        callback?: (response: { success: boolean; message?: string }) => void,
      ) => {
        try {
          await realtimeSyncCore.withRoomLock(payload.roomId, async () => {
            const permission = await roomPermissionService.canPerform(socket, payload.roomId, 'screen.start');
            if (!permission.allowed) throw new Error(permission.reason);
            const room = await AppDataSource.getRepository(Room).findOneBy({ roomId: payload.roomId, status: 'active' });
            if (!room || room.activity !== 'screen') throw new Error('Switch to Screen before sharing.');
            const presenter = roomScreenPresenters.get(payload.roomId);
            if (presenter && presenter !== socket.id) throw new Error('Someone is already sharing. Ask them to stop first.');
            roomScreenPresenters.set(payload.roomId, socket.id);
          });

          console.log(
            `[sharer-ready] broadcast from sharer=${socket.id} to room=${payload.roomId}`,
          );
          socket.to(payload.roomId).emit('sharer-ready', {
            roomId: payload.roomId,
          });
          await roomExperienceService.broadcast(io, payload.roomId);

          callback?.({ success: true });
        } catch (err) {
          console.error('[sharer-ready] error:', err);
          callback?.({ success: false, message: err instanceof Error ? err.message : 'Could not start sharing.' });
        }
      },
    );
  }
}
