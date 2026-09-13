import Hls from 'hls.js'
import type { MediaDescriptor } from './mediaApi'
import type { PlayerEngine, EngineAttachResult } from '../player/types'
import { getApiUrl } from '@/lib/api'

const activeModes = new Map<string, string>()
export function isProxiedMediaTransport(url: string) { const mode = activeModes.get(absolute(url)); return !!mode && mode !== 'DIRECT' }
const plans = new Map<string, NonNullable<MediaDescriptor['transportPlan']>>()
const absolute = (url: string) => url.startsWith('/') ? new URL(url, `${getApiUrl()}/`).toString() : url
export function registerMediaTransport(media: MediaDescriptor) {
  if (!media.transportPlan?.candidates.length) return
  const plan = { ...media.transportPlan, candidates: media.transportPlan.candidates.map(c => ({ ...c, url: absolute(c.url), audioUrl: c.audioUrl ? absolute(c.audioUrl) : undefined })) }
  if (media.transport === 'hls' && typeof window !== 'undefined' && !Hls.isSupported()) {
    plan.candidates = plan.candidates.filter(candidate => candidate.mode !== 'DIRECT')
  }
  plans.set(absolute(media.finalUrl), plan)
  if (plans.size > 100) { const oldest = plans.keys().next().value!; plans.delete(oldest); activeModes.delete(oldest) }
}
export function withMediaTransport(engine: PlayerEngine): PlayerEngine {
  return { ...engine, async attach(video, source) {
    const plan = plans.get(absolute(source.url))
    if (!plan || source.noProxyFallback) return engine.attach(video, source)
    let index = Math.max(0, plan.candidates.findIndex(c => c.mode === activeModes.get(absolute(source.url))))
    let active: EngineAttachResult | undefined
    let stopped = false
    let switching = false
    const attach = async (at: number, paused: boolean, rate: number): Promise<EngineAttachResult> => {
      let error: unknown
      while (index < plan.candidates.length && !stopped) {
        const candidate = plan.candidates[index++]
        try {
          active = await engine.attach(video, { ...source, url: candidate.url, audioUrl: candidate.audioUrl, startTime: at, noProxyFallback: true })
          if (stopped) { active.cleanup?.(); throw new Error('媒体已切换') }
          if (at > 0) video.currentTime = at
          video.playbackRate = rate
          if (!paused) await video.play().catch(() => {})
          else video.pause()
          activeModes.set(absolute(source.url), candidate.mode)
          video.dataset.mediaTransport = candidate.mode
          video.dataset.mediaSource = source.url
          return active
        } catch (err) { error = err; active?.cleanup?.(); active = undefined; if (video.error?.code === 3) throw err }
      }
      throw new Error(`同质量媒体传输失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const initial = await attach(source.startTime ?? 0, video.paused, video.playbackRate)
    const onError = () => {
      if (switching || stopped || index >= plan.candidates.length || video.error?.code === 3) return
      switching = true
      video.dataset.mediaTransportSwitching = 'true'
      const at = video.currentTime, paused = video.paused, rate = video.playbackRate
      active?.cleanup?.()
      void attach(at, paused, rate).catch(err => {
        video.dataset.mediaTransportError = String(err)
        video.dispatchEvent(new CustomEvent('media-transport-error', { detail: String(err) }))
      }).finally(() => { switching = false; delete video.dataset.mediaTransportSwitching })
    }
    video.addEventListener('error', onError)
    const player = initial.player ? {
      attach: (time?: number) => active?.player?.attach(time) ?? Promise.resolve(''),
      seekTo: (time: number) => active?.player?.seekTo(time) ?? Promise.resolve({ success: false }),
      cleanup: () => active?.player?.cleanup(),
      get isAttached() { return active?.player?.isAttached ?? false },
      get isSeeking() { return active?.player?.isSeeking ?? false },
    } : undefined
    return { ...initial, player, cleanup() { stopped = true; video.removeEventListener('error', onError); active?.cleanup?.() } }
  } }
}
