import { randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import { IsNull } from 'typeorm';
import { AppDataSource } from '../../data-source';
import { Room } from '../../entities/Room';
import { Session } from '../../entities/Session';
import { Comment } from '../../entities/Comment';
import { UserMount } from '../../entities/UserMount';
import { movieService } from '../movie/movie.service';
import type { MovieDto } from '../shared';
import { isInternalOpenListServer } from '../../services/openlist-errors';
import { viewerService } from '../viewer/viewer.service';
import { leaveRoomVoice } from '../voice-chat/voice-chat.handler';
import { movieBroadcasterService } from '../movie/movie-broadcaster.service';
import { realtimeSyncCore } from '../realtime-sync-core';
import { playbackMemoryService } from '../playback-memory';
import { musicSyncService } from '../music/music-sync.service';
import { roomPermissionService } from './room-permission.service';
import { roomStateService } from './room-state.service';
import { canPerformRoomAction, type RoomRoleFacts, type RoomPermissionAction } from './permission-core';
import { ActivityPoll, selectDelegate } from './activity-poll';
import { getRoomCover } from './room-cover';
import { DELEGATE_GRACE_MS, isRoomActivity, parseRoomPolicy, roomDelegates, roomScreenPresenters, type RoomActivity } from './room-policy';

interface ActivityRequest { id: string; activity: RoomActivity; identity: string; socketId: string; username: string; createdAt: number; }
interface ContentSuggestion { id: string; identity: string; username: string; createdAt: number; title: string; payload: Partial<MovieDto>; }
const CAPABILITIES = {
  selectContent: 'movie.change', playback: 'playback.play', switchActivity: 'activity.switch',
  screenShare: 'screen.start', settings: 'room.settings', manageMembers: 'viewer.approve',
} as const;

/** Room-wide activity, requests and temporary hosting share the existing lock. */
export class RoomExperienceService {
  private readonly requests = new Map<string, Map<string, ActivityRequest>>();
  private readonly polls = new Map<string, ActivityPoll>();
  private readonly pollTimers = new Map<string, NodeJS.Timeout>();
  private readonly delegateTimers = new Map<string, NodeJS.Timeout>();
  private readonly suggestions = new Map<string, Map<string, ContentSuggestion>>();

  identity(socket: Socket): string {
    return socket.data.userId > 0 ? `user:${socket.data.userId}` : `guest:${socket.data.guestId || socket.id}`;
  }

  async snapshot(socket: Socket, roomId: string, io?: Server) {
    const room = await AppDataSource.getRepository(Room).findOneBy({ roomId, status: 'active' });
    if (!room || !(await roomPermissionService.isInRoom(socket, roomId))) throw new Error('请先加入房间');
    const permissions: Record<string, boolean> = {};
    for (const [key, action] of Object.entries(CAPABILITIES)) {
      permissions[key] = (await roomPermissionService.canPerform(socket, roomId, action)).allowed;
    }
    const facts = await roomPermissionService.getRoleFacts(socket, roomId);
    const host = await musicSyncService.getHostFacts(roomId);
    const poll = this.polls.get(roomId);
    const ownVote = poll?.votes.get(this.identity(socket));
    return {
      roomId, name: room.name, activity: room.activity, mode: room.mode,
      coverUrl: getRoomCover(room.policyJson),
      policy: parseRoomPolicy(room.policyJson), hasPassword: !!room.password,
      maxViewers: room.maxViewers, requireApproval: room.requireApproval,
      permissions, isDelegate: !!facts.isDelegate, host,
      screenPresenter: roomScreenPresenters.get(roomId) ?? null,
      // This complete, public directory includes the requester. Incremental
      // viewer-joined events can arrive before a new player's listener mounts.
      members: io ? await viewerService.getOnlineViewers(io, roomId) : [],
      joinRequests: io && permissions.manageMembers ? viewerService.listPendingRequests(io, roomId) : [],
      requests: [...(this.requests.get(roomId)?.values() ?? [])].map(({ identity: _identity, ...request }) => request),
      suggestions: [...(this.suggestions.get(roomId)?.values() ?? [])].filter(s => Date.now() - s.createdAt < 15 * 60_000).map(({ payload: _payload, identity: _identity, ...suggestion }) => suggestion),
      poll: poll ? { ...poll.snapshot(), ownVote: ownVote ?? null } : null,
    };
  }

  async broadcast(io: Server, roomId: string): Promise<void> {
    const sockets = await io.in(roomId).fetchSockets();
    await Promise.all(sockets.map(async remote => {
      const socket = io.sockets.sockets.get(remote.id);
      if (!socket) return;
      try { socket.emit('room:experience', await this.snapshot(socket, roomId, io)); }
      catch { /* A member can leave while this snapshot is being assembled. */ }
    }));
  }

  async memberJoined(io: Server, roomId: string): Promise<void> {
    const playback = await playbackMemoryService.getAdvancedPlayback(roomId);
    if (playback) roomStateService.setCurrentMovie(roomId, playback.currentMovieId ?? null);
    await movieBroadcasterService.broadcastMovieList(io, roomId);
    const host = await AppDataSource.getRepository(Session).findOneBy({ roomId, role: 'sharer', endedAt: IsNull() });
    if (!host && !roomDelegates.has(roomId) && !this.delegateTimers.has(roomId)) this.scheduleDelegate(io, roomId);
    await this.broadcast(io, roomId);
  }

  async suspendLocked(io: Server, roomId: string): Promise<void> {
    const state = await playbackMemoryService.suspendForActivityLocked(roomId);
    if (state) {
      roomStateService.setPlayback(roomId, state);
      io.to(roomId).emit('watch-together-state', { state, version: state.version, sourceGeneration: state.sourceGeneration, serverTimestamp: state.serverTimestamp });
    }
    const music = await musicSyncService.suspendForActivityLocked(roomId);
    io.to(roomId).emit('music:state', music);
    io.to(roomId).emit('music:sync-state', music);
  }

  private async switchLocked(io: Server, room: Room, activity: RoomActivity): Promise<void> {
    if (room.activity === activity) return;
    await this.suspendLocked(io, room.roomId);
    if (room.activity === 'screen') { roomScreenPresenters.delete(room.roomId); io.to(room.roomId).emit('room:stop-screen', { roomId: room.roomId }); }
    room.activity = activity;
    room.mode = activity === 'screen' ? 'screen-share' : 'watch-together';
    await AppDataSource.getRepository(Room).save(room);
    this.clearDiscussion(room.roomId);
    io.to(room.roomId).emit('room-mode-changed', { mode: room.mode, activity });
  }

  async switchActivity(socket: Socket, io: Server, roomId: string, activity: unknown): Promise<void> {
    if (!isRoomActivity(activity)) throw new Error('活动选项无效');
    await realtimeSyncCore.withRoomLock(roomId, async () => {
      const permission = await roomPermissionService.canPerform(socket, roomId, 'activity.switch');
      if (!permission.allowed) throw new Error(permission.reason);
      const room = await AppDataSource.getRepository(Room).findOneBy({ roomId, status: 'active' });
      if (!room) throw new Error('房间不存在');
      await this.switchLocked(io, room, activity);
    });
    await this.broadcast(io, roomId);
  }

  async requestActivity(socket: Socket, io: Server, roomId: string, activity: unknown): Promise<void> {
    if (!isRoomActivity(activity)) throw new Error('活动选项无效');
    await realtimeSyncCore.withRoomLock(roomId, async () => {
      const permission = await roomPermissionService.canPerform(socket, roomId, 'activity.request');
      if (!permission.allowed) throw new Error(permission.reason);
      const room = await AppDataSource.getRepository(Room).findOneBy({ roomId, status: 'active' });
      if (!room || room.activity === activity) throw new Error('已经在该活动中');
      const identity = this.identity(socket);
      const requests = this.requests.get(roomId) ?? new Map<string, ActivityRequest>();
      for (const [id, request] of requests) if (request.identity === identity) requests.delete(id);
      if (requests.size >= 100) throw new Error('请等待房主处理已有请求');
      const id = randomUUID();
      requests.set(id, { id, activity, identity, socketId: socket.id, username: String(socket.data.username || 'Guest').slice(0, 40), createdAt: Date.now() });
      this.requests.set(roomId, requests);
    });
    await this.broadcast(io, roomId);
  }

  async resolveRequest(socket: Socket, io: Server, roomId: string, requestId: string, decision: unknown): Promise<void> {
    if (!['accept', 'reject', 'poll'].includes(String(decision))) throw new Error('处理选项无效');
    await realtimeSyncCore.withRoomLock(roomId, async () => {
      const permission = await roomPermissionService.canPerform(socket, roomId, 'activity.switch');
      if (!permission.allowed) throw new Error(permission.reason);
      const request = this.requests.get(roomId)?.get(requestId);
      if (!request) throw new Error('请求已失效');
      const room = await AppDataSource.getRepository(Room).findOneBy({ roomId, status: 'active' });
      if (!room) throw new Error('房间不存在');
      if (decision === 'accept') await this.switchLocked(io, room, request.activity);
      if (decision === 'poll') {
        this.clearPoll(roomId);
        this.polls.set(roomId, new ActivityPoll(request.activity, request.socketId, request.username));
        const timer = setTimeout(() => { this.pollTimers.delete(roomId); void this.broadcast(io, roomId); }, 60_000);
        timer.unref();
        this.pollTimers.set(roomId, timer);
      }
      this.requests.get(roomId)?.delete(requestId);
      io.to(request.socketId).emit('room:request-result', { roomId, requestId, decision });
    });
    await this.broadcast(io, roomId);
  }

  async vote(socket: Socket, io: Server, roomId: string, pollId: string, value: unknown): Promise<void> {
    if (typeof value !== 'boolean') throw new Error('投票选项无效');
    await realtimeSyncCore.withRoomLock(roomId, async () => {
      const permission = await roomPermissionService.canPerform(socket, roomId, 'activity.vote');
      if (!permission.allowed) throw new Error(permission.reason);
      const poll = this.polls.get(roomId);
      if (!poll || poll.id !== pollId) throw new Error('投票已失效');
      poll.vote(this.identity(socket), value);
    });
    await this.broadcast(io, roomId);
  }

  async suggestContent(socket: Socket, io: Server, roomId: string, input: unknown): Promise<void> {
    if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 65536) throw new Error('Invalid content suggestion.');
    const payload = structuredClone(input) as Partial<MovieDto>;
    if (typeof payload.url !== 'string' || !payload.url.trim() || payload.url.length > 8192 || typeof payload.title !== 'string' || !payload.title.trim() || payload.title.length > 160) throw new Error('A valid content link and title are required.');
    await realtimeSyncCore.withRoomLock(roomId, async () => {
      if (!(await roomPermissionService.canPerform(socket, roomId, 'content.suggest')).allowed) throw new Error('Join the room before suggesting content.');
      const source = typeof payload.source === 'string' ? payload.source.toLowerCase() : '';
      if ((source === 'webdav' || source === 'openlist') && payload.serverUrl && socket.data.userId > 0) {
        const mount = await AppDataSource.getRepository(UserMount).findOneBy({ userId: socket.data.userId, serverUrl: payload.serverUrl, type: source });
        if (mount) { payload.username = mount.username || undefined; payload.password = mount.password || undefined; }
      }
      if (payload.directLink && ['openlist', 'webdav', 'emby', 'jellyfin'].includes(source) && isInternalOpenListServer(payload.serverUrl || payload.url!)) payload.directLink = false;
      const suggestions = this.suggestions.get(roomId) ?? new Map<string, ContentSuggestion>();
      for (const [id, value] of suggestions) if (Date.now() - value.createdAt >= 15 * 60_000) suggestions.delete(id);
      if (suggestions.size >= 50 || [...suggestions.values()].filter(s => s.identity === this.identity(socket)).length >= 3) throw new Error('Wait for the host to review your suggestions.');
      const id = randomUUID();
      suggestions.set(id, { id, identity: this.identity(socket), username: String(socket.data.username || 'Guest').slice(0, 40), title: payload.title!.trim(), createdAt: Date.now(), payload });
      this.suggestions.set(roomId, suggestions);
    });
    await this.broadcast(io, roomId);
  }

  async resolveContent(socket: Socket, io: Server, roomId: string, suggestionId: string, accepted: unknown): Promise<void> {
    if (typeof accepted !== 'boolean') throw new Error('Invalid decision.');
    await realtimeSyncCore.withRoomLock(roomId, async () => {
      if (!(await roomPermissionService.canPerform(socket, roomId, 'movie.change')).allowed) throw new Error('You cannot edit the watch queue.');
      const suggestion = this.suggestions.get(roomId)?.get(suggestionId);
      if (!suggestion || Date.now() - suggestion.createdAt >= 15 * 60_000) throw new Error('This suggestion has expired.');
      if (accepted) { await movieService.createMovie(roomId, suggestion.payload); await movieBroadcasterService.broadcastMovieList(io, roomId); }
      this.suggestions.get(roomId)?.delete(suggestionId);
    });
    await this.broadcast(io, roomId);
  }

  cancelDelegate(roomId: string): void {
    const timer = this.delegateTimers.get(roomId);
    if (timer) clearTimeout(timer);
    this.delegateTimers.delete(roomId);
    roomDelegates.delete(roomId);
    roomPermissionService.invalidatePermissionCache(undefined, roomId);
  }

  scheduleDelegate(io: Server, roomId: string): void {
    this.cancelDelegate(roomId);
    const timer = setTimeout(() => {
      this.delegateTimers.delete(roomId);
      void this.electDelegate(io, roomId).catch(error => console.error('[delegate]', error));
    }, DELEGATE_GRACE_MS);
    timer.unref();
    this.delegateTimers.set(roomId, timer);
  }

  async electDelegate(io: Server, roomId: string): Promise<void> {
    await realtimeSyncCore.withRoomLock(roomId, async () => {
      const room = await AppDataSource.getRepository(Room).findOneBy({ roomId, status: 'active' });
      if (!room) return;
      const sessions = await AppDataSource.getRepository(Session).findBy({ roomId, endedAt: IsNull() });
      if (sessions.some(session => session.role === 'sharer' && io.sockets.sockets.get(session.socketId)?.connected)) return;
      let moderators: number[] = [];
      try { moderators = JSON.parse(room.moderators || '[]'); } catch { /* use empty list */ }
      const rankingActions: RoomPermissionAction[] = ['viewer.kick', 'voice.kick', 'room.settings', 'movie.change', 'playback.play', 'screen.start', 'activity.switch', 'music.queue.add'];
      const candidates = sessions.filter(session => io.sockets.sockets.get(session.socketId)?.connected).map(session => {
        const member = !!session.userId && session.userId > 0;
        const facts: RoomRoleFacts = { actorRole: member ? moderators.includes(session.userId!) ? 'moderator' : 'member' : 'guest', userId: session.userId, isHost: false, isRoomMember: true, policy: parseRoomPolicy(room.policyJson) };
        return { socketId: session.socketId, permissionScore: rankingActions.filter(action => canPerformRoomAction(facts, action).allowed).length };
      });
      const delegate = selectDelegate(candidates);
      if (!delegate) return;
      roomDelegates.set(roomId, delegate);
      roomPermissionService.invalidatePermissionCache(undefined, roomId);
      await playbackMemoryService.updateHostSocket(roomId, delegate);
      io.to(roomId).emit('room:delegate-changed', { roomId, socketId: delegate });
    });
    await this.broadcast(io, roomId);
  }

  async memberLeft(io: Server, roomId: string, socketId: string, wasHost: boolean): Promise<void> {
    await realtimeSyncCore.withRoomLock(roomId, async () => {
      const sessions = await AppDataSource.getRepository(Session).findBy({ roomId, endedAt: IsNull() });
      // A leave/disconnect callback can finish after this socket rejoins or the
      // owner returns on another socket. Resolve current authority under the
      // same lock as registration, instead of acting on the old session role.
      if (sessions.some(session => session.socketId === socketId)) return;
      if (roomScreenPresenters.get(roomId) === socketId) { roomScreenPresenters.delete(roomId); io.to(roomId).emit('room:stop-screen', { roomId }); }
      const socket = io.sockets.sockets.get(socketId);
      if (socket) leaveRoomVoice(io, socket, roomId);
      const delegate = roomDelegates.get(roomId);
      const activeHost = sessions.some(session => session.role === 'sharer' && io.sockets.sockets.get(session.socketId)?.connected);
      if (!activeHost && (delegate === socketId || (wasHost && !delegate))) {
        await playbackMemoryService.updateHostSocket(roomId, null);
        io.to(roomId).emit('host-disconnected', { roomId });
        this.scheduleDelegate(io, roomId);
      }
      const occupied = sessions.length;
      if (occupied) return;
      await AppDataSource.getRepository(Room).createQueryBuilder().update().set({ emptySince: new Date() }).where('roomId = :roomId AND emptySince IS NULL', { roomId }).execute();
      await this.suspendLocked(io, roomId);
      io.to(roomId).emit('room:stop-screen', { roomId });
      this.cancelDelegate(roomId);
      this.clearDiscussion(roomId);
      musicSyncService.clearRuntime(roomId);
      roomScreenPresenters.delete(roomId);
      roomStateService.delete(roomId);
      await playbackMemoryService.releaseRuntime(roomId);
      realtimeSyncCore.clearRuntime(roomId);
      await AppDataSource.getRepository(Comment).delete({ roomId });
    });
    await this.broadcast(io, roomId);
  }

  private clearPoll(roomId: string): void {
    const timer = this.pollTimers.get(roomId);
    if (timer) clearTimeout(timer);
    this.pollTimers.delete(roomId);
    this.polls.delete(roomId);
  }
  private clearDiscussion(roomId: string): void { this.requests.delete(roomId); this.suggestions.delete(roomId); this.clearPoll(roomId); }
  clear(roomId: string): void { this.cancelDelegate(roomId); this.clearDiscussion(roomId); roomScreenPresenters.delete(roomId); }
}

export const roomExperienceService = new RoomExperienceService();
