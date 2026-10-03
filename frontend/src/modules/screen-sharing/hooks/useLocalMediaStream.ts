import { t, useTranslation } from '@/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { message } from '@/components/ui/message'
import {
  ROOM_MEDIA_TEARDOWN_EVENT,
  ROOM_STOP_SCREEN_EVENT,
  type RoomMediaTeardownDetail,
} from '@/lib/mediaTeardown'

export interface UseLocalMediaStreamOptions {
  frameRate: number
  maxBitrateMbps: number
  shareSystemAudio: boolean
  shareMicrophone: boolean
  /** 视频 track ended 时的回调（用于触发 close-room 等业务逻辑） */
  onStreamEnded?: () => void
  /** 本地预览 video 元素 ref（可选，用于自动绑定 srcObject） */
  localVideoRef?: RefObject<HTMLVideoElement | null>
}

export interface UseLocalMediaStreamResult {
  /** 当前本地 MediaStream（响应式，可在 useEffect 中依赖） */
  stream: MediaStream | null
  /** 麦克风 MediaStream（独立管理，未合并到 stream，传给 useHostPeerConnections） */
  micStream: MediaStream | null
  /** 是否正在共享 */
  isSharing: boolean
  /** 是否正在启动共享（等待 getDisplayMedia 授权弹窗） */
  starting: boolean
  /** 是否暂停（视频 track.enabled = false） */
  isPaused: boolean
  /** 错误信息 */
  error: string | null
  /** 开始共享：调用 getDisplayMedia + 合并麦克风 + applyConstraints */
  start: () => Promise<void>
  /** 停止共享：停止所有 track、清理 micStream、清空 video.srcObject */
  stop: () => void
  /** 暂停：设置视频 track.enabled = false */
  pause: () => void
  /** 恢复：设置视频 track.enabled = true */
  resume: () => void
}

