/**
 * 房间设置事件处理器。
 *
 * 处理房间名称、模式、运行时设置、P2P 模式切换等事件。
 * 消除旧架构中 routes/room.ts 与 index.ts 内联的 update-room-* 逻辑。
 *
 * 权限规则：
 * - update-room-name：仅 root 或房间 owner
 * - update-room-mode / update-room-settings：仅 sharer
 * - p2p-mode-change：校验在房间内即可（房主或观众均可）
 */
import type { Server as SocketIOServer, Socket } from 'socket.io';
import bcrypt from 'bcryptjs';
import { AppDataSource } from '../../../data-source';
import { Room } from '../../../entities/Room';
import {
  type AckCallback,
  type SocketEventHandler,
  safeAck,
} from '../../socket';
import { isBoundedIdentifier } from '../../realtime-sync-core';
import { roomPermissionService } from '../room-permission.service';
import { roomExperienceService } from '../room-experience.service';
import { validateRoomPolicy } from '../room-policy';
import { getRoomCover } from '../room-cover';
import { realtimeSyncCore } from '../../realtime-sync-core';

/** update-room-name 事件 payload */
interface UpdateRoomNamePayload {
  roomId: string;
  name: string;
}

/** update-room-mode 事件 payload */
interface UpdateRoomModePayload {
  roomId: string;
  mode: 'screen-share' | 'watch-together';
}

/** update-room-settings 事件 payload */
interface UpdateRoomSettingsPayload {
  roomId: string;
  name?: string;
  password?: string | null;
  maxViewers?: number;
  requireApproval?: boolean;
  policy?: unknown;
}

/** p2p-mode-change 事件 payload */
interface P2pModeChangePayload {
  roomId: string;
  enabled: boolean;
}

/**
 * 房间设置事件处理器。
 */
export class RoomSettingsHandler implements SocketEventHandler {
  readonly name = 'room-settings';

