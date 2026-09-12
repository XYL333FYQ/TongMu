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
    if (capabilities.nativeHls === false && capabilities.mediaSource === false) {
      return {
        engine: 'blocked', mode: 'unsupported', proxy: false,
        videoAction: 'none', audioAction: 'none',
        reasons: ['当前浏览器既不支持原生 HLS，也没有 MediaSource'],
      };
    }
    return {
      engine: 'hls', mode: 'manifest', proxy: !!media.headers,
      videoAction: 'direct', audioAction: 'direct',
      reasons: [capabilities.nativeHls ? '客户端可原生播放 HLS' : '使用现有 HLS 引擎'],
    };
  }
  if (media.transport === 'dash') {
    if (capabilities.mediaSource === false) {
      return {
        engine: 'blocked', mode: 'unsupported', proxy: false,
        videoAction: 'none', audioAction: 'none', reasons: ['当前浏览器没有 MediaSource，无法播放 DASH'],
      };
    }
    return {
      engine: 'dash', mode: 'manifest', proxy: !!media.headers,
      videoAction: 'direct', audioAction: 'direct', reasons: ['使用现有 DASH 引擎'],
    };
  }
  if (media.transport === 'flv') {
    if (capabilities.mediaSource === false) {
      return {
        engine: 'blocked', mode: 'unsupported', proxy: false,
        videoAction: 'none', audioAction: 'none', reasons: ['当前浏览器没有 MediaSource，无法播放 FLV'],
      };
    }
    return {
      engine: 'flv', mode: 'manifest', proxy: !!media.headers,
      videoAction: 'direct', audioAction: 'direct', reasons: ['使用现有 FLV 引擎'],
    };
  }
  const audioCodec = media.audioCodec?.toLowerCase();
  const videoCodec = media.videoCodec?.toLowerCase();
  if (videoCodec && /^(?:hevc|h265|hev1|hvc1)/.test(videoCodec) && capabilities.hevc === false) {
    return {
      engine: 'blocked', mode: 'unsupported', proxy: false,
      videoAction: 'none', audioAction: 'none',
      reasons: ['当前浏览器不支持 HEVC，且项目未启用全视频转码'],
    };
  }
  if (audioCodec && AUDIO_TRANSCODE_CODECS.has(audioCodec)) {
    if (media.rangeSupported === false) {
      return {
        engine: 'blocked', mode: 'unsupported', proxy: false,
        videoAction: 'none', audioAction: 'none', reasons: ['源站不支持 Range，无法安全执行随机读取与音频转码'],
      };
    }
    if (capabilities.playsvideo === false) {
      return {
        engine: 'blocked', mode: 'unsupported', proxy: false,
        videoAction: 'none', audioAction: 'none', reasons: ['当前浏览器无法运行音频转码工作线程'],
      };
    }
    return {
      engine: 'playsvideo', mode: 'audio-transcode', proxy: !!media.headers,
      videoAction: 'copy', audioAction: 'transcode-aac',
      reasons: [`${audioCodec.toUpperCase()} 音频浏览器不兼容；保留视频，仅转 AAC`],
    };
  }
  if (['mkv', 'ts', 'avi', 'wmv'].includes(media.container)) {
    if (media.rangeSupported === false) {
      return {
        engine: 'blocked', mode: 'unsupported', proxy: false,
        videoAction: 'none', audioAction: 'none', reasons: ['源站不支持 Range，playsvideo 无法随机读取并重封装'],
      };
    }
    if (capabilities.playsvideo === false) {
      return {
        engine: 'blocked', mode: 'unsupported', proxy: false,
        videoAction: 'none', audioAction: 'none', reasons: ['当前浏览器无法运行 playsvideo 重封装'],
      };
    }
    return {
      engine: 'playsvideo', mode: 'remux', proxy: !!media.headers,
      videoAction: 'copy', audioAction: 'copy', reasons: [`${media.container.toUpperCase()} 交给现有 playsvideo 重封装`],
    };
  }
  return {
    engine: 'direct', mode: 'direct', proxy: !!media.headers,
    videoAction: 'direct', audioAction: media.audioUrl ? 'direct' : 'direct',
    reasons: media.rangeSupported === false
      ? ['浏览器原生顺序播放；源站不支持 seek']
      : ['浏览器原生 Direct Play'],
  };
}
