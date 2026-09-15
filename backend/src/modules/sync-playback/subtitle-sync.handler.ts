/**
 * 字幕状态同步处理器。
 *
 * 处理 subtitle-update：房主加载/切换/开关字幕时下发，后端转发给房间内其他成员。
 * payload 含完整的轨道数据（tracks + cues），观众端 useSubtitles 监听同一事件
 * 并直接合并到本地状态，实现字幕实时同步。
 *
 * 此 handler 修复了前端 emit subtitle-update 但后端从不转发的 bug：
 * socket.io 不会自动广播客户端 emit 的事件，必须由服务端显式转发。
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import type { AckCallback, SocketEventHandler } from '../socket';
import { safeAck } from '../socket';
import { roomPermissionService } from '../room/room-permission.service';
import { roomStateService } from '../room/room-state.service';
import { playbackMemoryService } from '../playback-memory';
import { realtimeSyncCore } from '../realtime-sync-core';

export class SubtitleSyncHandler implements SocketEventHandler {
  readonly name = 'SubtitleSyncHandler';

  register(socket: Socket, _io: SocketIOServer): void {
    socket.on(
      'subtitle-update',
      async (payload: unknown, callback?: AckCallback) => {
        try {
          const data = payload as { roomId?: unknown; sourceGeneration?: unknown; tracks?: unknown; enabled?: unknown } | undefined;
          if (typeof data?.roomId !== 'string' || data.roomId.length === 0 || data.roomId.length > 128 ||
            (data.tracks !== undefined && (!Array.isArray(data.tracks) || data.tracks.length > 64))) {
            return safeAck(callback, {
                success: false,
              code: 'INVALID_PAYLOAD',
              message: '字幕 payload 无效',
            });
          }

          const permission = await roomPermissionService.canPerform(socket, data.roomId, 'subtitle.change');
          if (!permission.allowed) {
            return safeAck(callback, {
                success: false,
              code: 'FORBIDDEN',
              message: permission.reason,
            });
          }
          if (data.sourceGeneration !== undefined && (typeof data.sourceGeneration !== 'number' || !Number.isSafeInteger(data.sourceGeneration) || data.sourceGeneration < 0)) {
            return safeAck(callback, { success: false, code: 'INVALID_PAYLOAD', message: 'sourceGeneration 无效' });
          }
          const current = await playbackMemoryService.getRawPlayback(data.roomId);
          realtimeSyncCore.hydrate(data.roomId, current?.version, current?.sourceGeneration, current?.serverTimestamp ?? current?.updatedAt);
          const currentMeta = realtimeSyncCore.current(data.roomId);
          if (data.sourceGeneration !== undefined && data.sourceGeneration !== currentMeta.sourceGeneration) {
            return safeAck(callback, { success: false, code: 'STALE_GENERATION', message: '旧 sourceGeneration 的字幕事件已丢弃' });
          }
          const payloadObject = (payload && typeof payload === 'object') ? { ...(payload as Record<string, unknown>) } : {};
          delete payloadObject.roomId;
          const committed = realtimeSyncCore.commit(data.roomId, {
            sourceGeneration: typeof data.sourceGeneration === 'number' ? data.sourceGeneration : undefined,
            baseVersion: typeof payloadObject.baseVersion === 'number' ? payloadObject.baseVersion : undefined,
            mutationId: typeof payloadObject.mutationId === 'string' ? payloadObject.mutationId : undefined,
            clientTimestamp: typeof payloadObject.clientTimestamp === 'number' ? payloadObject.clientTimestamp : undefined,
          });
          if (!committed.ok) return safeAck(callback, { success: false, code: committed.code, message: committed.message });
          const event = { ...payloadObject, roomId: data.roomId, version: committed.version, sourceGeneration: committed.sourceGeneration, serverTimestamp: committed.serverTimestamp };

          // 缓存最近一次字幕状态：观众中途加入/刷新时补发，
          // 否则观众只能在房主下次变更字幕时才收到（加入前已加载的字幕无法同步）
          roomStateService.setSubtitle(data.roomId, event);

          // 转发给房间内其他成员（不含发送者，房主本地状态已是最新）
          socket.to(data.roomId).emit('subtitle-update', event);
          safeAck(callback, { success: true, data: event });
        } catch (err) {
          console.error('[subtitle-update] error:', err);
          safeAck(callback, { success: false, message: '字幕状态转发失败' });
        }
      },
    );

    // 观众挂载字幕监听器后主动拉取：加入时立即回发的 subtitle-update
    // 早于观众前端 useEffect 挂载而丢失，此处回发房主缓存的当前状态。
    socket.on('subtitle-request', (payload: unknown) => {
      try {
        const data = payload as { roomId?: string } | undefined;
        if (!data?.roomId) return;
        const cached = roomStateService.getSubtitle(data.roomId);
        if (cached != null) {
          socket.emit('subtitle-update', cached);
        }
      } catch (err) {
        console.error('[subtitle-request] error:', err);
      }
    });
  }
}
