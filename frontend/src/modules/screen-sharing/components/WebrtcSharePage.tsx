import { t, useTranslation } from '@/i18n'
/**
 * WebRTC 屏幕共享房主端。
 *
 * 从 SharePage.tsx 中拆分，仅处理 WebRTC 子模式的房主逻辑：
 * - 本地媒体流采集（getDisplayMedia + 麦克风）
 * - 多 viewer PeerConnection 管理
 * - 信令通道订阅
 * - 本地预览播放器 + 批注层 + 控制栏
 *
 * SharePage 分发器根据 shareMethod 决定渲染本组件或 StreamPushPage。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Monitor, Copy, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/Button'
import { Space } from '@/components/ui/Space'
import { Text, Paragraph } from '@/components/ui/Typography'
import { Tag } from '@/components/ui/Tag'
import { ConfirmModal } from '@/components/ui/Modal'
import { LiveArtPlayer } from '@/modules/art-player'
import { useSocket } from '@/hooks/useSocket'
import { useRoomStore } from '@/store/roomStore'
import { AnnotationLayer } from '@/components/AnnotationLayer'
import { message } from '@/components/ui/message'
import { useLocalMediaStream } from '../hooks/useLocalMediaStream'
import { useHostPeerConnections } from '../hooks/useHostPeerConnections'
import { useSignalingChannel } from '../hooks/useSignalingChannel'
import { useP2PTunnel } from '@/modules/p2p'
import type { P2PStatus } from '@/modules/p2p/types'
import { MediaSettingsCard } from './MediaSettingsCard'
import { ShareControlsBar } from './ShareControlsBar'
import { SharingPausedOverlay } from './SharingPausedOverlay'
import type { RoomModeChangedPayload } from '../types'
import { ROOM_STOP_SCREEN_EVENT } from '@/lib/mediaTeardown'

/** P2P 状态快照，由 WebrtcSharePage 提升到 RoomPage 供 RoomLayout 使用 */
export interface P2PStateSnapshot {
  enabled: boolean
  pc: RTCPeerConnection | null
  status: P2PStatus
  fallbackNotice: boolean
  /** 切换 P2P 开关（enabled=true Enable，false 禁用） */
  toggle: (enabled: boolean) => void
}

interface WebrtcSharePageProps {
  className?: string
  style?: React.CSSProperties
  onStatsPeerConnectionChange?: (pc: RTCPeerConnection | null) => void
  /** P2P 状态变化回调，提升到 RoomPage 供 RoomLayout 的 SharingStatusPanel 使用 */
  onP2PStateChange?: (state: P2PStateSnapshot) => void
}

