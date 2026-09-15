/**
 * 心跳事件处理器。
 *
 * 处理 host-heartbeat：房主定时广播的轻量心跳（currentTime + isPlaying + playbackRate + suppressed），
 * 后端转发给房间内其他成员，观众端据此重置"房主离线"计时器、同步倍速与存活检测。
 *
 * 修复说明：前端 useHostHeartbeat 每 2s emit 'host-heartbeat'，观众端
 * useViewerHeartbeat 监听该事件重置离线计时器。若后端不转发，观众 6s 内
 * 必然收不到心跳而误报"房主已离线"并暂停播放。
 *
 * 心跳为轻量事件，不校验 room.mode（screen-share 模式下房主同样需要广播心跳
 * 给观众端做存活检测）；仅校验发送者为活跃 sharer。
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { AckCallback, SocketEventHandler } from '../socket';
import { safeAck } from '../socket';
import { roomPermissionService } from '../room/room-permission.service';
import { playbackMemoryService } from '../playback-memory';
import type { HeartbeatPayload } from '../shared/dto';
import { realtimeSyncCore } from '../realtime-sync-core';
import { VideoSyncDomain } from './video-sync.domain';

export class HeartbeatHandler implements SocketEventHandler {
  readonly name = 'HeartbeatHandler';

  register(socket: Socket, io: SocketIOServer): void {
    socket.on(
      'host-heartbeat',
      async (payload: HeartbeatPayload, callback?: AckCallback) => {
        try {
          if (!VideoSyncDomain.validateHeartbeat(payload) || typeof payload?.roomId !== 'string' || payload.roomId.length === 0 || payload.roomId.length > 128) {
            return safeAck(callback, { success: false, code: 'INVALID_PAYLOAD', message: '心跳 payload 无效' });
          }
          const permission = await roomPermissionService.canPerform(socket, payload.roomId, 'playback.play');
          if (!permission.allowed) {
            return safeAck(callback, {
                success: false,
              code: 'FORBIDDEN',
              message: permission.reason,
            });
          }
          const current = await playbackMemoryService.getRawPlayback(payload.roomId);
          realtimeSyncCore.hydrate(payload.roomId, current?.version, current?.sourceGeneration, current?.serverTimestamp ?? current?.updatedAt);
          if (payload.sourceGeneration !== undefined && payload.sourceGeneration !== (current?.sourceGeneration ?? realtimeSyncCore.current(payload.roomId).sourceGeneration)) {
            return safeAck(callback, { success: false, code: 'STALE_GENERATION', message: '旧 sourceGeneration 的心跳已丢弃' });
          }

          // 心跳落盘（10s 节流，service 内部控制）：房主连续播放期间没有
          // 离散 state 事件，外推基线会逐渐陈旧；心跳携带真实 currentTime，
          // 合并进播放记忆后房主断线的服务器外推与恢复进度不再超前。
          // 不 await：落盘失败不应阻塞心跳转发。
          void playbackMemoryService
            .applyHostHeartbeat(payload.roomId, {
              currentTime: payload.currentTime,
              isPlaying: payload.isPlaying,
              playbackRate: payload.playbackRate,
            })
            .catch((err) => {
              console.error('[host-heartbeat] applyHostHeartbeat error:', err);
            });

          const state = await playbackMemoryService.getAdvancedPlayback(payload.roomId);
          const metadata = state ? {
            version: state.version,
            sourceGeneration: state.sourceGeneration,
            serverTimestamp: state.serverTimestamp ?? state.updatedAt,
          } : realtimeSyncCore.current(payload.roomId);
          // 转发心跳给房间内其他成员（不含发送者、不含 roomId）
          // 保留旧事件兼容已连接客户端
          socket.to(payload.roomId).emit('host-heartbeat', {
            currentTime: payload.currentTime,
            isPlaying: payload.isPlaying,
            playbackRate: payload.playbackRate,
            suppressed: payload.suppressed,
            ...metadata,
          });
          // 统一心跳协议（#14）：新增 sync-heartbeat 事件，viewer 端按 source 字段区分
          socket.to(payload.roomId).emit('sync-heartbeat', {
            source: 'host',
            currentTime: payload.currentTime,
            isPlaying: payload.isPlaying,
            playbackRate: payload.playbackRate,
            suppressed: payload.suppressed,
            ...metadata,
          });
          safeAck(callback, { success: true });
        } catch (err) {
          console.error('[host-heartbeat] error:', err);
          safeAck(callback, { success: false, message: '心跳转发失败' });
        }
      },
    );
  }
}
