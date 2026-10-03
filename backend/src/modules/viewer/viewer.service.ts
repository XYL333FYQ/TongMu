/**
 * 观众服务。
 *
 * 提供观众信息查询、踢出、禁言/解禁能力。
 *
 * 设计目的：
 * - 封装观众相关业务逻辑，供 handler 复用
 * - 不直接操作 Session 表，通过 roomSessionService 间接管理
 * - username 通过 socket.data 获取（JWT 中间件设置）
 */
import type { Server as SocketIOServer } from 'socket.io';
import { AppDataSource } from '../../data-source';
import { Room } from '../../entities/Room';
import { User } from '../../entities/User';
import type { ViewerDto } from '../shared';
import { roomSessionService } from '../room/room-session.service';

/**
 * 观众服务（单例）。
 */
export class ViewerService {
  private readonly pending = new Map<string, Map<string, number>>();
  addPendingRequest(roomId: string, socketId: string): void {
    const requests = this.pending.get(roomId) ?? new Map<string, number>();
    for (const [id, created] of requests) if (Date.now() - created > 15 * 60_000) requests.delete(id);
    if (requests.size >= 100 && !requests.has(socketId)) throw new Error('等待审核人数过多，请稍后重试');
    requests.set(socketId, Date.now());
    this.pending.set(roomId, requests);
  }
  hasPendingRequest(roomId: string, socketId: string): boolean {
    const created = this.pending.get(roomId)?.get(socketId);
    return created !== undefined && Date.now() - created < 15 * 60_000;
  }
  removePendingRequest(roomId: string, socketId: string): void {
    const requests = this.pending.get(roomId);
    requests?.delete(socketId);
    if (!requests?.size) this.pending.delete(roomId);
  }
  replayPendingRequests(io: SocketIOServer, roomId: string, hostId: string): void {
    for (const id of this.pending.get(roomId)?.keys() ?? []) {
      const candidate = io.sockets.sockets.get(id);
      if (!candidate?.connected || !this.hasPendingRequest(roomId, id)) { this.removePendingRequest(roomId, id); continue; }
      io.to(hostId).emit('join-request', { viewerSocketId: id, username: candidate.data.username });
    }
  }
  clearPendingRoom(roomId: string): void { this.pending.delete(roomId); }
  listPendingRequests(io: SocketIOServer, roomId: string): { socketId: string; username: string }[] {
    return [...(this.pending.get(roomId)?.keys() ?? [])].filter(id => this.hasPendingRequest(roomId, id) && io.sockets.sockets.get(id)?.connected).map(id => ({ socketId: id, username: String(io.sockets.sockets.get(id)?.data.username || 'Guest').slice(0, 40) }));
  }
  clearPendingSocket(socketId: string): void {
    for (const roomId of this.pending.keys()) this.removePendingRequest(roomId, socketId);
  }
  /**
   * 获取房间内所有在线观众信息（含 username）。
   *
   * 通过 socket.data 读取 userId / username / role（JWT 中间件设置）。
   * 若 socket 已断开或 data 缺失，从 User 表回查 username。
   *
   * @param io Socket.IO 服务实例
   * @param roomId 房间 ID
   */
  async getOnlineViewers(
    io: SocketIOServer,
    roomId: string,
  ): Promise<ViewerDto[]> {
    const sessions = await roomSessionService.getViewers(roomId);
    const userRepo = AppDataSource.getRepository(User);
    const result: ViewerDto[] = [];

    for (const session of sessions) {
      const socket = io.sockets.sockets.get(session.socketId);
      if (!socket?.connected || !socket.rooms.has(roomId)) continue;
      const userId = session.userId && session.userId > 0 ? session.userId : null;
      let username: string | undefined = socket?.data?.username;
      const accountRole = socket.data?.role;
      const role: ViewerDto['role'] = ['root', 'admin', 'user', 'guest'].includes(accountRole)
        ? accountRole : 'viewer';

      // 回查 User 表补充 username
      if (!username && userId != null) {
        const user = await userRepo.findOneBy({ id: userId });
        username = user?.username;
      }

      result.push({
        socketId: session.socketId,
        userId,
        username: username ?? (role === 'guest' ? 'Guest' : 'Member'),
        role,
      });
    }

    return result;
  }

  /**
   * 踢出指定观众。
   *
   * - 通知被踢方显示提示并主动断开其 socket
   * - 结束其 viewer session
   * - 从 socket.io 房间中移除
   *
   * @param io Socket.IO 服务实例
   * @param roomId 房间 ID
   * @param viewerSocketId 被踢观众的 socketId
   */
  async kickViewer(
    io: SocketIOServer,
    roomId: string,
    viewerSocketId: string,
  ): Promise<boolean> {
    const targetSocket = io.sockets.sockets.get(viewerSocketId);
    if (!targetSocket) {
      return false;
    }

    // 通知被踢方显示提示并主动断开
    io.to(viewerSocketId).emit('viewer-kicked', {
      reason: '房主已将您移出房间',
    });

    // 结束其 session 记录
    await roomSessionService.endViewerSession(viewerSocketId);

    targetSocket.leave(roomId);
    targetSocket.disconnect(true);
    return true;
  }

  /**
   * 设置观众禁言/解禁状态。
   *
   * - muted=true：将 userId 加入 Room.mutedViewers
   * - muted=false：将 userId 从 Room.mutedViewers 移除
   *
   * @param roomId 房间 ID
   * @param userId 目标用户 ID
   * @param muted 是否禁言
   */
  async setMuted(
    roomId: string,
    userId: number,
    muted: boolean,
  ): Promise<void> {
    const roomRepo = AppDataSource.getRepository(Room);
    const room = await roomRepo.findOneBy({ roomId });
    if (!room) return;

    let mutedList: number[] = [];
    try {
      mutedList = JSON.parse(room.mutedViewers || '[]');
    } catch {
      mutedList = [];
    }

    if (muted) {
      if (!mutedList.includes(userId)) {
        mutedList.push(userId);
      }
    } else {
      mutedList = mutedList.filter((id) => id !== userId);
    }

    room.mutedViewers = JSON.stringify(mutedList);
    await roomRepo.save(room);
  }
}

/** 全局单例 */
export const viewerService = new ViewerService();
