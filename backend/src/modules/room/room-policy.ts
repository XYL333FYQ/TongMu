import type { RoomPermissionAction } from './permission-core';

export type RoomActivity = 'watch' | 'listen' | 'screen';
export interface RoomPolicy {
  visibility: 'public' | 'private';
  lifetime: 'temporary' | 'persistent';
  allowGuests: boolean;
  guestCollaboration: boolean;
  collaboration: 'host' | 'shared';
  showContentTitle: boolean;
  permissions: Partial<Record<'selectContent' | 'playback' | 'switchActivity' | 'screenShare', boolean>>;
}
export const DEFAULT_ROOM_POLICY: RoomPolicy = {
  visibility: 'public', lifetime: 'temporary', allowGuests: true,
  guestCollaboration: false, collaboration: 'host', showContentTitle: false,
  permissions: {},
};
export function parseRoomPolicy(raw?: string | null): RoomPolicy {
  try { return validateRoomPolicy(JSON.parse(raw || '{}')); }
  catch { return { ...DEFAULT_ROOM_POLICY, permissions: {} }; }
}
export function validateRoomPolicy(value: unknown): RoomPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('房间规则无效');
  const v = value as Record<string, unknown>;
  for (const [key, allowed] of Object.entries({ visibility: ['public', 'private'], lifetime: ['temporary', 'persistent'], collaboration: ['host', 'shared'] })) {
    if (v[key] !== undefined && !allowed.includes(String(v[key]))) throw new Error('房间规则选项无效');
  }
  for (const key of ['allowGuests', 'guestCollaboration', 'showContentTitle']) {
    if (v[key] !== undefined && typeof v[key] !== 'boolean') throw new Error('房间规则开关无效');
  }
  const permissions: RoomPolicy['permissions'] = {};
  if (v.permissions !== undefined) {
    if (!v.permissions || typeof v.permissions !== 'object' || Array.isArray(v.permissions)) throw new Error('协作权限无效');
    for (const [key, enabled] of Object.entries(v.permissions)) {
      if (!['selectContent', 'playback', 'switchActivity', 'screenShare'].includes(key) || typeof enabled !== 'boolean') throw new Error('协作权限无效');
      permissions[key as keyof typeof permissions] = enabled;
    }
  }
  return { ...DEFAULT_ROOM_POLICY, ...Object.fromEntries(Object.entries(v).filter(([key]) => key in DEFAULT_ROOM_POLICY)), permissions } as RoomPolicy;
}
export function isRoomActivity(value: unknown): value is RoomActivity {
  return value === 'watch' || value === 'listen' || value === 'screen';
}
export const ACTIVITY_CONTROL_ACTIONS = new Set<RoomPermissionAction>([
  'playback.play', 'playback.pause', 'playback.seek', 'playback.rate', 'movie.change', 'subtitle.change',
  'music.queue.add', 'music.queue.remove', 'music.queue.reorder', 'music.queue.clear',
  'music.play', 'music.pause', 'music.seek', 'music.next', 'music.previous', 'music.track.select', 'music.mode.change',
]);
export function collaborationAllows(policy: RoomPolicy, action: RoomPermissionAction, guest: boolean): boolean {
  if (guest && !policy.guestCollaboration) return false;
  if (action === 'activity.switch') return policy.permissions.switchActivity === true;
  if (action === 'screen.start') return policy.permissions.screenShare === true;
  if (!ACTIVITY_CONTROL_ACTIONS.has(action)) return false;
  const key = action === 'movie.change' || action.startsWith('music.queue.') ? 'selectContent' : 'playback';
  return policy.permissions[key] ?? policy.collaboration === 'shared';
}

/** Ephemeral hosting never rewrites the durable owner or the platform role. */
export const roomDelegates = new Map<string, string>();
export const roomScreenPresenters = new Map<string, string>();
export const EMPTY_ROOM_TTL_MS = 24 * 60 * 60 * 1000;
export const DELEGATE_GRACE_MS = 30_000;

export function shouldExpireRoom(policy: RoomPolicy, emptySince: Date | null, memberCount: number, now = Date.now()): boolean {
  return policy.lifetime === 'temporary' && memberCount === 0 && emptySince !== null && now - emptySince.getTime() >= EMPTY_ROOM_TTL_MS;
}
