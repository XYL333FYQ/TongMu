/**
 * HLS 引擎：通过 hls.js 将 m3u8 流挂载到 <video> 元素。
 *
 * - Safari（含 iOS）原生支持 HLS：直接设置 src，无需 hls.js；
 * - 其他浏览器通过 hls.js（MSE 封装）附加；
 * - MANIFEST_PARSED 后 resolve；cleanup 销毁 hls 实例。
 *
 * 跨域处理：通过自定义 ProxyLoader 拦截 hls.js 的所有网络请求（m3u8 主清单、
 * ts 分片、密钥等），将跨域 URL 包装为服务器代理 URL，绕过浏览器 CORS 限制。
 */
import Hls from 'hls.js'
import type { PlayerEngine, PlayerSource, EngineAttachResult } from '../types'
import { resetVideoElement, waitForMetadata } from '../utils'
import { resolveProxyUrl } from '../services/url-proxy'
import { redactMediaError, redactMediaUrl } from '../services/media-redaction'

/** Safari 等原生 HLS 支持检测 */
function canPlayNativeHls(video: HTMLVideoElement): boolean {
  return video.canPlayType('application/vnd.apple.mpegurl') !== ''
}

/**
 * 创建自定义 ProxyLoader：拦截 hls.js 的所有网络请求，
 * 将跨域 URL 包装为服务器代理 URL，避免浏览器 CORS 限制。
 *
 * 使用 Hls.DefaultConfig.loader 作为基类（通常为 FetchLoader），
 * 仅在 load 入口处改写 context.url，其余行为保持不变。
 *
 * 关键：加载完成后需恢复 context.url 与 response.url 为原始 URL，
 * 否则 hls.js 会基于代理 URL 解析 m3u8 中的相对路径 ts 分片，导致拼接错误。
 */
/** 等待 hls.js 加载 m3u8 清单完成或失败，带超时 */
function waitForHlsReady(hls: Hls, video: HTMLVideoElement, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false

    const onManifestParsed = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }

    const onError = (
      _event: string,
      data: { type: string; details: string; fatal: boolean; url?: string }
    ) => {
      if (settled) return
      // 非致命错误不reject，让hls.js自行恢复
      if (!data.fatal) return
      settled = true
      cleanup()
      reject(new Error(
        `HLS加载失败: type=${data.type} details=${data.details} url=${redactMediaUrl(data.url)}`
      ))
    }

    const onTimeout = () => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error(`HLS加载超时(${timeoutMs}ms)`))
    }

    function cleanup() {
      video.removeEventListener('loadedmetadata', onManifestParsed)
      hls.off(Hls.Events.ERROR, onError)
      clearTimeout(timer)
    }

    video.addEventListener('loadedmetadata', onManifestParsed)
    hls.on(Hls.Events.ERROR, onError)
    const timer = setTimeout(onTimeout, timeoutMs)
  })
}

export const hlsEngine: PlayerEngine = {
  type: 'hls',

  async attach(
    video: HTMLVideoElement,
    source: PlayerSource
  ): Promise<EngineAttachResult> {
    resetVideoElement(video)

    const targetUrl = resolveProxyUrl(source.url, source.headers, source.format, { noProxyFallback: source.noProxyFallback })
    console.log('[hls-engine] attach start', {
      originalUrl: redactMediaUrl(source.url),
      resolvedUrl: redactMediaUrl(targetUrl),
      format: source.format,
    })

    // 优先使用 hls.js：支持 MSE 的浏览器（Chrome/Firefox/Edge）通过 hls.js 附加，
    // 可利用 ProxyLoader 拦截跨域请求。仅当 hls.js 不支持时（如 iOS Safari
    // 不支持 MSE）才回退到原生 HLS。
    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,

        // 内存控制：hls.js 默认 maxMaxBufferLength=600s、backBufferLength=Infinity——
        // 已播数据永不清理，长视频播放 1-2 小时后 MSE SourceBuffer 累积到 GB 级内存。
        // 前向缓冲 30s 保证平滑，硬上限 120s 兜底极低码率，已播仅保留 90s
        // （seek 回看 90s 内秒开，更早的位置会重新拉取分片）。
        maxBufferLength: 30,
        maxMaxBufferLength: 120,
        backBufferLength: 90,
      })

      // 先注册事件监听器，再调用 attachMedia
      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        console.log('[hls-engine] MEDIA_ATTACHED, calling loadSource')
        hls.loadSource(targetUrl)
      })
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        hls.currentLevel = hls.levels.reduce((best, level, i, levels) => (level.height || 0) > (levels[best].height || 0) || ((level.height || 0) === (levels[best].height || 0) && level.bitrate > levels[best].bitrate) ? i : best, 0)
      })
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal && video.readyState >= 1) video.dispatchEvent(new Event('error'))
        console.error('[hls-engine] hls.js error', {
          type: data.type,
          details: data.details,
          fatal: data.fatal,
          url: redactMediaUrl(data.url),
          response: data.response
            ? {
                code: data.response.code,
                text: data.response.text ? redactMediaError(data.response.text) : undefined,
              }
            : null,
        })
      })

      hls.attachMedia(video)

      try {
        // 使用事件驱动等待替代 waitForMetadata，避免永久阻塞
        await waitForHlsReady(hls, video)
      } catch (err) {
        try {
          hls.destroy()
        } catch {
          /* ignore */
        }
        throw err
      }

      return {
        cleanup: () => {
          try {
            hls.destroy()
          } catch {
            /* ignore */
          }
        },
      }
    }

    // 回退：原生 HLS（Safari/iOS），无法拦截 ts 分片请求
    if (canPlayNativeHls(video)) {
      console.log('[hls-engine] using native HLS (Safari fallback)')
      video.src = targetUrl
      video.load()
      await waitForMetadata(video)
      return {
        cleanup: () => {
          try {
            video.pause()
          } catch {
            /* ignore */
          }
          video.removeAttribute('src')
          video.load()
        },
      }
    }

    throw new Error('当前浏览器不支持 HLS 播放且 hls.js 不可用')
  },
}
