/**
 * 播放器工具函数
 *
 * 从旧 msePlayer.ts 抽取的、与具体引擎无关的视频元素操作工具。
 */
import { t } from '@/i18n'
import { trackPlayerResource } from './lifecycle'

/**
 * 将 video.error 的 MediaError code 映射为面向用户的可读文案。
 *
 * code 参照 HTMLMediaElement 规范：
 * 1 MEDIA_ERR_ABORTED / 2 MEDIA_ERR_NETWORK / 3 MEDIA_ERR_DECODE /
 * 4 MEDIA_ERR_SRC_NOT_SUPPORTED。
 * 直链模式（noProxyFallback）失败时直接将映射文案展示给用户，
 * 不再自动回退服务器代理。
 */
export function formatVideoLoadError(code?: number): string {
  switch (code) {
    case 1:
      return t('Video loading was cancelled.')
    case 2:
      return t(
        'Unable to reach the media source. Check your connection and the source address.'
      )
    case 3:
      return t(
        'Your browser cannot decode this video format. Try a supported browser or another source.'
      )
    case 4:
      return t(
        'This media source is unavailable. Check its address, access permissions, format and HTTPS support.'
      )
    default:
      return t('Unable to load this media. Reload it or choose another source.')
  }
}

/**
 * 在切换 MediaSource / blob URL 前彻底重置 video 元素，
 * 避免旧的 MediaSource 仍在 attached 状态导致 Format error。
 */
export function resetVideoElement(video: HTMLVideoElement): void {
  try {
    video.pause()
  } catch {
    // ignore
  }
  video.removeAttribute('src')
  video.load()
}

/**
 * 等待 video 元素 metadata 加载完成（readyState >= 1）。
 *
 * 调用方在 attach 后设置 currentTime 前必须等待 metadata，
 * 否则浏览器会丢弃 currentTime 赋值（readyState < 1 时 seek 无效）。
 *
 * 同时监听 error 事件并附带超时：只触发 error 不触发 loadedmetadata 的加载失败
 * 若不 reject 会让 Promise 永不 settle，进而卡死 attach 串行队列（播放器假死）。
 */
export const METADATA_TIMEOUT_MS = 30_000

export function createPlayerAbortError(
  message = 'Playback was cancelled.'
): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export function isPlayerAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

export function waitForMetadata(
  video: HTMLVideoElement,
  signal?: AbortSignal
): Promise<void> {
  if (video.readyState >= 1) return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createPlayerAbortError())
      return
    }
    let releaseTimer: () => void = () => undefined
    let removeAbort: () => void = () => undefined
    const cleanup = () => {
      video.removeEventListener('loadedmetadata', onLoaded)
      video.removeEventListener('error', onError)
      signal?.removeEventListener('abort', onAbort)
      releaseTimer()
      removeAbort()
    }
    const onLoaded = () => {
      cleanup()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(
        new Error(
          `Media loading failed (code=${video.error?.code ?? 'unknown'}${
            video.error?.message ? `: ${video.error.message}` : ''
          })`
        )
      )
    }
    const onAbort = () => {
      cleanup()
      reject(createPlayerAbortError())
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(
        new Error(
          'Media metadata did not load within 30 seconds. Check the source and try again.'
        )
      )
    }, METADATA_TIMEOUT_MS)
    releaseTimer = trackPlayerResource('timers', () => clearTimeout(timer))
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
      removeAbort = () => signal.removeEventListener('abort', onAbort)
    }

    video.addEventListener('loadedmetadata', onLoaded)
    video.addEventListener('error', onError)
  })
}
