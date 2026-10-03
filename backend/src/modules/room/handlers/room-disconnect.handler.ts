/**
 * 房间断线事件处理器。
 *
 * 处理 socket 断开连接事件，区分房主与观众两种角色分别处理：
 * - 房主断开：由 roomExperienceService 在房间锁内复核当前主持人，
 *   必要时清空 hostSocketId 并启动 30 秒代理计时，房间保留与房主离线无关
 * - 观众断开：广播 viewer-left（统一使用 viewerSocketId 字段）
 *
 * 消除旧架构中 routes/room.ts 内联的 disconnect 处理逻辑。
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { SocketEventHandler } from '../../socket';
import { roomSessionService } from '../room-session.service';
import { roomExperienceService } from '../room-experience.service';
import { viewerService } from '../../viewer/viewer.service';

/**
 * 房间断线事件处理器。
 */
export class RoomDisconnectHandler implements SocketEventHandler {
  readonly name = 'room-disconnect';

  register(socket: Socket, io: SocketIOServer): void {
    socket.on('disconnect', (reason: string) => {
      viewerService.clearPendingSocket(socket.id);
      if (socket.data.isCliAgent) {
        console.log(`[cli] socket disconnected: ${socket.id}, reason: ${reason}`);
      }
      void (async () => {
        try {
        // 结束当前 socket 的活跃 session（可能是 sharer 或 viewer）
        const session = await roomSessionService.endSession(socket.id);
        if (!session) return;

        if (session.role === 'sharer') {
          // A transfer may have completed after endSession read the old role.
          // Send viewer departure when the old host has already been replaced.
          // Host authority is rechecked under the room lock by memberLeft.
          const currentSharer = await roomSessionService.getSharer(session.roomId);
          if (currentSharer && currentSharer.socketId !== socket.id) {
            io.to(session.roomId).emit('viewer-left', {
              viewerSocketId: socket.id,
            });
          }
        } else {
          // 观众断开：广播 viewer-left（统一使用 viewerSocketId 字段，修复旧架构不一致问题）
          io.to(session.roomId).emit('viewer-left', {
            viewerSocketId: socket.id,
          });
        }
        await roomExperienceService.memberLeft(io, session.roomId, socket.id, session.role === 'sharer');
      } catch (err) {
        console.error('[disconnect] handler error:', err);
      }
      })();
    });
  }
}
