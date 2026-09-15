import type { UserRole } from '../../entities/User';

export type RoomPermissionAction =
  | 'playback.play'
  | 'playback.pause'
  | 'playback.seek'
  | 'playback.rate'
  | 'movie.change'
  | 'subtitle.change'
  | 'viewer.approve'
  | 'viewer.reject'
  | 'viewer.kick'
  | 'viewer.mute'
  | 'voice.mute'
  | 'voice.kick'
  | 'moderator.manage'
  | 'host.transfer'
  | 'room.settings'
  | 'music.queue.add'
  | 'music.queue.remove'
  | 'music.queue.reorder'
  | 'music.queue.clear'
  | 'music.play'
  | 'music.pause'
  | 'music.seek'
  | 'music.next'
  | 'music.previous'
  | 'music.track.select'
  | 'music.mode.change'
  | 'music.control.request'
  | 'music.track.ack'
  | 'music.heartbeat'
  | 'music.track.ended';

export type RoomActorRole = 'system' | 'owner' | 'moderator' | 'member' | 'guest';

export interface RoomRoleFacts {
  actorRole: RoomActorRole;
  userId: number | null;
  isHost: boolean;
  isRoomMember: boolean;
}

export interface PermissionTargetFacts {
  role: RoomActorRole;
  userId: number | null;
  isRoomMember: boolean;
  isSelf: boolean;
}

const HOST_ONLY_ACTIONS = new Set<RoomPermissionAction>([
  'playback.play',
  'playback.pause',
  'playback.seek',
  'playback.rate',
  'movie.change',
  'subtitle.change',
  'viewer.approve',
  'viewer.reject',
  'host.transfer',
]);

const MODERATION_ACTIONS = new Set<RoomPermissionAction>([
  'viewer.kick',
  'viewer.mute',
  'voice.mute',
  'voice.kick',
]);

const MUSIC_QUEUE_ACTIONS = new Set<RoomPermissionAction>([
  'music.queue.add',
  'music.queue.remove',
  'music.queue.reorder',
  'music.queue.clear',
]);

const MUSIC_HOST_ACTIONS = new Set<RoomPermissionAction>([
  'music.play',
  'music.pause',
  'music.seek',
  'music.next',
  'music.previous',
  'music.track.select',
  'music.mode.change',
  'music.heartbeat',
  'music.track.ended',
]);

export function canPerformRoomAction(
  facts: RoomRoleFacts,
  action: RoomPermissionAction,
  target?: PermissionTargetFacts,
): { allowed: true } | { allowed: false; reason: string } {
  if (!facts.isRoomMember) return { allowed: false, reason: '不在该房间中' };
  if (target?.role === 'system') return { allowed: false, reason: '不能对系统管理员操作' };
  if (target?.isSelf && action !== 'room.settings') return { allowed: false, reason: '不能对自己执行此操作' };

  if (facts.actorRole === 'guest') return { allowed: false, reason: '游客无此权限' };
  if (action === 'music.control.request') {
    return { allowed: true };
  }
  if (action === 'music.track.ack') {
    return { allowed: true };
  }
  if (MUSIC_QUEUE_ACTIONS.has(action)) {
    return facts.actorRole === 'owner' || facts.actorRole === 'moderator' || facts.actorRole === 'system'
      ? { allowed: true }
      : { allowed: false, reason: '仅房主、房管或系统管理员可管理音乐队列' };
  }
  if (MUSIC_HOST_ACTIONS.has(action)) {
    if (facts.actorRole === 'system') return { allowed: true };
    return facts.actorRole === 'owner' && facts.isHost
      ? { allowed: true }
      : { allowed: false, reason: '仅当前房主或系统管理员可控制音乐' };
  }
  if (HOST_ONLY_ACTIONS.has(action)) {
    return facts.actorRole === 'owner' || facts.actorRole === 'system'
      ? { allowed: true }
      : { allowed: false, reason: '仅房主或系统管理员可执行此操作' };
  }
  if (MODERATION_ACTIONS.has(action)) {
    if (facts.actorRole !== 'owner' && facts.actorRole !== 'moderator' && facts.actorRole !== 'system') {
      return { allowed: false, reason: '仅房主、房管或系统管理员可执行此操作' };
    }
    if (facts.actorRole === 'moderator' && target &&
      (target.role === 'owner' || target.role === 'moderator')) {
      return { allowed: false, reason: '房管不能操作房主、房管或系统管理员' };
    }
    return target?.isRoomMember === false
      ? { allowed: false, reason: '目标不在房间中' }
      : { allowed: true };
  }
  if (action === 'moderator.manage') {
    if (facts.actorRole !== 'owner' && facts.actorRole !== 'system') return { allowed: false, reason: '仅房主或系统管理员可管理房管' };
    if (!target || !target.isRoomMember || target.role === 'guest' || target.role === 'owner') {
      return { allowed: false, reason: '目标不是可管理的普通成员' };
    }
    return { allowed: true };
  }
  if (action === 'room.settings') {
    return facts.actorRole === 'owner' || facts.actorRole === 'system'
      ? { allowed: true }
      : { allowed: false, reason: '仅房主或系统管理员可修改房间设置' };
  }
  return { allowed: false, reason: '未知权限动作' };
}

export function roomRoleFromUserRole(role: UserRole, isOwner: boolean, isModerator: boolean, isMember: boolean): RoomActorRole {
  if (role === 'root' || role === 'admin') return 'system';
  if (!isMember) return role === 'guest' ? 'guest' : 'member';
  if (isOwner) return 'owner';
  if (isModerator) return 'moderator';
  return role === 'guest' ? 'guest' : 'member';
}