export function useLocalMediaStream(
  options: UseLocalMediaStreamOptions
): UseLocalMediaStreamResult {
  useTranslation()

  const {
    frameRate,
    shareSystemAudio,
    shareMicrophone,
    onStreamEnded,
    localVideoRef,
  } = options

  const [stream, setStream] = useState<MediaStream | null>(null)
  const [micStream, setMicStream] = useState<MediaStream | null>(null)
  const [isSharing, setIsSharing] = useState(false)
  const [starting, setStarting] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const localStreamRef = useRef<MediaStream | null>(null)
  const micStreamRef = useRef<MediaStream | null>(null)

  // 用 ref 持有最新的 onStreamEnded，避免 start 函数依赖变化导致重建
  const onStreamEndedRef = useRef(onStreamEnded)
  useEffect(() => {
    onStreamEndedRef.current = onStreamEnded
  }, [onStreamEnded])

  const stop = useCallback(() => {
    localStreamRef.current?.getTracks().forEach((track) => track.stop())
    localStreamRef.current = null
    micStreamRef.current?.getTracks().forEach((track) => track.stop())
    micStreamRef.current = null
    setMicStream(null)
    if (localVideoRef?.current) {
      localVideoRef.current.srcObject = null
    }
    setStream(null)
    setIsSharing(false)
    setIsPaused(false)
  }, [localVideoRef])

  useEffect(() => {
    const teardown = (event: Event) => {
      if ((event as CustomEvent<RoomMediaTeardownDetail>).detail.full) stop()
      else
        localStreamRef.current?.getTracks().forEach((track) => {
          track.enabled = false
        })
    }
    window.addEventListener(ROOM_STOP_SCREEN_EVENT, stop)
    window.addEventListener(ROOM_MEDIA_TEARDOWN_EVENT, teardown)
    return () => {
      window.removeEventListener(ROOM_STOP_SCREEN_EVENT, stop)
      window.removeEventListener(ROOM_MEDIA_TEARDOWN_EVENT, teardown)
    }
  }, [stop])

  const start = useCallback(async () => {
    // 防重复点击：正在启动或正在共享时直接返回
    if (starting || isSharing) return

    // 前置检查 1：getDisplayMedia 仅在安全上下文（HTTPS 或 localhost）可用
    if (
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getDisplayMedia !== 'function'
    ) {
      const isLocalhost =
        window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1'
      let reason: string
      if (window.isSecureContext || isLocalhost) {
        reason = t(
          'Screen sharing is unavailable in this browser. Try a current desktop version of Chrome, Edge or Firefox.'
        )
      } else {
        reason = t(
          'Your browser requires HTTPS or localhost for screen sharing. Open the secure TongMu address, or ask the administrator to enable HTTPS.'
        )
      }
      setError(reason)
      message.error(reason)
      return
    }

    // 前置检查 2：iframe 嵌套环境检测
    // getDisplayMedia 在 iframe 中需要父页面通过 allow="display-capture" 授权，
    // 否则调用时会抛 NotSupportedError。IDE 内置预览（如 trae-preview）即属于此类场景。
    const inIframe = (() => {
      try {
        return window.self !== window.top
      } catch {
        // 跨域 iframe 访问 window.top 会抛错，视为 iframe 环境
        return true
      }
    })()
    if (inIframe) {
      // document.featurePolicy 在标准 TS 类型中不存在，使用类型断言
      const docWithPolicy = document as Document & {
        featurePolicy?: { allowedFeatures(): string[] }
      }
      const allowed =
        typeof docWithPolicy.featurePolicy !== 'undefined' &&
        docWithPolicy.featurePolicy
          .allowedFeatures()
          .includes('display-capture')
      if (!allowed) {
        const reason = t(
          'This embedded page cannot capture your screen. Open this room in a separate browser window: {url}',
          { url: window.location.href }
        )
        setError(reason)
        message.error(
          t('Open this room in a separate window to share your screen.')
        )
        return
      }
    }

    setError(null)
    setStarting(true)
    try {
      const useTestStream =
        new URLSearchParams(window.location.search).get('testStream') === 'true'

      // 帧率约束：max 设置硬上限，ideal 设置期望值。
      // 屏幕共享场景下浏览器会在画面静止时主动降帧（节能优化），
      // 后续通过 contentHint='motion' + 编码器 maxFramerate 共同保证输出帧率。
      //
      // 分辨率约束：仅使用 ideal，不设置 max。
      // Firefox 对 getDisplayMedia 的 max 约束解释与 Chrome 不同：
      // 当 max 恰好等于显示器原生分辨率时，Firefox 会将其视为严格约束，
      // 在无法精确匹配时回退到下一级标准分辨率（通常是 720p）。
      // 移除 max 后，Firefox 和 Chrome 都会以 ideal 为目标选择最接近的可用分辨率。
      const videoConstraints: MediaTrackConstraints = {
        frameRate: { ideal: frameRate, max: frameRate },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      }

      let mediaStream: MediaStream
      if (useTestStream) {
        message.info(
          t('Test mode: using the camera instead of screen sharing.')
        )
        mediaStream = await navigator.mediaDevices.getUserMedia({
          video: {
            ...videoConstraints,
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: shareSystemAudio,
        })
      } else {
        mediaStream = await navigator.mediaDevices.getDisplayMedia({
          video: videoConstraints,
          audio: shareSystemAudio,
        })
      }

      if (shareMicrophone) {
        try {
          const nextMicStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          })
          micStreamRef.current = nextMicStream
          setMicStream(nextMicStream)
        } catch (err) {
          console.error('[useLocalMediaStream] getUserMedia mic error:', err)
          message.warning(
            t(
              'Microphone access was unavailable. Your screen will still be shared.'
            )
          )
        }
      }

      localStreamRef.current = mediaStream
      setStream(mediaStream)
      setIsSharing(true)
      setIsPaused(false)

      // 对视频轨道应用目标帧率约束并设置 contentHint
      // - contentHint='motion' 告知浏览器/编码器内容为动态画面，避免静止检测降帧
      // - applyConstraints 使用 max 硬约束帧率上限，避免编码器超过目标帧率浪费带宽
      // - 分辨率兜底：部分浏览器（尤其 Firefox）在 getDisplayMedia 时可能返回
      //   低于 ideal 的分辨率（如 720p），此处尝试通过 applyConstraints 提升到 1080p
      // - 必须 await 确保 PC 建立前约束已生效
      await Promise.all(
        mediaStream.getVideoTracks().map(async (track) => {
          track.contentHint = 'motion'
          const settingsBefore = track.getSettings()
          console.log(
            '[useLocalMediaStream] track settings before applyConstraints:',
            settingsBefore
          )

          // 分辨率兜底：如果浏览器返回的分辨率低于 1080p，尝试提升
          // applyConstraints 对分辨率的调整能力有限（取决于捕获源），
          // 但在某些场景下能从 720p 提升到 1080p
          if (
            settingsBefore.width &&
            settingsBefore.height &&
            (settingsBefore.width < 1920 || settingsBefore.height < 1080)
          ) {
            try {
              await track.applyConstraints({
                width: { ideal: 1920 },
                height: { ideal: 1080 },
              })
              const afterResolution = track.getSettings()
              console.log(
                '[useLocalMediaStream] resolution upgrade attempt:',
                `${settingsBefore.width}x${settingsBefore.height}`,
                '->',
                `${afterResolution.width}x${afterResolution.height}`
              )
            } catch (err) {
              console.warn(
                '[useLocalMediaStream] applyConstraints resolution error:',
                err
              )
            }
          }

          try {
            await track.applyConstraints({
              frameRate: { max: frameRate },
            })
            const settings = track.getSettings()
            console.log(
              '[useLocalMediaStream] applied frameRate constraint, actual:',
              settings.frameRate,
              'target:',
              frameRate,
              'resolution:',
              `${settings.width}x${settings.height}`
            )
          } catch (err) {
            console.warn(
              '[useLocalMediaStream] applyConstraints frameRate error:',
              err
            )
          }
        })
      )

      mediaStream.getVideoTracks().forEach((track) => {
        console.log(
          '[useLocalMediaStream] video track:',
          track.label,
          'enabled:',
          track.enabled,
          'muted:',
          track.muted,
          'settings:',
          track.getSettings()
        )
        track.addEventListener('unmute', () => {
          console.log('[useLocalMediaStream] video track unmuted')
        })
        track.addEventListener('mute', () => {
          console.warn('[useLocalMediaStream] video track muted')
        })
      })

      // 视频 track 结束时（如用户通过浏览器 UI 停止共享）触发回调
      mediaStream.getVideoTracks()[0]?.addEventListener('ended', () => {
        onStreamEndedRef.current?.()
      })
    } catch (err) {
      console.error('[useLocalMediaStream] getDisplayMedia error:', err)
      // 区分错误类型给出明确提示
      const errName = (err as { name?: string })?.name
      let reason = t(
        'Unable to start screen sharing. Check your browser permissions and try again.'
      )
      if (errName === 'NotAllowedError') {
        reason = t(
          'Screen sharing was cancelled or denied. Choose a screen, window or tab and try again.'
        )
      } else if (errName === 'NotFoundError') {
        reason = t('No screen, window or tab is available to share.')
      } else if (errName === 'NotReadableError') {
        reason = t(
          'Your screen could not be captured. Close other capture apps and try again.'
        )
      } else if (errName === 'OverconstrainedError') {
        reason = t(
          'These capture settings are unavailable. Lower the frame rate or resolution and try again.'
        )
      } else if (errName === 'TypeError') {
        reason = t(
          'The capture settings are invalid. Check the media settings and try again.'
        )
      } else if (errName === 'NotSupportedError') {
        // 兜底：iframe 未授权 / 浏览器不支持 / 系统未启用屏幕捕获
        const inIframe = (() => {
          try {
            return window.self !== window.top
          } catch {
            return true
          }
        })()
        reason = inIframe
          ? t(
              'This embedded page cannot capture your screen. Open this room in a separate browser window: {url}',
              { url: window.location.href }
            )
          : t(
              'Screen capture is unavailable. Try a current desktop browser and enable screen capture in your system permissions.'
            )
      }
      setError(reason)
      message.error(reason)
    } finally {
      setStarting(false)
    }
  }, [frameRate, shareSystemAudio, shareMicrophone, starting, isSharing])

  const pause = useCallback(() => {
    localStreamRef.current?.getVideoTracks().forEach((track) => {
      track.enabled = false
    })
    setIsPaused(true)
  }, [])

  const resume = useCallback(() => {
    localStreamRef.current?.getVideoTracks().forEach((track) => {
      track.enabled = true
    })
    setIsPaused(false)
  }, [])

  // 自动绑定 video.srcObject，stream 变化时同步预览
  useEffect(() => {
    const video = localVideoRef?.current
    if (!video) return
    // eslint-disable-next-line react-hooks/immutability -- 修改 DOM 元素属性，非 React 状态
    video.srcObject = stream
    if (stream) {
      void video.play().catch((err) => {
        console.warn('[useLocalMediaStream] video play error:', err)
      })
    }
    return () => {
      video.srcObject = null
    }
  }, [stream, localVideoRef])

  // 组件卸载时自动清理
  useEffect(() => {
    return () => {
      stop()
    }
  }, [stop])

  return {
    stream,
    micStream,
    isSharing,
    starting,
    isPaused,
    error,
    start,
    stop,
    pause,
    resume,
  }
}