  register(socket: Socket, io: SocketIOServer): void {
    // --- 修改房间名称：仅 root 或房间 owner ---
    socket.on(
      'update-room-name',
      async (payload: UpdateRoomNamePayload, callback: AckCallback) => {
        try {
          if (!payload || !isBoundedIdentifier(payload.roomId, 128) || typeof payload.name !== 'string' || payload.name.length > 120) {
            return safeAck(callback, { success: false, code: 'INVALID_PAYLOAD', message: '房间名称 payload 无效' });
          }
          await realtimeSyncCore.withRoomLock(payload.roomId, async () => {
            const permission = await roomPermissionService.canPerform(socket, payload.roomId, 'room.settings');
            if (!permission.allowed) {
              return safeAck(callback, {
                success: false,
                message: permission.reason,
              });
            }
            const roomRepo = AppDataSource.getRepository(Room);
            const room = await roomRepo.findOneBy({ roomId: payload.roomId });
            if (!room) {
              return safeAck(callback, { success: false, message: '房间不存在' });
            }

            const trimmed = payload.name?.trim();
            if (!trimmed) {
              return safeAck(callback, { success: false, message: '房间名称不能为空' });
            }

            await roomRepo.update({ roomId: payload.roomId }, { name: trimmed });

            // 广播给房间内所有成员
            io.to(payload.roomId).emit('room-name-updated', {
              roomId: payload.roomId,
              name: trimmed,
          });

          return safeAck(callback, { success: true });
          });
        } catch (err) {
          console.error('[update-room-name] error:', err);
          return safeAck(callback, { success: false, message: '修改房间名称失败' });
        }
      },
    );

    // --- 修改房间模式：仅 sharer ---
    socket.on(
      'update-room-mode',
      async (payload: UpdateRoomModePayload, callback: AckCallback) => {
        try {
          const permission = await roomPermissionService.canPerform(socket, payload.roomId, 'room.settings');
          if (!permission.allowed) {
            return safeAck(callback, {
              success: false,
              message: '无权限切换房间模式',
            });
          }

          const roomRepo = AppDataSource.getRepository(Room);
          const room = await roomRepo.findOneBy({ roomId: payload.roomId });
          if (!room) {
            return safeAck(callback, { success: false, message: '房间不存在' });
          }

          if (!['screen-share', 'watch-together'].includes(payload.mode)) throw new Error('房间模式无效');
          await roomExperienceService.switchActivity(socket, io, payload.roomId, payload.mode === 'screen-share' ? 'screen' : 'watch');

          return safeAck(callback, {
            success: true,
            data: { mode: payload.mode },
          });
        } catch (err) {
          console.error('[update-room-mode] error:', err);
          return safeAck(callback, { success: false, message: '切换房间模式失败' });
        }
      },
    );

    // --- 修改房间运行时设置：仅 sharer ---
    socket.on(
      'update-room-settings',
      async (payload: UpdateRoomSettingsPayload, callback: AckCallback) => {
        if (!payload || !isBoundedIdentifier(payload.roomId, 128) ||
          (payload.name !== undefined && (typeof payload.name !== 'string' || !payload.name.trim() || payload.name.length > 120)) ||
          (payload.password !== undefined && payload.password !== null && (typeof payload.password !== 'string' || payload.password.length > 128))) {
          return safeAck(callback, { success: false, message: '房间设置无效' });
        }
        await realtimeSyncCore.withRoomLock(payload.roomId, async () => {
        try {
          const permission = await roomPermissionService.canPerform(socket, payload.roomId, 'room.settings');
          if (!permission.allowed) {
            return safeAck(callback, {
              success: false,
              message: '无权限：仅房主可修改房间设置',
            });
          }

          const roomRepo = AppDataSource.getRepository(Room);
          const room = await roomRepo.findOneBy({ roomId: payload.roomId });
          if (!room) {
            return safeAck(callback, { success: false, message: '房间不存在' });
          }

          if (payload.name !== undefined) room.name = payload.name.trim();
          // 密码：trim 后为空字符串则清空，否则 bcrypt 加密
          if (typeof payload.password === 'string') {
            const trimmed = payload.password.trim();
            room.password = trimmed ? await bcrypt.hash(trimmed, 10) : null;
          }
          if (typeof payload.maxViewers === 'number') {
            if (!Number.isInteger(payload.maxViewers) || payload.maxViewers < 1 || payload.maxViewers > 100) {
              return safeAck(callback, {
                success: false,
                message: '观众上限必须在 1-100 之间',
              });
            }
            room.maxViewers = payload.maxViewers;
          }
          if (typeof payload.requireApproval === 'boolean') {
            room.requireApproval = payload.requireApproval;
          }
          if (payload.policy !== undefined) room.policyJson = JSON.stringify({
            ...validateRoomPolicy(payload.policy),
            // Covers are changed by the upload endpoint, never by a stale draft.
            coverUrl: getRoomCover(room.policyJson),
          });
          await roomRepo.save(room);
          if (payload.name !== undefined) io.to(payload.roomId).emit('room-name-updated', { roomId: payload.roomId, name: room.name });
          roomPermissionService.invalidatePermissionCache(undefined, payload.roomId);

          // 广播给房间内所有成员，前端 roomStore 同步
          io.to(payload.roomId).emit('room-settings-updated', {
            password: room.password ? 'configured' : null,
            hasPassword: !!room.password,
            maxViewers: room.maxViewers,
            requireApproval: room.requireApproval,
          });
          await roomExperienceService.broadcast(io, payload.roomId);

          return safeAck(callback, { success: true });
        } catch (err) {
          console.error('[update-room-settings] error:', err);
          return safeAck(callback, { success: false, message: '修改房间设置失败' });
        }
        });
      },
    );

    // --- P2P 模式切换：校验在房间内即可 ---
    socket.on(
      'p2p-mode-change',
      async (payload: P2pModeChangePayload, callback: AckCallback) => {
        try {
          if (!(await roomPermissionService.isInRoom(socket, payload.roomId))) {
            return safeAck(callback, { success: false, message: '不在该房间中' });
          }
          // 广播给房间内其他成员
          socket.to(payload.roomId).emit('p2p-mode-change', {
            roomId: payload.roomId,
            enabled: payload.enabled,
          });
          return safeAck(callback, { success: true });
        } catch (err) {
          console.error('[p2p-mode-change] error:', err);
          return safeAck(callback, { success: false, message: '广播 P2P 模式失败' });
        }
      },
    );
  }
}
