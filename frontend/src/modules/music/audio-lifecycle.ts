export interface MusicAudioLike {
  src: string
  currentTime: number
  playbackRate: number
  paused: boolean
  duration: number
  pause(): void
  play(): Promise<void> | void
  load(): void
  addEventListener(type: string, listener: EventListener): void
  removeEventListener(type: string, listener: EventListener): void
  removeAttribute?(name: string): void
}

export interface MusicAudioLifecycleCallbacks {
  onReady?: () => void
  onError?: (error: unknown) => void
  onEnded?: () => void
}

/**
 * Owns one audio element's source generation and cleanup. Every listener
 * closes over an epoch, so callbacks from an unloaded track cannot affect the
 * newly selected track.
 */
export class MusicAudioLifecycle {
  private readonly audio: MusicAudioLike
  private epoch = 0
  private activeGeneration: number | null = null
  private listeners: Array<[string, EventListener]> = []
  private abortController: AbortController | null = null
  private ownedObjectUrl: string | null = null

  constructor(audio: MusicAudioLike) {
    this.audio = audio
  }

  get generation(): number | null {
    return this.activeGeneration
  }

  isCurrent(generation: number, epoch = this.epoch): boolean {
    return this.activeGeneration === generation && this.epoch === epoch
  }

  attach(
    sourceUrl: string,
    generation: number,
    callbacks: MusicAudioLifecycleCallbacks = {},
    ownedObjectUrl = false
  ): void {
    this.unload()
    const epoch = this.epoch
    this.activeGeneration = generation
    this.abortController = new AbortController()
    this.ownedObjectUrl = ownedObjectUrl ? sourceUrl : null
    const isCurrent = () => this.isCurrent(generation, epoch)
    const onReady: EventListener = () => {
      if (isCurrent()) callbacks.onReady?.()
    }
    const onError: EventListener = (event) => {
      if (isCurrent()) callbacks.onError?.(event)
    }
    const onEnded: EventListener = () => {
      if (isCurrent()) callbacks.onEnded?.()
    }
    this.listeners = [
      ['loadedmetadata', onReady],
      ['canplay', onReady],
      ['error', onError],
      ['ended', onEnded],
    ]
    for (const [type, listener] of this.listeners)
      this.audio.addEventListener(type, listener)
    try {
      this.audio.src = sourceUrl
      this.audio.load()
    } catch (error) {
      if (isCurrent()) callbacks.onError?.(error)
    }
  }

  unload(): void {
    this.epoch += 1
    this.activeGeneration = null
    this.abortController?.abort()
    this.abortController = null
    for (const [type, listener] of this.listeners) {
      this.audio.removeEventListener(type, listener)
    }
    this.listeners = []
    try {
      this.audio.pause()
      this.audio.removeAttribute?.('src')
      this.audio.src = ''
      this.audio.load()
      this.audio.currentTime = 0
    } catch {
      // Cleanup must remain idempotent even when a browser has already torn down media.
    }
    if (this.ownedObjectUrl) {
      URL.revokeObjectURL(this.ownedObjectUrl)
      this.ownedObjectUrl = null
    }
  }
}
