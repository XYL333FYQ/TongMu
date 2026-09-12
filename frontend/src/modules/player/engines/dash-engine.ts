/**
 * DASH 引擎适配器（基于 dash.js）。
 *
 * 使用 DashPlayer 实现 PlayerEngine 接口。
 * DashPlayer 内部动态生成 MPD manifest，将 B站分离的 video/audio m4s 包装为
 * dash.js 可识别的 DASH 源，由 dash.js 接管 MSE 生命周期与 seek 逻辑。
 *
 * 准入与失败策略：
 * - 标准 MPD 只有 sourceUrl，直接由 dash.js 加载 manifest；
 * - B站 DASH 带独立 video/audio m4s，继续由 DashPlayer 动态构造 MPD；
 * - dash.js 加载失败：直接抛错（自研 MSE 引擎已移除，无回退目标），
 *   由调用方提示用户。
 */
import type { PlayerEngine, PlayerSource, EngineAttachResult } from '../types'
import { DashPlayer } from './dash'
import dashjs from 'dashjs'
import { resetVideoElement, waitForMetadata } from '../utils'

export const dashEngine: PlayerEngine = {
  type: 'dash',

  async attach(
    video: HTMLVideoElement,
    source: PlayerSource
  ): Promise<EngineAttachResult> {
    const audioUrl = source.audioUrl || ''

    // 标准 MPD：直接交给 dash.js。B站 DASH 则仍走下方双 m4s 包装路径。
    if (!audioUrl) {
      resetVideoElement(video)
      const player = dashjs.MediaPlayer().create()
      try {
        player.updateSettings({
          streaming: { buffer: { bufferTimeAtTopQuality: 30 } },
        })
        player.initialize(video, source.url, false)
        await waitForMetadata(video)
        return {
          cleanup: () => {
            player.reset()
          },
        }
      } catch (err) {
        player.reset()
        throw new Error('dash.js 加载 MPD 失败', { cause: err })
      }
    }

    const dashPlayer = new DashPlayer({
      video,
      videoUrl: source.url,
      audioUrl,
      videoCodec: source.videoCodec,
      audioCodec: source.audioCodec,
      duration: source.duration,
      // 缓冲模式：从 IndexedDB 读取的 Blob 数据，传入后 dash.js 用 blob URL 加载
      videoBlob: source.videoBlob,
      audioBlob: source.audioBlob,
      // P2P 传输：仅在流模式启用，DashPlayer 内部会检查 isBufferMode
      p2pEnabled: source.p2pEnabled,
    })
    try {
      const blobUrl = await dashPlayer.attach(source.startTime)
      return {
        blobUrl,
        player: dashPlayer,
        cleanup: () => {
          dashPlayer.cleanup()
        },
      }
    } catch (err) {
      dashPlayer.cleanup()
      throw new Error('dash.js 加载 DASH 源失败', { cause: err })
    }
  },
}
