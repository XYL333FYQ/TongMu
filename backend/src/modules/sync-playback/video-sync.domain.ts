import type { SyncStateDto, ControlAction } from '../shared/dto';

const MAX_SOURCE_URL_LENGTH = 8192;
const MAX_TEXT_LENGTH = 512;
const MAX_HEADER_COUNT = 32;
const MAX_HEADER_VALUE_LENGTH = 4096;
const MAX_DURATION_SECONDS = 7 * 24 * 60 * 60;

export interface VideoMutationResult {
  state: SyncStateDto;
  value?: number;
}

function boundedFinite(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function validateHeaders(headers: unknown): headers is Record<string, string> | undefined {
  if (headers === undefined) return true;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return false;
  const entries = Object.entries(headers as Record<string, unknown>);
  return entries.length <= MAX_HEADER_COUNT && entries.every(([key, value]) =>
    key.length > 0 && key.length <= MAX_TEXT_LENGTH &&
    typeof value === 'string' && value.length <= MAX_HEADER_VALUE_LENGTH,
  );
}

/** Video-only facts and transitions. It owns no room ordering or permission state. */
export const VideoSyncDomain = {
  validateState(value: unknown): { ok: true; state: SyncStateDto } | { ok: false; message: string } {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, message: '播放状态必须是对象' };
    const state = value as Partial<SyncStateDto>;
    if (typeof state.sourceUrl !== 'string' || state.sourceUrl.length > MAX_SOURCE_URL_LENGTH) return { ok: false, message: 'sourceUrl 无效' };
    if (typeof state.sourceType !== 'string' || state.sourceType.length === 0 || state.sourceType.length > MAX_TEXT_LENGTH) return { ok: false, message: 'sourceType 无效' };
    if (typeof state.isPlaying !== 'boolean') return { ok: false, message: 'isPlaying 无效' };
    if (!boundedFinite(state.currentTime, 0, MAX_DURATION_SECONDS) || !boundedFinite(state.playbackRate, 0.1, 16)) return { ok: false, message: '播放位置或倍速无效' };
    if (state.duration !== undefined && !boundedFinite(state.duration, 0, MAX_DURATION_SECONDS)) return { ok: false, message: 'duration 无效' };
    if (!validateHeaders(state.headers)) return { ok: false, message: 'headers 无效' };
    if (state.sourceGeneration !== undefined && (!Number.isSafeInteger(state.sourceGeneration) || state.sourceGeneration < 0)) return { ok: false, message: 'sourceGeneration 无效' };
    const duration = state.duration ?? 0;
    const next: SyncStateDto = { ...state, duration } as SyncStateDto;
    if (duration > 0 && next.currentTime > duration) next.currentTime = duration;
    return { ok: true, state: next };
  },

  applyControl(current: SyncStateDto, action: ControlAction, value: unknown, currentTime: number): { ok: true; result: VideoMutationResult } | { ok: false; message: string } {
    const next: SyncStateDto = { ...current };
    switch (action) {
      case 'play':
        next.isPlaying = true;
        break;
      case 'pause':
        next.currentTime = currentTime;
        next.isPlaying = false;
        break;
      case 'seek':
        if (!boundedFinite(value, 0, next.duration && next.duration > 0 ? next.duration : MAX_DURATION_SECONDS)) return { ok: false, message: 'seek position 无效' };
        next.currentTime = value;
        break;
      case 'rate':
        if (!boundedFinite(value, 0.1, 16)) return { ok: false, message: 'playbackRate 无效' };
        next.playbackRate = value;
        break;
      default:
        return { ok: false, message: '未知播放动作' };
    }
    return { ok: true, result: { state: next, value: typeof value === 'number' ? value : undefined } };
  },

  validateHeartbeat(value: unknown): value is { currentTime: number; isPlaying: boolean; playbackRate: number; sourceGeneration?: number; clientTimestamp?: number } {
    if (!value || typeof value !== 'object') return false;
    const heartbeat = value as Record<string, unknown>;
    return boundedFinite(heartbeat.currentTime, 0, MAX_DURATION_SECONDS) &&
      typeof heartbeat.isPlaying === 'boolean' && boundedFinite(heartbeat.playbackRate, 0.1, 16) &&
      (heartbeat.sourceGeneration === undefined || (Number.isSafeInteger(heartbeat.sourceGeneration) && Number(heartbeat.sourceGeneration) >= 0)) &&
      (heartbeat.clientTimestamp === undefined || (typeof heartbeat.clientTimestamp === 'number' && Number.isFinite(heartbeat.clientTimestamp)));
  },
};
