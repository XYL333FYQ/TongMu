/**
 * FLV 引擎：通过 flv.js 将 FLV 流挂载到 <video> 元素。
 *
 * attach 在 metadata 就绪后 resolve；cleanup 完整卸载 flv 实例
 * （pause → unload → detach → destroy）。
 */
import flvjs from 'flv.js'
import type { PlayerEngine, PlayerSource, EngineAttachResult } from '../types'
import {
  resetVideoElement,
  waitForMetadata,
  createPlayerAbortError,
} from '../utils'
import { resolveProxyUrl } from '../services/url-proxy'

export const flvEngine: PlayerEngine = {
  type: 'flv',

  async attach(
    video: HTMLVideoElement,
    source: PlayerSource
  ): Promise<EngineAttachResult> {
    if (source.signal?.aborted) throw createPlayerAbortError()
    if (!flvjs.isSupported()) {
      throw new Error('当前浏览器不支持 FLV 播放且 flv.js 不可用')
    }

    resetVideoElement(video)

    // 统一代理策略：由 url-proxy.ts 根据 URL 特征与源格式决定
    const targetUrl = resolveProxyUrl(source.url, source.headers, source.format)

    const player = flvjs.createPlayer(
      {
        type: 'flv',
        url: targetUrl,
        isLive: source.isLive === true,
        cors: true,
      },
      {
        enableWorker: false,
        lazyLoad: false,
      }
    )

    let destroyed = false
    const destroy = () => {
      if (destroyed) return
      destroyed = true
      source.signal?.removeEventListener('abort', destroy)
      try {
        player.pause()
        player.unload()
        player.detachMediaElement()
        player.destroy()
      } catch {
        /* ignore */
      }
    }
    source.signal?.addEventListener('abort', destroy, { once: true })

    try {
      player.attachMediaElement(video)
      player.load()
      await waitForMetadata(video, source.signal)
    } catch (err) {
      destroy()
      throw err
    }

    return { cleanup: destroy }
  },
}