function WebrtcSharePage({
  className,
  style,
  onStatsPeerConnectionChange,
  onP2PStateChange,
}: WebrtcSharePageProps) {
  useTranslation()

  const { socket, connected } = useSocket()
  const setMode = useRoomStore((state) => state.setMode)
  const setIsSharing = useRoomStore((state) => state.setIsSharing)
  const roomId = useRoomStore((state) => state.roomId)
  const currentRoomId = roomId ?? ''

  const [frameRate, setFrameRate] = useState(30)
  const [maxBitrateMbps, setMaxBitrateMbps] = useState(8)
  const [shareSystemAudio, setShareSystemAudio] = useState(false)
  const [shareMicrophone, setShareMicrophone] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)

  // 帧率切换时自动调整推荐码率（仅在未共享时）
  // 码率不足是 60fps 降帧的首要原因，自动提升到推荐值避免用户手动调整
  const handleFrameRateChange = useCallback((next: number) => {
    setFrameRate(next)
    // 推荐码率：15fps→4, 30fps→8, 45fps→12, 60fps→16
    const recommended = Math.max(2, Math.round(next * 0.267))
    setMaxBitrateMbps((prev) => {
      // 仅当当前码率低于推荐值时自动提升，不覆盖用户主动设置的高码率
      if (prev < recommended) return recommended
      return prev
    })
  }, [])

  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const [localVideoEl, setLocalVideoEl] = useState<HTMLVideoElement | null>(
    null
  )
  const handleLocalVideoReady = useCallback((node: HTMLVideoElement | null) => {
    localVideoRef.current = node
    setLocalVideoEl(node)
  }, [])
  const handleStreamEndedRef = useRef<() => void>(() => {})

  const {
    stream,
    micStream,
    isSharing,
    starting,
    isPaused,
    error: mediaError,
    start,
    stop,
    pause,
    resume,
  } = useLocalMediaStream({
    frameRate,
    maxBitrateMbps,
    shareSystemAudio,
    shareMicrophone,
    onStreamEnded: () => handleStreamEndedRef.current(),
    localVideoRef,
  })

  const {
    connectionCount,
    statsPeerConnection,
    viewerIds,
    handleSignalAnswer,
    handleSignalIceCandidate,
    handleViewerReady,
    handleViewerJoined,
    handleViewerLeft,
    cleanup: cleanupPeerConnections,
  } = useHostPeerConnections({
    socket,
    localStream: stream,
    micStream,
    frameRate,
    maxBitrateMbps,
  })

  const handleStreamEnded = useCallback(() => {
    stop()
    cleanupPeerConnections()
    if (!socket) return
    socket.emit('room:screen:stop', { roomId: currentRoomId })
  }, [stop, cleanupPeerConnections, socket, currentRoomId])

  useEffect(() => {
    handleStreamEndedRef.current = handleStreamEnded
  }, [handleStreamEnded])

  useEffect(() => {
    if (localVideoEl && stream && localVideoEl.srcObject !== stream) {
      // eslint-disable-next-line react-hooks/immutability -- 修改 DOM 元素属性，非 React 状态
      localVideoEl.srcObject = stream
      void localVideoEl.play().catch(() => {})
    }
  }, [localVideoEl, stream])

  const handleRoomModeChanged = useCallback(
    (data: RoomModeChangedPayload) => {
      setMode(data.mode)
      if (data.mode === 'watch-together') {
        stop()
        cleanupPeerConnections()
      }
    },
    [setMode, stop, cleanupPeerConnections]
  )

  const handleStopSharing = useCallback(() => {
    stop()
    cleanupPeerConnections()
  }, [stop, cleanupPeerConnections])

  useEffect(() => {
    const stopRoomScreen = (data: { roomId: string }) => {
      if (data.roomId === currentRoomId) handleStopSharing()
    }
    socket?.on('room:stop-screen', stopRoomScreen)
    window.addEventListener(ROOM_STOP_SCREEN_EVENT, handleStopSharing)
    return () => {
      socket?.off('room:stop-screen', stopRoomScreen)
      window.removeEventListener(ROOM_STOP_SCREEN_EVENT, handleStopSharing)
    }
  }, [currentRoomId, socket, handleStopSharing])

  const handleClearAnnotations = useCallback(() => {
    if (!socket || !currentRoomId) return
    socket.emit(
      'clear-annotations',
      { roomId: currentRoomId },
      (response: { success: boolean; message?: string }) => {
        if (!response.success)
          message.error(response.message ?? t('Could not clear annotations.'))
      }
    )
  }, [socket, currentRoomId])

  const handleCopy = useCallback(() => {
    navigator.clipboard
      .writeText(`${window.location.origin}/room/${currentRoomId}`)
      .then(() => message.success(t('Invite link copied.')))
  }, [currentRoomId])

  const handleCopyError = useCallback(() => {
    if (!mediaError) return
    navigator.clipboard
      .writeText(mediaError)
      .then(() => message.success(t('Error details copied.')))
      .catch(() =>
        message.error(
          t('Could not copy. Select the text and copy it manually.')
        )
      )
  }, [mediaError])

  const inIframe = (() => {
    try {
      return window.self !== window.top
    } catch {
      return true
    }
  })()

  const handleOpenInNewWindow = useCallback(() => {
    window.open(window.location.href, '_blank', 'noopener,noreferrer')
  }, [])

  const handleTogglePause = useCallback(() => {
    if (isPaused) resume()
    else pause()
  }, [isPaused, pause, resume])

  const handleRefresh = useCallback(async () => {
    stop()
    cleanupPeerConnections()
    await start()
  }, [stop, cleanupPeerConnections, start])

  useSignalingChannel({
    socket,
    onSignalAnswer: handleSignalAnswer,
    onSignalIceCandidate: handleSignalIceCandidate,
    onViewerReady: handleViewerReady,
    onViewerJoined: handleViewerJoined,
    onViewerLeft: handleViewerLeft,
    onRoomModeChanged: handleRoomModeChanged,
  })

  // P2P 直连隧道（房主为 sender，使用第一个观众作为对端）
  const [p2pFallbackNotice, setP2pFallbackNotice] = useState(false)
  const firstViewerId = viewerIds[0] ?? null
  const { enableP2P, disableP2P, p2pEnabled, p2pPC, p2pStatus } = useP2PTunnel({
    socket,
    roomId: currentRoomId,
    localStream: stream,
    role: 'sender',
    remotePeerId: firstViewerId,
    onStatusChange: (status, didFallback) => {
      if (didFallback) {
        setP2pFallbackNotice(true)
        message.warning(t('Peer connection failed. Using server relay.'))
      } else if (status === 'connected') {
        setP2pFallbackNotice(false)
        message.success(t('Peer connection established.'))
      } else if (status === 'connecting') {
        setP2pFallbackNotice(false)
      }
    },
  })

  // 房主切换 P2P 开关：触发 hook enable/disable，并广播给房间内其他成员
  const handleToggleP2P = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        void enableP2P()
      } else {
        disableP2P()
      }
      if (socket && currentRoomId) {
        socket.emit('p2p-mode-change', { roomId: currentRoomId, enabled })
      }
    },
    [enableP2P, disableP2P, socket, currentRoomId]
  )

  // 接收房间内 P2P 模式广播（观众端同步开关状态）
  useEffect(() => {
    if (!socket) return
    const handleP2PModeChange = (data: {
      roomId: string
      enabled: boolean
    }) => {
      if (!currentRoomId || data.roomId !== currentRoomId) return
      if (data.enabled) {
        void enableP2P()
      } else {
        disableP2P()
      }
    }
    socket.on('p2p-mode-change', handleP2PModeChange)
    return () => {
      socket.off('p2p-mode-change', handleP2PModeChange)
    }
  }, [socket, currentRoomId, enableP2P, disableP2P])

  // 上报 P2P 状态到父组件（含 toggle 方法，供 SharingStatusPanel 开关调用）
  useEffect(() => {
    onP2PStateChange?.({
      enabled: p2pEnabled,
      pc: p2pPC,
      status: p2pStatus,
      fallbackNotice: p2pFallbackNotice,
      toggle: handleToggleP2P,
    })
  }, [
    p2pEnabled,
    p2pPC,
    p2pStatus,
    p2pFallbackNotice,
    handleToggleP2P,
    onP2PStateChange,
  ])

  useEffect(() => {
    onStatsPeerConnectionChange?.(statsPeerConnection)
  }, [statsPeerConnection, onStatsPeerConnectionChange])

  useEffect(() => {
    setIsSharing(isSharing)
  }, [isSharing, setIsSharing])

  // 房主开始共享时广播 sharer-ready
  useEffect(() => {
    if (!isSharing || !socket || !currentRoomId) return
    socket
      .timeout(8000)
      .emit(
        'sharer-ready',
        { roomId: currentRoomId },
        (
          timeout: Error | null,
          response?: { success: boolean; message?: string }
        ) => {
          if (timeout || !response?.success) {
            stop()
            cleanupPeerConnections()
            message.error(
              timeout
                ? t('Sharing was not confirmed. Try again.')
                : (response?.message ??
                    t('Could not start sharing. Try again.'))
            )
          }
        }
      )
  }, [isSharing, socket, currentRoomId, stop, cleanupPeerConnections])

  if (!currentRoomId) {
    return (
      <div
        className={cn('flex h-full items-center justify-center p-6', className)}
        style={style}
      >
        <Paragraph type="secondary">
          {t(
            'This room is unavailable. Return to the hall to create or join a room.'
          )}
        </Paragraph>
      </div>
    )
  }

  return (
    <div className={cn('relative h-full w-full', className)} style={style}>
      {isSharing ? (
        <>
          <div
            className="h-full w-full"
            style={{ opacity: isPaused ? 0.6 : 1 }}
          >
            <LiveArtPlayer
              muted
              showControls={false}
              onVideoReady={handleLocalVideoReady}
            />
          </div>
          <AnnotationLayer socket={socket} roomId={currentRoomId} readOnly />
          <SharingPausedOverlay visible={isPaused} />
          <ShareControlsBar
            isPaused={isPaused}
            connected={connected}
            viewerCount={viewerIds.length}
            connectionCount={connectionCount}
            closing={false}
            onTogglePause={handleTogglePause}
            onCopyLink={handleCopy}
            onClearAnnotations={handleClearAnnotations}
            onClose={() => setConfirmClose(true)}
            onRefresh={handleRefresh}
          />
        </>
      ) : (
        <div className="flex h-full min-h-0 flex-col items-center justify-center gap-5 overflow-y-auto p-6 pt-20">
          <div
            className="glass-card w-full max-w-sm rounded-2xl border p-6 shadow-sm"
            style={{
              borderColor:
                'color-mix(in srgb, var(--md-sys-color-outline) 30%, transparent)',
              backgroundColor: 'var(--glass-bg)',
              backdropFilter: 'blur(var(--glass-blur-strong))',
              WebkitBackdropFilter: 'blur(var(--glass-blur-strong))',
            }}
          >
            <div className="mb-5 flex items-center justify-between">
              <Space align="center" size="sm">
                <Monitor className="h-5 w-5 text-[var(--md-sys-color-primary)]" />
                <Text className="text-base font-semibold">
                  {t('Share your screen')}
                </Text>
              </Space>
              <Tag color={connected ? 'success' : 'default'}>
                {connected ? t('Connected') : t('Disconnected')}
              </Tag>
            </div>

            <MediaSettingsCard
              frameRate={frameRate}
              maxBitrateMbps={maxBitrateMbps}
              shareSystemAudio={shareSystemAudio}
              shareMicrophone={shareMicrophone}
              isSharing={isSharing}
              onFrameRateChange={handleFrameRateChange}
              onMaxBitrateChange={setMaxBitrateMbps}
              onShareSystemAudioChange={setShareSystemAudio}
              onShareMicrophoneChange={setShareMicrophone}
            />

            <Button
              variant="primary"
              className="mt-5 w-full"
              icon={<Monitor className="h-5 w-5" />}
              onClick={start}
              loading={starting}
              disabled={starting}
            >
              {starting ? t('Waiting for screen access…') : t('Share screen')}
            </Button>
          </div>

          {inIframe && (
            <div
              className="w-full max-w-sm rounded-xl border px-4 py-3 text-xs"
              style={{
                borderColor: 'var(--md-sys-color-outline-variant)',
                backgroundColor: 'var(--md-sys-color-tertiary-container)',
              }}
            >
              <Paragraph type="secondary" className="m-0 mb-2 text-xs">
                {t(
                  'Your browser may restrict sharing inside an embedded page. Open this room in a separate tab.'
                )}
              </Paragraph>
              <Button
                variant="secondary"
                size="sm"
                className="w-full"
                icon={<ExternalLink className="h-3.5 w-3.5" />}
                onClick={handleOpenInNewWindow}
              >
                {t('Open in a new tab')}
              </Button>
            </div>
          )}

          {mediaError && (
            <div
              className="relative w-full max-w-sm rounded-xl border px-4 py-3 text-xs"
              style={{
                borderColor: 'var(--md-sys-color-error-container)',
                backgroundColor: 'var(--md-sys-color-error-container)',
              }}
            >
              <Paragraph
                type="danger"
                className="m-0 whitespace-pre-line pr-8 text-xs"
              >
                {t(mediaError)}
              </Paragraph>
              <button
                type="button"
                onClick={handleCopyError}
                className="absolute right-2 top-2 rounded p-1 opacity-70 hover:opacity-100"
                style={{
                  color: 'var(--md-sys-color-on-error-container)',
                  backgroundColor: 'transparent',
                }}
                title={t('Copy error details')}
              >
                <Copy className="h-3.5 w-3.5" />
              </button>
            </div>
          )}

          <Paragraph
            type="secondary"
            className="!text-white m-0 max-w-sm text-center text-xs"
          >
            {t(
              'Use Copy invite link above to invite people. Room joining rules still apply.'
            )}
          </Paragraph>
        </div>
      )}

      <ConfirmModal
        open={confirmClose}
        onClose={() => setConfirmClose(false)}
        onOk={() => {
          setConfirmClose(false)
          handleStopSharing()
        }}
        onCancel={() => setConfirmClose(false)}
        title={t('Stop sharing')}
        okText={t('Stop sharing')}
        cancelText={t('Cancel')}
      >
        {t(
          'This stops the screen stream for everyone. Your room stays open. You can share again or switch activities.'
        )}
      </ConfirmModal>
    </div>
  )
}

export default WebrtcSharePage
