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
 * 仅当前视频活动的主持者发布连续状态；共同参与者使用有版本校验的离散操作。
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
        if (typeof payload?.roomId !== 'string' || !payload.roomId || payload.roomId.length > 128) return safeAck(callback, { success: false, message: 'Invalid room ID.' });
        await realtimeSyncCore.withRoomLock(payload.roomId, async () => {
        try {
          if (!VideoSyncDomain.validateHeartbeat(payload) || typeof payload?.roomId !== 'string' || payload.roomId.length === 0 || payload.roomId.length > 128) {
            return safeAck(callback, { success: false, code: 'INVALID_PAYLOAD', message: '心跳 payload 无效' });
          }
          if (!(await roomPermissionService.isRoomHost(socket, payload.roomId)) || !(await roomPermissionService.isWatchTogetherRoom(payload.roomId))) {
            return safeAck(callback, {
                success: false,
              code: 'FORBIDDEN',
              message: 'Only the active watch host may publish playback heartbeats.',
            });
          }
          const current = await playbackMemoryService.getRawPlayback(payload.roomId);
          if (payload.version !== undefined && payload.version !== current?.version) return safeAck(callback, { success: false, code: 'STALE_VERSION', message: 'This heartbeat is based on an old playback state.' });
          realtimeSyncCore.hydrate(payload.roomId, current?.version, current?.sourceGeneration, current?.serverTimestamp ?? current?.updatedAt);
          if (payload.sourceGeneration !== undefined && payload.sourceGeneration !== (current?.sourceGeneration ?? realtimeSyncCore.current(payload.roomId).sourceGeneration)) {
            return safeAck(callback, { success: false, code: 'STALE_GENERATION', message: '旧 sourceGeneration 的心跳已丢弃' });
          }

          // 心跳落盘（10s 节流，service 内部控制）：房主连续播放期间没有
          // 离散 state 事件，外推基线会逐渐陈旧；心跳携带真实 currentTime，
          // 合并进播放记忆后房主断线的服务器外推与恢复进度不再超前。
          // 在同一房间锁内完成更新，避免活动切换或成员操作与心跳交错。
          await playbackMemoryService
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
        });
      },
    );
  }
}
