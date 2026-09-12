import type { ClientCapabilities, MediaDescriptor, PlaybackPlan } from './types';

const AUDIO_TRANSCODE_CODECS = new Set(['dts', 'dca', 'ac3', 'eac3', 'truehd']);

/** Pure policy function: lowest-cost path first, with every fallback explained. */
export function planPlayback(
  media: MediaDescriptor,
  capabilities: ClientCapabilities = {},
): PlaybackPlan {
  if (media.drm.protected) {
    return {
      engine: 'blocked', mode: 'unsupported', proxy: false,
      videoAction: 'none', audioAction: 'none',
      reasons: [`检测到 DRM：${media.drm.systems?.join(', ') || 'ContentProtection'}`],
    };
  }
  if (media.transport === 'hls') {
    return {
      engine: 'hls', mode: 'manifest', proxy: !!media.headers,
      videoAction: 'direct', audioAction: 'direct',
      reasons: [capabilities.nativeHls ? '客户端可原生播放 HLS' : '使用现有 HLS 引擎'],
    };
  }
  if (media.transport === 'dash') {
    return {
      engine: 'dash', mode: 'manifest', proxy: !!media.headers,
      videoAction: 'direct', audioAction: 'direct', reasons: ['使用现有 DASH 引擎'],
    };
  }
  if (media.transport === 'flv') {
    return {
      engine: 'flv', mode: 'manifest', proxy: !!media.headers,
      videoAction: 'direct', audioAction: 'direct', reasons: ['使用现有 FLV 引擎'],
    };
  }
  const audioCodec = media.audioCodec?.toLowerCase();
  if (audioCodec && AUDIO_TRANSCODE_CODECS.has(audioCodec)) {
    return {
      engine: 'playsvideo', mode: 'audio-transcode', proxy: !!media.headers,
      videoAction: 'copy', audioAction: 'transcode-aac',
      reasons: [`${audioCodec.toUpperCase()} 音频浏览器不兼容；保留视频，仅转 AAC`],
    };
  }
  if (['mkv', 'ts'].includes(media.container)) {
    return {
      engine: 'playsvideo', mode: 'remux', proxy: !!media.headers,
      videoAction: 'copy', audioAction: 'copy', reasons: [`${media.container.toUpperCase()} 交给现有 playsvideo 重封装`],
    };
  }
  return {
    engine: 'direct', mode: 'direct', proxy: !!media.headers,
    videoAction: 'direct', audioAction: media.audioUrl ? 'direct' : 'direct',
    reasons: ['浏览器原生 Direct Play'],
  };
}
