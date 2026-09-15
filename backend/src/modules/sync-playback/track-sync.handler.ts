/**
 * 弹幕/字幕轨道事件处理器。
 *
 * 处理 track-change：房主切换弹幕/字幕轨道时下发，后端转发给房间内其他成员。
 * - type='danmaku'：value 为弹幕轨道 ID（string）或 null（关闭弹幕）
 * - type='subtitle'：value 为字幕轨道索引（number）或 null（关闭字幕）
 *
 * 修复说明：前端 useTrackSync 合并了旧版 danmaku-track-change 与
 * subtitle-track-change 为统一的 track-change 事件（按 type 字段区分）。
 * 旧版两个独立事件后端从未实现转发 handler，导致弹幕/字幕轨道同步失效。
 * 此 handler 同时修复了这两个 bug。
 *
 * 轨道切换为播放控制语义，仅 watch-together 模式有意义；但旧版未校验模式也未
 * 转发，此处主要修复转发缺失问题，模式校验由前端按需处理。
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { AckCallback, SocketEventHandler } from '../socket';
import { safeAck } from '../socket';
import { roomPermissionService } from '../room/room-permission.service';
import type { TrackChangePayload } from '../shared/dto';
import { realtimeSyncCore } from '../realtime-sync-core';
import { playbackMemoryService } from '../playback-memory';

export class TrackSyncHandler implements SocketEventHandler {
  readonly name = 'TrackSyncHandler';

  register(socket: Socket, io: SocketIOServer): void {
    socket.on(
      'track-change',
      async (payload: TrackChangePayload, callback?: AckCallback) => {
        try {
          if (!payload || typeof payload.roomId !== 'string' || payload.roomId.length === 0 ||
            !['danmaku', 'subtitle'].includes(payload.type) ||
            (typeof payload.value !== 'string' && typeof payload.value !== 'number' && payload.value !== null) ||
            (typeof payload.value === 'string' && payload.value.length > 512) ||
            (typeof payload.value === 'number' && !Number.isSafeInteger(payload.value))) {
            return safeAck(callback, { success: false, code: 'INVALID_PAYLOAD', message: '轨道 payload 无效' });
          }
          const permission = await roomPermissionService.canPerform(socket, payload.roomId, 'subtitle.change');
          if (!permission.allowed) {
            return safeAck(callback, {
                success: false,
              code: 'FORBIDDEN',
              message: permission.reason,
            });
          }
          const current = await playbackMemoryService.getRawPlayback(payload.roomId);
          realtimeSyncCore.hydrate(payload.roomId, current?.version, current?.sourceGeneration, current?.serverTimestamp ?? current?.updatedAt);
          if (payload.sourceGeneration !== undefined && payload.sourceGeneration !== realtimeSyncCore.current(payload.roomId).sourceGeneration) {
            return safeAck(callback, { success: false, code: 'STALE_GENERATION', message: '旧 sourceGeneration 的轨道事件已丢弃' });
          }
          const committed = realtimeSyncCore.commit(payload.roomId, {
            baseVersion: payload.baseVersion,
            sourceGeneration: payload.sourceGeneration,
            mutationId: payload.mutationId,
            clientTimestamp: payload.clientTimestamp,
          });
          if (!committed.ok) return safeAck(callback, { success: false, code: committed.code, message: committed.message });
          const event = {
            type: payload.type,
            value: payload.value,
            version: committed.version,
            sourceGeneration: committed.sourceGeneration,
            serverTimestamp: committed.serverTimestamp,
          };

          // 转发给房间内其他成员，观众端 useTrackSync 按 payload.type 分发到对应订阅者
          socket.to(payload.roomId).emit('track-change', {
            ...event,
          });
          safeAck(callback, { success: true, data: event });
        } catch (err) {
          console.error('[track-change] error:', err);
          safeAck(callback, { success: false, message: '轨道切换转发失败' });
        }
      },
    );
  }
}
