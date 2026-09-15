import { useCallback, useEffect, useRef, useState } from 'react'
import type { Socket } from 'socket.io-client'
import { message } from '@/components/ui/message'
import {
  VOICE_CHANNELS,
  VOICE_FRAME_DURATION_US,
  VOICE_FRAME_SAMPLES,
  VOICE_MAX_PACKET_BYTES,
  VOICE_MAX_PENDING_AGE_MS,
  VOICE_MAX_PENDING_BYTES,
  VOICE_MAX_PENDING_PACKETS,
  VOICE_SAMPLE_RATE,
  arrayBufferEquals,
  boundedArrayBuffer,
  isBoundedVoicePacket,
} from '../voice-contract'

const OPUS_BITRATE = 128_000
const JITTER_BUFFER_DELAY = 0.12
const MAX_PLAYBACK_BACKLOG_SEC = 0.5
const MAX_PENDING_SOURCES = 32
const DECODER_REBUILD_THROTTLE_MS = 10_000

const OPUS_SUPPORTED =
  typeof window !== 'undefined' &&
  typeof (window as unknown as { AudioEncoder?: unknown }).AudioEncoder !==
    'undefined' &&
  typeof (window as unknown as { AudioDecoder?: unknown }).AudioDecoder !==
    'undefined'

export interface VoiceMember {
  identity: string
  socketId: string
  userId: number | null
  username?: string
  role?: 'root' | 'admin' | 'user' | 'guest'
  generation: number
  muted?: boolean
  speaking?: boolean
}

export interface UseVoiceChatOptions {
  socket: Socket | null
  roomId: string | undefined
  username?: string
  /** 保留旧接口；Voice 权限由服务端验证。 */
  isHost?: boolean
}

export interface UseVoiceChatResult {
  joined: boolean
  joining: boolean
  micEnabled: boolean
  members: VoiceMember[]
  globalVolume: number
  peerVolumes: Map<string, number>
  peerLatencies: Map<string, number>
  join: () => Promise<void>
  leave: () => void
  toggleMic: () => void
  setGlobalVolume: (value: number) => void
  setPeerVolume: (socketId: string, value: number) => void
  monitorEnabled: boolean
  toggleMonitor: () => void
  micVolume: number
  setMicVolume: (value: number) => void
  audioLevels: Map<string, number>
  voiceMutedBySocket: Set<string>
  muteVoiceMember: (
    socketId: string,
    muted: boolean
  ) => Promise<{ success: boolean; message?: string }>
  kickVoiceMember: (
    socketId: string
  ) => Promise<{ success: boolean; message?: string }>
}

interface PendingAudioPacket {
  data: ArrayBuffer
  timestamp: number
  mediaTs?: number
  queuedAt: number
}

interface PeerPlaybackState {
  generation: number
  gainNode: GainNode
  analyser: AnalyserNode
  nextStartTime: number
  pendingSources: Set<AudioBufferSourceNode>
  pendingPackets: PendingAudioPacket[]
  pendingPacketBytes: number
  lastArrivalAt: number
  lastLatency: number
  decoder?: AudioDecoder
  decoderConfigured: boolean
  decoderConfigKey?: string
  codecDescription?: ArrayBuffer
  decoderRebuildAt: number
}

interface VoicePacketPayload {
  from: string
  identity?: string
  generation?: number
  data: unknown
  sampleRate?: number
  channels?: number
  codec?: string
  timestamp: number
  mediaTs?: number
  encoded?: boolean
  frameSamples?: number
}

interface VoiceCodecPayload {
  from: string
  identity?: string
  generation?: number
  codec?: string
  sampleRate?: number
  channels?: number
  description: unknown
}

function float32ToInt16(float32: Float32Array): Int16Array {
  const int16 = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32[i]))
    int16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }
  return int16
}

function int16ToFloat32(int16: Int16Array): Float32Array {
  const float32 = new Float32Array(int16.length)
  for (let i = 0; i < int16.length; i += 1) {
    float32[i] = int16[i] / 0x8000
  }
  return float32
}

function bytesToKey(value: ArrayBuffer | undefined): string {
  if (!value) return 'none'
  const bytes = new Uint8Array(value)
  let key = ''
  for (const byte of bytes) key += byte.toString(16).padStart(2, '0')
  return key
}

function decoderConfigKey(
  codec: string,
  sampleRate: number,
  channels: number,
  description?: ArrayBuffer
): string {
  return [codec, sampleRate, channels, bytesToKey(description)].join('|')
}

function getUplinkBacklogBytes(socket: Socket): number {
  try {
    const engine = socket.io as unknown as {
      engine?: { transport?: { ws?: { bufferedAmount?: number } } }
    }
    return engine.engine?.transport?.ws?.bufferedAmount ?? 0
  } catch {
    return 0
  }
}

