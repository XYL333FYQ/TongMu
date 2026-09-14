import Hls from 'hls.js'
import type { MediaDescriptor } from './mediaApi'
import type { PlayerEngine, EngineAttachResult } from '../player/types'
import { getApiUrl } from '@/lib/api'

const activeModes = new Map<string, string>()
export function isProxiedMediaTransport(url: string) { const mode = activeModes.get(absolute(url)); return !!mode && mode !== 'DIRECT' }
const plans = new Map<string, NonNullable<MediaDescriptor['transportPlan']>>()
const absolute = (url: string) => url.startsWith('/') ? new URL(url, `${getApiUrl()}/`).toString() : url
function isInitialManifestFailure(error: unknown): boolean {
  return error instanceof Error && /manifestLoadError|HLS加载失败.*manifest/i.test(error.message)
}
export function registerMediaTransport(media: MediaDescriptor) {
  if (!media.transportPlan?.candidates.length) return
  const plan = { ...media.transportPlan, candidates: media.transportPlan.candidates.map(c => ({ ...c, url: absolute(c.url), audioUrl: c.audioUrl ? absolute(c.audioUrl) : undefined })) }
  if (media.transport === 'hls' && typeof window !== 'undefined' && !Hls.isSupported()) {
    plan.candidates = plan.candidates.filter(candidate => candidate.mode !== 'DIRECT')
  }
  const keys = new Set([absolute(media.finalUrl), ...plan.candidates.map(candidate => candidate.url)])
  for (const key of keys) plans.set(key, plan)
  while (plans.size > 100) { const oldest = plans.keys().next().value!; plans.delete(oldest); activeModes.delete(oldest) }
}
export function withMediaTransport(engine: PlayerEngine): PlayerEngine {
  return { ...engine, async attach(video, source) {
    const plan = plans.get(absolute(source.url))
    if (!plan || source.noProxyFallback) return engine.attach(video, source)
    const sourceKey = absolute(source.url)
    const sourceCandidateIndex = plan.candidates.findIndex(candidate => candidate.url === sourceKey)
    let index = sourceCandidateIndex >= 0
      ? sourceCandidateIndex
      : Math.max(0, plan.candidates.findIndex(c => c.mode === activeModes.get(sourceKey)))
    let initialAttempt = true
    let active: EngineAttachResult | undefined
    let stopped = false
    let switching = false
    const attach = async (at: number, paused: boolean, rate: number): Promise<EngineAttachResult> => {
      let error: unknown
      const firstCandidateIndex = index
      const runtimeFallbackIndex = firstCandidateIndex + 1
      const isInitialAttach = initialAttempt
      initialAttempt = false
      const candidateIndices = Array.from({ length: Math.max(0, plan.candidates.length - index) }, (_, offset) => index + offset)
      for (let candidatePosition = 0; candidatePosition < candidateIndices.length; candidatePosition += 1) {
        if (stopped) break
        const candidateIndex = candidateIndices[candidatePosition]
        const candidate = plan.candidates[candidateIndex]
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
          index = candidateIndex === firstCandidateIndex && candidateIndices[0] === firstCandidateIndex
            ? runtimeFallbackIndex
            : candidateIndex + 1
          return active
        } catch (err) {
          error = err
          active?.cleanup?.()
          active = undefined
          // A direct HLS manifest can fail before any child resource is
          // loaded. In that one initial case, try the sealed full gateway
          // before assisted routes. A later key/segment error must retain the
          // existing MANIFEST_ASSISTED -> PARTIAL_PROXY -> FULL_PROXY order.
          if (isInitialAttach && candidatePosition === 0 && candidate.mode === 'DIRECT' && isInitialManifestFailure(err)) {
            const fullProxyPosition = candidateIndices.findIndex((candidateIndex) => plan.candidates[candidateIndex].mode === 'FULL_PROXY')
            if (fullProxyPosition > candidatePosition) {
              const [fullProxyIndex] = candidateIndices.splice(fullProxyPosition, 1)
              candidateIndices.splice(candidatePosition + 1, 0, fullProxyIndex)
            }
          }
          if (video.error?.code === 3) throw err
        }
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