export function useVoiceChat(options: UseVoiceChatOptions): UseVoiceChatResult {
  const { socket, roomId, username } = options
  const [joined, setJoined] = useState(false)
  const [joining, setJoining] = useState(false)
  const [micEnabled, setMicEnabled] = useState(true)
  const [members, setMembers] = useState<VoiceMember[]>([])
  const [globalVolume, setGlobalVolumeState] = useState(1)
  const [peerVolumes, setPeerVolumes] = useState<Map<string, number>>(new Map())
  const [monitorEnabled, setMonitorEnabled] = useState(false)
  const [micVolume, setMicVolumeState] = useState(1)
  const [peerLatencies, setPeerLatencies] = useState<Map<string, number>>(
    new Map()
  )
  const [audioLevels, setAudioLevels] = useState<Map<string, number>>(new Map())
  const [voiceMutedBySocket, setVoiceMutedBySocket] = useState<Set<string>>(
    new Set()
  )

  const localStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const micGainNodeRef = useRef<GainNode | null>(null)
  const workletNodeRef = useRef<AudioWorkletNode | null>(null)
  const silenceGainRef = useRef<GainNode | null>(null)
  const localAnalyserRef = useRef<AnalyserNode | null>(null)
  const monitorGainRef = useRef<GainNode | null>(null)
  const monitorStreamRef = useRef<MediaStream | null>(null)
  const monitorAudioRef = useRef<HTMLAudioElement | null>(null)
  const visibilityHandlerRef = useRef<(() => void) | null>(null)

  const audioEncoderRef = useRef<AudioEncoder | null>(null)
  const codecDescriptionRef = useRef<ArrayBuffer | null>(null)
  const encoderTimestampRef = useRef(0)

  const playbackContextRef = useRef<AudioContext | null>(null)
  const masterGainRef = useRef<GainNode | null>(null)
  const peerStatesRef = useRef<Map<string, PeerPlaybackState>>(new Map())
  const levelTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const playAudioChunkRef = useRef<
    (
      socketId: string,
      generation: number,
      pcm: Float32Array,
      sampleRate: number
    ) => void
  >(() => {})
  const createPeerDecoderRef = useRef<
    (socketId: string, generation: number) => AudioDecoder | null
  >(() => null)

  const socketRef = useRef(socket)
  const roomIdRef = useRef(roomId)
  const usernameRef = useRef(username)
  const globalVolumeRef = useRef(globalVolume)
  const peerVolumesRef = useRef(peerVolumes)
  const micVolumeRef = useRef(micVolume)
  const micEnabledRef = useRef(true)
  const joinedRef = useRef(false)
  const joiningRef = useRef(false)
  const selfMutedRef = useRef(false)
  const membersRef = useRef<Map<string, VoiceMember>>(new Map())
  const lifecycleTokenRef = useRef(0)
  const reconnectingRef = useRef(false)
  const reconnectCleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  )

  useEffect(() => {
    socketRef.current = socket
    roomIdRef.current = roomId
    usernameRef.current = username
  }, [socket, roomId, username])

  useEffect(() => {
    globalVolumeRef.current = globalVolume
    if (masterGainRef.current) masterGainRef.current.gain.value = globalVolume
  }, [globalVolume])

  useEffect(() => {
    peerVolumesRef.current = peerVolumes
  }, [peerVolumes])

  useEffect(() => {
    micVolumeRef.current = micVolume
    if (micGainNodeRef.current) micGainNodeRef.current.gain.value = micVolume
  }, [micVolume])

  useEffect(() => {
    joinedRef.current = joined
  }, [joined])

  useEffect(() => {
    joiningRef.current = joining
  }, [joining])

  useEffect(() => {
    micEnabledRef.current = micEnabled
    workletNodeRef.current?.port.postMessage({ enabled: micEnabled })
    if (monitorGainRef.current) {
      monitorGainRef.current.gain.value = micEnabled ? 1 : 0
    }
  }, [micEnabled])

  const getLevel = useCallback((analyser: AnalyserNode): number => {
    const data = new Uint8Array(analyser.frequencyBinCount)
    analyser.getByteTimeDomainData(data)
    let sum = 0
    for (const value of data) {
      const sample = (value - 128) / 128
      sum += sample * sample
    }
    return Math.min(1, Math.sqrt(sum / data.length) * 2.5)
  }, [])

  const startLevelDetection = useCallback(() => {
    if (levelTimerRef.current) return
    let lastPublished = new Map<string, number>()
    levelTimerRef.current = setInterval(() => {
      const next = new Map<string, number>()
      if (localAnalyserRef.current && micVolumeRef.current > 0) {
        next.set(
          'self',
          micEnabledRef.current ? getLevel(localAnalyserRef.current) : 0
        )
      }
      peerStatesRef.current.forEach((state, socketId) => {
        next.set(socketId, getLevel(state.analyser))
      })
      let changed = next.size !== lastPublished.size
      if (!changed) {
        next.forEach((value, key) => {
          if (Math.abs(value - (lastPublished.get(key) ?? 0)) > 0.03)
            changed = true
        })
      }
      if (changed) {
        lastPublished = next
        setAudioLevels(next)
      }
    }, 80)
  }, [getLevel])

  const stopLevelDetection = useCallback(() => {
    if (levelTimerRef.current) clearInterval(levelTimerRef.current)
    levelTimerRef.current = null
    setAudioLevels(new Map())
  }, [])

  const resetPeerTimeline = useCallback((state: PeerPlaybackState) => {
    state.pendingSources.forEach((source) => {
      try {
        source.stop()
      } catch {
        // already ended
      }
      try {
        source.disconnect()
      } catch {
        // already disconnected
      }
    })
    state.pendingSources.clear()
    state.nextStartTime = 0
  }, [])

  const playAudioChunk = useCallback(
    (
      socketId: string,
      generation: number,
      pcmData: Float32Array,
      sampleRate: number
    ) => {
      if (sampleRate !== VOICE_SAMPLE_RATE || !pcmData.length) return
      const context = playbackContextRef.current
      const state = peerStatesRef.current.get(socketId)
      if (!context || !state || state.generation !== generation) return

      const now = context.currentTime
      if (
        state.pendingSources.size >= MAX_PENDING_SOURCES ||
        state.nextStartTime - now > MAX_PLAYBACK_BACKLOG_SEC ||
        (state.nextStartTime > 0 && now - state.nextStartTime > 0.3)
      ) {
        resetPeerTimeline(state)
      }

      const buffer = context.createBuffer(
        VOICE_CHANNELS,
        pcmData.length,
        sampleRate
      )
      const copy = new Float32Array(pcmData.length)
      copy.set(pcmData)
      buffer.copyToChannel(copy, 0)
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(state.gainNode)
      const startTime = Math.max(
        now + JITTER_BUFFER_DELAY,
        state.nextStartTime || now + JITTER_BUFFER_DELAY
      )
      state.pendingSources.add(source)
      source.onended = () => {
        state.pendingSources.delete(source)
        try {
          source.disconnect()
        } catch {
          // ignore
        }
      }
      source.start(startTime)
      state.nextStartTime = startTime + buffer.duration
      state.lastArrivalAt = performance.now()
    },
    [resetPeerTimeline]
  )

  useEffect(() => {
    playAudioChunkRef.current = playAudioChunk
  }, [playAudioChunk])

  const createPeerDecoder = useCallback(
    (socketId: string, generation: number): AudioDecoder | null => {
      if (!OPUS_SUPPORTED) return null
      try {
        return new AudioDecoder({
          output: (audioData: AudioData) => {
            try {
              const state = peerStatesRef.current.get(socketId)
              if (!state || state.generation !== generation) return
              const frames = audioData.numberOfFrames
              let pcm: Float32Array
              if (audioData.format?.includes('s16')) {
                const int16 = new Int16Array(frames)
                audioData.copyTo(int16, { planeIndex: 0 })
                pcm = int16ToFloat32(int16)
              } else {
                pcm = new Float32Array(frames)
                audioData.copyTo(pcm, { planeIndex: 0 })
              }
              playAudioChunkRef.current(
                socketId,
                generation,
                pcm,
                audioData.sampleRate
              )
            } finally {
              audioData.close()
            }
          },
          error: () => {
            const state = peerStatesRef.current.get(socketId)
            if (!state || state.generation !== generation) return
            state.decoderConfigured = false
            const now = Date.now()
            if (now - state.decoderRebuildAt < DECODER_REBUILD_THROTTLE_MS)
              return
            state.decoderRebuildAt = now
            try {
              state.decoder?.close()
            } catch {
              // ignore
            }
            state.decoder =
              createPeerDecoderRef.current(socketId, generation) ?? undefined
            if (!state.decoder) return
            const description = state.codecDescription
            try {
              state.decoder.configure({
                codec: 'opus',
                sampleRate: VOICE_SAMPLE_RATE,
                numberOfChannels: VOICE_CHANNELS,
                ...(description ? { description } : {}),
              })
              state.decoderConfigured = true
              state.decoderConfigKey = decoderConfigKey(
                'opus',
                VOICE_SAMPLE_RATE,
                VOICE_CHANNELS,
                description
              )
            } catch {
              if (!description) {
                state.decoderConfigured = false
                return
              }
              try {
                state.decoder.configure({
                  codec: 'opus',
                  sampleRate: VOICE_SAMPLE_RATE,
                  numberOfChannels: VOICE_CHANNELS,
                })
                state.codecDescription = undefined
                state.decoderConfigured = true
                state.decoderConfigKey = decoderConfigKey(
                  'opus',
                  VOICE_SAMPLE_RATE,
                  VOICE_CHANNELS
                )
              } catch {
                state.decoderConfigured = false
              }
            }
          },
        })
      } catch {
        return null
      }
    },
    []
  )

  useEffect(() => {
    createPeerDecoderRef.current = createPeerDecoder
  }, [createPeerDecoder])

  const ensurePeerPlayback = useCallback(
    (member: VoiceMember): PeerPlaybackState | null => {
      const context = playbackContextRef.current
      const master = masterGainRef.current
      if (!context || !master) return null
      const existing = peerStatesRef.current.get(member.socketId)
      if (existing && existing.generation === member.generation) return existing
      if (existing) {
        resetPeerTimeline(existing)
        try {
          existing.decoder?.close()
        } catch {
          // ignore
        }
        try {
          existing.gainNode.disconnect()
          existing.analyser.disconnect()
        } catch {
          // ignore
        }
      }
      const gainNode = context.createGain()
      gainNode.gain.value = peerVolumesRef.current.get(member.socketId) ?? 1
      const analyser = context.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.6
      gainNode.connect(analyser)
      analyser.connect(master)
      const state: PeerPlaybackState = {
        generation: member.generation,
        gainNode,
        analyser,
        nextStartTime: 0,
        pendingSources: new Set(),
        pendingPackets: [],
        pendingPacketBytes: 0,
        lastArrivalAt: 0,
        lastLatency: 0,
        decoder:
          createPeerDecoder(member.socketId, member.generation) ?? undefined,
        decoderConfigured: false,
        decoderRebuildAt: 0,
      }
      peerStatesRef.current.set(member.socketId, state)
      return state
    },
    [createPeerDecoder, resetPeerTimeline]
  )

  const flushPendingPackets = useCallback(
    (socketId: string, state: PeerPlaybackState) => {
      if (!state.decoder || !state.decoderConfigured) return
      const pending = state.pendingPackets.splice(0)
      state.pendingPacketBytes = 0
      for (const packet of pending) {
        if (Date.now() - packet.queuedAt > VOICE_MAX_PENDING_AGE_MS) continue
        try {
          state.decoder.decode(
            new EncodedAudioChunk({
              type: 'key',
              timestamp: packet.mediaTs ?? packet.timestamp * 1000,
              data: packet.data,
            })
          )
        } catch {
          break
        }
      }
      if (!peerStatesRef.current.has(socketId)) return
    },
    []
  )

  const configurePeerDecoder = useCallback(
    (
      socketId: string,
      generation: number,
      description: ArrayBuffer | null
    ): boolean => {
      const member = membersRef.current.get(socketId)
      const state = peerStatesRef.current.get(socketId)
      if (
        !member ||
        !state ||
        state.generation !== generation ||
        !state.decoder
      )
        return false
      const key = decoderConfigKey(
        'opus',
        VOICE_SAMPLE_RATE,
        VOICE_CHANNELS,
        description ?? undefined
      )
      if (state.decoderConfigured && state.decoderConfigKey === key) return true
      if (state.decoderConfigured && state.decoderConfigKey !== key) {
        resetPeerTimeline(state)
        try {
          state.decoder.close()
        } catch {
          // ignore
        }
        state.decoder = createPeerDecoder(socketId, generation) ?? undefined
        state.decoderConfigured = false
      }
      if (!state.decoder) return false
      state.codecDescription = description ?? undefined
      try {
        state.decoder.configure({
          codec: 'opus',
          sampleRate: VOICE_SAMPLE_RATE,
          numberOfChannels: VOICE_CHANNELS,
          ...(description ? { description } : {}),
        })
        state.decoderConfigured = true
        state.decoderConfigKey = key
        flushPendingPackets(socketId, state)
        return true
      } catch {
        // Browser-specific descriptions can be rejected. A known Opus tuple
        // remains safe to try without description before isolating this peer.
        if (description) {
          try {
            state.decoder.configure({
              codec: 'opus',
              sampleRate: VOICE_SAMPLE_RATE,
              numberOfChannels: VOICE_CHANNELS,
            })
            state.decoderConfigured = true
            state.codecDescription = undefined
            state.decoderConfigKey = decoderConfigKey(
              'opus',
              VOICE_SAMPLE_RATE,
              VOICE_CHANNELS
            )
            flushPendingPackets(socketId, state)
            return true
          } catch {
            // isolate the bad peer decoder; the room stays usable
          }
        }
        state.decoderConfigured = false
        return false
      }
    },
    [createPeerDecoder, flushPendingPackets, resetPeerTimeline]
  )

  const cleanupPeerPlayback = useCallback(
    (socketId: string) => {
      const state = peerStatesRef.current.get(socketId)
      if (!state) return
      resetPeerTimeline(state)
      state.pendingPackets = []
      state.pendingPacketBytes = 0
      try {
        state.decoder?.close()
      } catch {
        // ignore
      }
      try {
        state.gainNode.disconnect()
        state.analyser.disconnect()
      } catch {
        // ignore
      }
      peerStatesRef.current.delete(socketId)
    },
    [resetPeerTimeline]
  )

  const stopMonitor = useCallback(() => {
    const audio = monitorAudioRef.current
    if (audio) {
      audio.pause()
      audio.srcObject = null
      audio.remove()
      monitorAudioRef.current = null
    }
  }, [])

  const startMonitor = useCallback(() => {
    const stream = monitorStreamRef.current
    if (!stream) return
    let audio = monitorAudioRef.current
    if (!audio) {
      audio = document.createElement('audio')
      audio.autoplay = true
      audio.dataset.voiceMonitor = 'self'
      document.body.appendChild(audio)
      monitorAudioRef.current = audio
    }
    if (audio.srcObject !== stream) {
      // The monitor is an intentionally imperative media element owned by this hook.
      // eslint-disable-next-line react-hooks/immutability
      audio.srcObject = stream
    }
  }, [])

  const cleanupAll = useCallback(() => {
    lifecycleTokenRef.current += 1
    joinedRef.current = false
    joiningRef.current = false
    if (reconnectCleanupTimerRef.current) {
      clearTimeout(reconnectCleanupTimerRef.current)
      reconnectCleanupTimerRef.current = null
    }
    peerStatesRef.current.forEach((_, socketId) =>
      cleanupPeerPlayback(socketId)
    )
    peerStatesRef.current.clear()
    stopMonitor()
    stopLevelDetection()
    try {
      audioEncoderRef.current?.close()
    } catch {
      // ignore
    }
    audioEncoderRef.current = null
    codecDescriptionRef.current = null
    encoderTimestampRef.current = 0
    try {
      workletNodeRef.current?.port.postMessage({ enabled: false })
      workletNodeRef.current?.disconnect()
      silenceGainRef.current?.disconnect()
      micGainNodeRef.current?.disconnect()
      micSourceRef.current?.disconnect()
      localAnalyserRef.current?.disconnect()
      monitorGainRef.current?.disconnect()
    } catch {
      // ignore
    }
    workletNodeRef.current = null
    silenceGainRef.current = null
    micGainNodeRef.current = null
    micSourceRef.current = null
    localAnalyserRef.current = null
    monitorGainRef.current = null
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    localStreamRef.current = null
    monitorStreamRef.current = null
    try {
      void audioContextRef.current?.close()
    } catch {
      // ignore
    }
    try {
      void playbackContextRef.current?.close()
    } catch {
      // ignore
    }
    audioContextRef.current = null
    playbackContextRef.current = null
    masterGainRef.current = null
    if (visibilityHandlerRef.current) {
      document.removeEventListener(
        'visibilitychange',
        visibilityHandlerRef.current
      )
      visibilityHandlerRef.current = null
    }
    membersRef.current.clear()
    setMembers([])
    setVoiceMutedBySocket(new Set())
    setPeerLatencies(new Map())
    setJoined(false)
    setJoining(false)
    setMicEnabled(true)
    setMonitorEnabled(false)
    setMicVolumeState(1)
    selfMutedRef.current = false
  }, [cleanupPeerPlayback, stopLevelDetection, stopMonitor])

  const join = useCallback(async () => {
    const currentSocket = socketRef.current
    const currentRoomId = roomIdRef.current
    if (!currentSocket || !currentRoomId) {
      message.error('未连接到房间')
      return
    }
    if (joinedRef.current || joiningRef.current) return
    const token = ++lifecycleTokenRef.current
    joiningRef.current = true
    setJoining(true)
    const isCurrent = () => token === lifecycleTokenRef.current
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new DOMException('microphone unavailable', 'NotSupportedError')
      }
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: VOICE_CHANNELS,
          sampleRate: VOICE_SAMPLE_RATE,
          sampleSize: 16,
        } as MediaTrackConstraints,
      })
      if (!isCurrent()) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      localStreamRef.current = stream
      const captureContext = new AudioContext({ sampleRate: VOICE_SAMPLE_RATE })
      audioContextRef.current = captureContext
      await captureContext.audioWorklet.addModule('/voice-processor.js')
      if (!isCurrent()) {
        await captureContext.close()
        return
      }
      const source = captureContext.createMediaStreamSource(stream)
      const micGain = captureContext.createGain()
      micGain.gain.value = micVolumeRef.current
      const worklet = new AudioWorkletNode(captureContext, 'voice-processor', {
        processorOptions: {
          frameSize: VOICE_FRAME_SAMPLES,
          outputSampleRate: VOICE_SAMPLE_RATE,
        },
      })
      const silenceGain = captureContext.createGain()
      silenceGain.gain.value = 0
      source.connect(micGain)
      micGain.connect(worklet)
      worklet.connect(silenceGain)
      silenceGain.connect(captureContext.destination)
      const analyser = captureContext.createAnalyser()
      analyser.fftSize = 256
      analyser.smoothingTimeConstant = 0.6
      micGain.connect(analyser)
      const monitorDestination = captureContext.createMediaStreamDestination()
      const monitorGain = captureContext.createGain()
      monitorGain.gain.value = micEnabledRef.current ? 1 : 0
      micGain.connect(monitorGain)
      monitorGain.connect(monitorDestination)
      await captureContext.resume()
      micSourceRef.current = source
      micGainNodeRef.current = micGain
      workletNodeRef.current = worklet
      silenceGainRef.current = silenceGain
      localAnalyserRef.current = analyser
      monitorGainRef.current = monitorGain
      monitorStreamRef.current = monitorDestination.stream

      if (OPUS_SUPPORTED) {
        const encoderConfig = {
          codec: 'opus',
          sampleRate: VOICE_SAMPLE_RATE,
          numberOfChannels: VOICE_CHANNELS,
          bitrate: OPUS_BITRATE,
        }
        const encoderSupport =
          await AudioEncoder.isConfigSupported?.(encoderConfig)
        if (encoderSupport && encoderSupport.supported === false) {
          throw new DOMException(
            'Opus encoder unsupported',
            'NotSupportedError'
          )
        }
        const encoder = new AudioEncoder({
          output: (
            chunk: EncodedAudioChunk,
            metadata: EncodedAudioChunkMetadata
          ) => {
            if (
              !joinedRef.current ||
              selfMutedRef.current ||
              !currentSocket.connected
            )
              return
            if (metadata?.decoderConfig?.description) {
              const description = boundedArrayBuffer(
                metadata.decoderConfig.description
              )
              if (
                description &&
                (!codecDescriptionRef.current ||
                  !arrayBufferEquals(codecDescriptionRef.current, description))
              ) {
                codecDescriptionRef.current = description
                currentSocket.emit('voice-codec-config', {
                  roomId: currentRoomId,
                  codec: 'opus',
                  sampleRate: VOICE_SAMPLE_RATE,
                  channels: VOICE_CHANNELS,
                  description,
                })
              }
            }
            const data = new ArrayBuffer(chunk.byteLength)
            chunk.copyTo(data)
            if (data.byteLength > VOICE_MAX_PACKET_BYTES) return
            currentSocket.emit('voice-audio-data', {
              roomId: currentRoomId,
              data,
              codec: 'opus',
              sampleRate: VOICE_SAMPLE_RATE,
              channels: VOICE_CHANNELS,
              frameSamples: VOICE_FRAME_SAMPLES,
              timestamp: Date.now(),
              mediaTs: chunk.timestamp,
              encoded: true,
            })
          },
          error: () => {
            try {
              audioEncoderRef.current?.close()
            } catch {
              // keep the room alive; the next join can retry encoder setup
            }
            audioEncoderRef.current = null
          },
        })
        audioEncoderRef.current = encoder
        encoder.configure(encoderConfig)
      }

      let frameTimestamp = 0
      worklet.port.onmessage = (event: MessageEvent) => {
        const data = event.data as ArrayBuffer
        if (
          !isCurrent() ||
          !joinedRef.current ||
          !micEnabledRef.current ||
          selfMutedRef.current ||
          !currentSocket.connected ||
          !data ||
          data.byteLength !==
            VOICE_FRAME_SAMPLES * Float32Array.BYTES_PER_ELEMENT ||
          getUplinkBacklogBytes(currentSocket) > 16 * 1024
        )
          return
        const pcm = new Float32Array(data)
        if (audioEncoderRef.current) {
          try {
            const audioData = new AudioData({
              format: 'f32-planar',
              sampleRate: VOICE_SAMPLE_RATE,
              numberOfFrames: VOICE_FRAME_SAMPLES,
              numberOfChannels: VOICE_CHANNELS,
              timestamp: frameTimestamp,
              data: pcm,
            })
            audioEncoderRef.current.encode(audioData)
            audioData.close()
            frameTimestamp += VOICE_FRAME_DURATION_US
          } catch {
            // Encoder failures are isolated; server-side packet validation remains.
          }
        } else {
          const int16 = float32ToInt16(pcm)
          currentSocket.emit('voice-audio-data', {
            roomId: currentRoomId,
            data: int16.buffer,
            codec: 'pcm-s16',
            sampleRate: VOICE_SAMPLE_RATE,
            channels: VOICE_CHANNELS,
            frameSamples: VOICE_FRAME_SAMPLES,
            timestamp: Date.now(),
            encoded: false,
          })
        }
      }

      const playbackContext = new AudioContext({
        sampleRate: VOICE_SAMPLE_RATE,
      })
      playbackContextRef.current = playbackContext
      const masterGain = playbackContext.createGain()
      masterGain.gain.value = globalVolumeRef.current
      masterGain.connect(playbackContext.destination)
      await playbackContext.resume()
      masterGainRef.current = masterGain

      const response = await new Promise<
        | { success: true; members: VoiceMember[]; selfMuted?: boolean }
        | { success: false; message: string }
      >((resolve) => {
        let settled = false
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true
            resolve({ success: false, message: '加入语音超时' })
          }
        }, 10_000)
        currentSocket.emit(
          'voice-join',
          { roomId: currentRoomId, username },
          (result: {
            success: boolean
            members?: VoiceMember[]
            selfMuted?: boolean
            message?: string
          }) => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            if (result.success && result.members) {
              resolve({
                success: true,
                members: result.members,
                selfMuted: result.selfMuted,
              })
            } else {
              resolve({
                success: false,
                message: result.message ?? '加入语音失败',
              })
            }
          }
        )
      })
      if (!isCurrent()) return
      if (!response.success) {
        if (!reconnectingRef.current) {
          message.error(
            'message' in response ? response.message : '加入语音失败'
          )
        }
        cleanupAll()
        return
      }
      const nextMembers = [...response.members]
      if (currentSocket.id) {
        nextMembers.unshift({
          identity: 'self',
          socketId: currentSocket.id,
          userId: null,
          username,
          generation: 0,
        })
      }
      membersRef.current = new Map(
        nextMembers.map((member) => [member.socketId, member])
      )
      setMembers(nextMembers)
      selfMutedRef.current = response.selfMuted === true
      setVoiceMutedBySocket(
        new Set(
          nextMembers
            .filter((member) => member.muted)
            .map((member) => member.socketId)
        )
      )
      nextMembers.forEach((member) => {
        if (member.socketId !== currentSocket.id) ensurePeerPlayback(member)
      })
      setJoined(true)
      joinedRef.current = true
      joiningRef.current = false
      setJoining(false)
      startLevelDetection()
      const onVisibility = () => {
        if (document.visibilityState !== 'visible') return
        ;[audioContextRef.current, playbackContextRef.current].forEach(
          (context) => {
            if (context?.state === 'suspended')
              void context.resume().catch(() => {})
          }
        )
      }
      visibilityHandlerRef.current = onVisibility
      document.addEventListener('visibilitychange', onVisibility)
    } catch (error) {
      if (isCurrent()) {
        const name = (error as { name?: string })?.name
        if (reconnectingRef.current) {
          // A reconnect can race the room module's own room rejoin. The caller
          // retries with a bounded backoff; do not flash a permission toast for
          // an intermediate attempt.
        } else if (
          name === 'NotAllowedError' ||
          name === 'PermissionDeniedError'
        ) {
          message.error('麦克风权限被拒绝，请允许权限后重试')
        } else if (
          name === 'NotFoundError' ||
          name === 'DevicesNotFoundError'
        ) {
          message.error('未找到可用的麦克风设备')
        } else {
          message.error('加入语音失败，请稍后重试')
        }
      }
      cleanupAll()
    }
  }, [cleanupAll, ensurePeerPlayback, startLevelDetection, username])

  const leave = useCallback(() => {
    const currentSocket = socketRef.current
    const currentRoomId = roomIdRef.current
    const wasActive = joinedRef.current || joiningRef.current
    if (wasActive && currentSocket && currentRoomId) {
      currentSocket.emit('voice-leave', { roomId: currentRoomId })
    }
    cleanupAll()
  }, [cleanupAll])

  const toggleMic = useCallback(() => setMicEnabled((value) => !value), [])

  const toggleMonitor = useCallback(() => {
    setMonitorEnabled((value) => {
      const next = !value
      if (next) startMonitor()
      else stopMonitor()
      return next
    })
  }, [startMonitor, stopMonitor])

  useEffect(() => {
    if (joined && monitorEnabled) startMonitor()
    if (!monitorEnabled) stopMonitor()
  }, [joined, monitorEnabled, startMonitor, stopMonitor])

  const setMicVolume = useCallback((value: number) => {
    const next = Math.max(0, Math.min(1, value))
    setMicVolumeState(next)
    micVolumeRef.current = next
    if (micGainNodeRef.current) micGainNodeRef.current.gain.value = next
  }, [])

  const setGlobalVolume = useCallback((value: number) => {
    const next = Math.max(0, Math.min(1, value))
    setGlobalVolumeState(next)
    globalVolumeRef.current = next
    if (masterGainRef.current) masterGainRef.current.gain.value = next
  }, [])

  const setPeerVolume = useCallback((socketId: string, value: number) => {
    const nextValue = Math.max(0, Math.min(1, value))
    setPeerVolumes((previous) => {
      const next = new Map(previous)
      next.set(socketId, nextValue)
      return next
    })
    peerVolumesRef.current.set(socketId, nextValue)
    const state = peerStatesRef.current.get(socketId)
    if (state) state.gainNode.gain.value = nextValue
  }, [])

  useEffect(() => {
    if (!joined) return
    const timer = setInterval(() => {
      const context = playbackContextRef.current
      if (!context) return
      const now = context.currentTime
      const next = new Map<string, number>()
      peerStatesRef.current.forEach((state, socketId) => {
        if (state.nextStartTime > 0) {
          next.set(
            socketId,
            Math.max(0, Math.round((state.nextStartTime - now) * 1000))
          )
        }
      })
      setPeerLatencies(next)
    }, 2_000)
    return () => clearInterval(timer)
  }, [joined])

  const handleVoiceCodecConfig = useCallback(
    (payload: VoiceCodecPayload) => {
      if (
        !joinedRef.current ||
        !isBoundedVoicePacket(payload.description) ||
        payload.codec !== 'opus' ||
        payload.sampleRate !== VOICE_SAMPLE_RATE ||
        payload.channels !== VOICE_CHANNELS
      )
        return
      const member = membersRef.current.get(payload.from)
      if (
        !member ||
        member.socketId === socketRef.current?.id ||
        payload.generation !== member.generation
      )
        return
      const description = boundedArrayBuffer(payload.description)
      if (!description) return
      const state = ensurePeerPlayback(member)
      if (state)
        configurePeerDecoder(member.socketId, member.generation, description)
    },
    [configurePeerDecoder, ensurePeerPlayback]
  )

  const handleVoiceAudioData = useCallback(
    (payload: VoicePacketPayload) => {
      if (!joinedRef.current || payload.from === socketRef.current?.id) return
      const member = membersRef.current.get(payload.from)
      if (
        !member ||
        payload.generation !== member.generation ||
        payload.sampleRate !== VOICE_SAMPLE_RATE ||
        payload.channels !== VOICE_CHANNELS ||
        !Number.isFinite(payload.timestamp) ||
        (payload.mediaTs !== undefined && !Number.isFinite(payload.mediaTs))
      )
        return
      const data = boundedArrayBuffer(payload.data)
      if (
        !data ||
        data.byteLength === 0 ||
        data.byteLength > VOICE_MAX_PACKET_BYTES
      )
        return
      const state = ensurePeerPlayback(member)
      if (!state) return
      state.lastLatency = Math.max(0, Date.now() - payload.timestamp)
      if (payload.encoded) {
        if (
          payload.codec !== 'opus' ||
          payload.frameSamples !== VOICE_FRAME_SAMPLES ||
          !state.decoder
        )
          return
        if (
          !state.decoderConfigured &&
          !configurePeerDecoder(member.socketId, member.generation, null)
        ) {
          state.pendingPackets.push({
            data,
            timestamp: payload.timestamp,
            mediaTs: payload.mediaTs,
            queuedAt: Date.now(),
          })
          state.pendingPacketBytes += data.byteLength
          while (
            state.pendingPackets.length > VOICE_MAX_PENDING_PACKETS ||
            state.pendingPacketBytes > VOICE_MAX_PENDING_BYTES
          ) {
            const removed = state.pendingPackets.shift()
            if (!removed) break
            state.pendingPacketBytes -= removed.data.byteLength
          }
          return
        }
        try {
          state.decoder.decode(
            new EncodedAudioChunk({
              type: 'key',
              timestamp: payload.mediaTs ?? payload.timestamp * 1000,
              data,
            })
          )
        } catch {
          state.decoderConfigured = false
        }
        return
      }
      if (payload.codec !== 'pcm-s16' || data.byteLength % 2 !== 0) return
      playAudioChunk(
        member.socketId,
        member.generation,
        int16ToFloat32(new Int16Array(data)),
        VOICE_SAMPLE_RATE
      )
    },
    [configurePeerDecoder, ensurePeerPlayback, playAudioChunk]
  )

  const handleVoiceUserJoined = useCallback(
    (payload: VoiceMember) => {
      if (!joinedRef.current || payload.socketId === socketRef.current?.id)
        return
      const previous = membersRef.current.get(payload.socketId)
      if (previous?.generation === payload.generation) return
      const previousIdentity = [...membersRef.current.entries()].find(
        ([, member]) => member.identity === payload.identity
      )
      if (previousIdentity) {
        const [previousSocketId, previousMember] = previousIdentity
        if (previousMember.generation >= payload.generation) return
        membersRef.current.delete(previousSocketId)
        cleanupPeerPlayback(previousSocketId)
      }
      membersRef.current.set(payload.socketId, payload)
      setMembers((current) => {
        const withoutIdentity = current.filter(
          (member) =>
            member.identity !== payload.identity &&
            member.socketId !== payload.socketId
        )
        return [...withoutIdentity, payload]
      })
      ensurePeerPlayback(payload)
      if (OPUS_SUPPORTED && codecDescriptionRef.current && roomIdRef.current) {
        socketRef.current?.emit('voice-codec-config', {
          roomId: roomIdRef.current,
          codec: 'opus',
          sampleRate: VOICE_SAMPLE_RATE,
          channels: VOICE_CHANNELS,
          description: codecDescriptionRef.current,
        })
      }
    },
    [cleanupPeerPlayback, ensurePeerPlayback]
  )

  const handleVoiceUserLeft = useCallback(
    (payload: VoiceMember) => {
      const current = membersRef.current.get(payload.socketId)
      if (current && current.generation !== payload.generation) return
      membersRef.current.delete(payload.socketId)
      cleanupPeerPlayback(payload.socketId)
      setMembers((previous) =>
        previous.filter((member) => member.socketId !== payload.socketId)
      )
      setVoiceMutedBySocket((previous) => {
        const next = new Set(previous)
        next.delete(payload.socketId)
        return next
      })
    },
    [cleanupPeerPlayback]
  )

  const handleVoiceMutedChanged = useCallback(
    (payload: {
      socketId: string
      identity?: string
      generation: number
      muted: boolean
    }) => {
      const member = membersRef.current.get(payload.socketId)
      const isSelf = payload.socketId === socketRef.current?.id
      if (!member || (!isSelf && member.generation !== payload.generation))
        return
      if (isSelf && member.generation !== payload.generation) {
        const updated = {
          ...member,
          identity: payload.identity ?? member.identity,
          generation: payload.generation,
        }
        membersRef.current.set(payload.socketId, updated)
        setMembers((current) =>
          current.map((item) =>
            item.socketId === payload.socketId ? updated : item
          )
        )
      }
      setVoiceMutedBySocket((previous) => {
        const next = new Set(previous)
        if (payload.muted) next.add(payload.socketId)
        else next.delete(payload.socketId)
        return next
      })
      if (payload.socketId === socketRef.current?.id) {
        selfMutedRef.current = payload.muted
        message[payload.muted ? 'warning' : 'success'](
          payload.muted ? '您已被管理员语音禁言' : '语音禁言已解除'
        )
      }
    },
    []
  )

  const handleVoiceKicked = useCallback(
    (payload: { roomId?: string }) => {
      if (payload.roomId && payload.roomId !== roomIdRef.current) return
      message.error('您已被管理员移出语音')
      leave()
    },
    [leave]
  )

  const emitModeration = useCallback(
    (event: 'voice-mute' | 'voice-unmute' | 'voice-kick', socketId: string) => {
      const currentSocket = socketRef.current
      const currentRoomId = roomIdRef.current
      if (!currentSocket || !currentRoomId) {
        return Promise.resolve({ success: false, message: '未连接' })
      }
      return new Promise<{ success: boolean; message?: string }>((resolve) => {
        currentSocket.emit(
          event,
          {
            roomId: currentRoomId,
            socketId,
            ...(event !== 'voice-kick'
              ? { muted: event === 'voice-mute' }
              : {}),
          },
          (response: { success: boolean; message?: string }) =>
            resolve(response ?? { success: false, message: '操作失败' })
        )
      })
    },
    []
  )

  useEffect(() => {
    if (!socket) return
    socket.on('voice-audio-data', handleVoiceAudioData)
    socket.on('voice-codec-config', handleVoiceCodecConfig)
    socket.on('voice-user-joined', handleVoiceUserJoined)
    socket.on('voice-user-left', handleVoiceUserLeft)
    socket.on('voice-muted-changed', handleVoiceMutedChanged)
    socket.on('voice-kicked', handleVoiceKicked)
    return () => {
      socket.off('voice-audio-data', handleVoiceAudioData)
      socket.off('voice-codec-config', handleVoiceCodecConfig)
      socket.off('voice-user-joined', handleVoiceUserJoined)
      socket.off('voice-user-left', handleVoiceUserLeft)
      socket.off('voice-muted-changed', handleVoiceMutedChanged)
      socket.off('voice-kicked', handleVoiceKicked)
    }
  }, [
    socket,
    handleVoiceAudioData,
    handleVoiceCodecConfig,
    handleVoiceUserJoined,
    handleVoiceUserLeft,
    handleVoiceMutedChanged,
    handleVoiceKicked,
  ])

  useEffect(() => {
    if (!socket) return
    const onDisconnect = () => {
      if (!joinedRef.current) return
      if (reconnectCleanupTimerRef.current)
        clearTimeout(reconnectCleanupTimerRef.current)
      reconnectCleanupTimerRef.current = setTimeout(() => {
        if (!socket.connected && joinedRef.current) {
          leave()
        }
      }, 15_000)
    }
    const onConnect = () => {
      if (!joinedRef.current || reconnectingRef.current) return
      reconnectingRef.current = true
      // Rejoin from a clean local lifecycle. Room modules may still be
      // restoring their Socket.IO room membership on this same connect event,
      // so use a short bounded retry window instead of racing the first ack.
      void (async () => {
        cleanupAll()
        for (const delayMs of [150, 300, 600, 1000]) {
          if (!socket.connected) return
          await new Promise((resolve) => setTimeout(resolve, delayMs))
          if (!socket.connected) return
          await join()
          if (joinedRef.current) return
        }
      })().finally(() => {
        reconnectingRef.current = false
      })
    }
    socket.on('disconnect', onDisconnect)
    socket.on('connect', onConnect)
    return () => {
      socket.off('disconnect', onDisconnect)
      socket.off('connect', onConnect)
      if (reconnectCleanupTimerRef.current)
        clearTimeout(reconnectCleanupTimerRef.current)
    }
  }, [cleanupAll, join, leave, socket])

  useEffect(() => {
    return () => {
      if (joinedRef.current || joiningRef.current) leave()
    }
  }, [leave])

  return {
    joined,
    joining,
    micEnabled,
    members,
    globalVolume,
    peerVolumes,
    peerLatencies,
    join,
    leave,
    toggleMic,
    setGlobalVolume,
    setPeerVolume,
    monitorEnabled,
    toggleMonitor,
    micVolume,
    setMicVolume,
    audioLevels,
    voiceMutedBySocket,
    muteVoiceMember: (socketId, muted) =>
      emitModeration(muted ? 'voice-mute' : 'voice-unmute', socketId),
    kickVoiceMember: (socketId) => emitModeration('voice-kick', socketId),
  }
}
