import { t, useTranslation } from '@/i18n'
/**
 * 房主端投屏分发器。
 *
 * 分离式架构：根据 shareMethod 分发到 WebRTC 或 OBS 推流子组件。
 * - webrtc → WebrtcSharePage（本地媒体流 + PeerConnection）
 * - stream-push → StreamPushPage（OBS 推流配置 + FLV 拉流预览）
 *
 * 分发器职责：
 * 1. 子模式切换 UI（SegmentedToggle）
 * 2. join-request 审批通知（两种子模式共用）
 * 3. 切换到 stream-push 时清除 WebRTC 共享状态
 *
 * WebRTC 和 OBS 推流的业务逻辑互不感知，各自在子组件中独立实现。
 */
import { useCallback, useEffect, useState } from 'react'
import { useSocket } from '@/hooks/useSocket'
import { useRoomStore } from '@/store/roomStore'
import { SegmentedToggle } from '@/components/ui/SegmentedToggle'
import { message } from '@/components/ui/message'
import { RequestNotification } from '@/components/ui/RequestNotification'
import type { RequestNotificationItem } from '@/components/ui/RequestNotification'
import { useShareMethod } from '../hooks/useShareMethod'
import { useStreamStatus } from '../hooks/useStreamStatus'
import WebrtcSharePage, { type P2PStateSnapshot } from './WebrtcSharePage'
import { StreamPushPage } from './StreamPushPage'
import { useRoomExperienceStore } from '@/store/roomExperienceStore'

interface SharePageProps {
  className?: string
  style?: React.CSSProperties
  onStatsPeerConnectionChange?: (pc: RTCPeerConnection | null) => void
  /** P2P 状态变化回调，透传到 RoomPage 供 RoomLayout 使用 */
  onP2PStateChange?: (state: P2PStateSnapshot) => void
}

function SharePage({
  className,
  style,
  onStatsPeerConnectionChange,
  onP2PStateChange,
}: SharePageProps) {
  useTranslation()

  const { socket } = useSocket()
  const setIsSharing = useRoomStore((state) => state.setIsSharing)
  const roomId = useRoomStore((state) => state.roomId)
  const currentRoomId = roomId ?? ''
  const canChangeMethod =
    useRoomExperienceStore((state) => state.snapshot?.permissions.settings) ??
    true

  // 推流子模式状态（房主端独有）
  const streamStatus = useStreamStatus(socket, currentRoomId)
  const { shareMethod, updateShareMethod } = useShareMethod(
    socket,
    currentRoomId,
    true
  )

  const handleShareMethodChange = useCallback(
    (value: string) => {
      if (value === shareMethod) return
      // 切换到 webrtc 前提示先停止 OBS 推流
      if (value === 'webrtc' && streamStatus === 'live') {
        message.warning(
          t('Stop the OBS stream before changing to browser sharing.')
        )
        return
      }
      void updateShareMethod(value as 'webrtc' | 'stream-push').then((res) => {
        if (!res.success) {
          message.error(
            res.message ?? t('Could not change the sharing method.')
          )
        }
      })
    },
    [shareMethod, streamStatus, updateShareMethod]
  )

  // 观众加入审批（两种子模式共用）
  const [confirmJoin, setConfirmJoin] = useState<{
    viewerSocketId: string
  } | null>(null)

  useEffect(() => {
    if (!socket) return
    const handleJoinRequest = (data: { viewerSocketId: string }) => {
      if (useRoomExperienceStore.getState().snapshot) return
      setConfirmJoin({ viewerSocketId: data.viewerSocketId })
    }
    socket.on('join-request', handleJoinRequest)
    return () => void socket.off('join-request', handleJoinRequest)
  }, [socket])

  const handleApproveJoin = useCallback(() => {
    if (!confirmJoin || !socket) return
    const viewerSocketId = confirmJoin.viewerSocketId
    socket.emit(
      'approve-join',
      { viewerSocketId },
      (response: { success: boolean; message?: string }) => {
        if (response.success) message.success(t('Request accepted.'))
        else
          message.error(response.message ?? t('Could not accept the request.'))
      }
    )
    setConfirmJoin(null)
  }, [confirmJoin, socket])

  const handleRejectJoin = useCallback(() => {
    if (!confirmJoin || !socket) return
    const viewerSocketId = confirmJoin.viewerSocketId
    socket.emit(
      'reject-join',
      { viewerSocketId },
      (response: { success: boolean; message?: string }) => {
        if (response.success) message.info(t('Join request declined.'))
        else
          message.error(
            response.message ?? t('Unable to decline this request.')
          )
      }
    )
    setConfirmJoin(null)
  }, [confirmJoin, socket])

  const joinRequestNotifications: RequestNotificationItem[] = []
  if (confirmJoin) {
    joinRequestNotifications.push({
      id: 'join',
      title: t('Join request'),
      okText: t('Allow'),
      cancelText: t('Decline'),
      onOk: handleApproveJoin,
      onCancel: handleRejectJoin,
      autoCloseMs: 12000,
      content: (
        <>
          {t('Someone wants to join the room (')}
          <span style={{ color: 'var(--md-sys-color-primary)' }}>
            {confirmJoin.viewerSocketId.slice(0, 8)}
          </span>
          {t('). Allow them to join?')}
        </>
      ),
    })
  }

  const handleCloseJoinNotification = useCallback((id: string) => {
    if (id === 'join') setConfirmJoin(null)
  }, [])

  // 切换到 stream-push 子模式时强制标记为非 WebRTC 共享状态。
  // stream-push 仍使用 aspect-video 布局，由 StreamPushPage 内部滚动承载配置 UI。
  useEffect(() => {
    if (shareMethod === 'stream-push') {
      setIsSharing(false)
    }
  }, [shareMethod, setIsSharing])

  return (
    <div className="relative h-full w-full">
      {/* 房主端子模式切换（WebRTC 共享 / OBS stream） */}
      {canChangeMethod && (
        <div className="absolute left-1/2 top-3 z-20 -translate-x-1/2">
          <SegmentedToggle
            options={[
              { value: 'webrtc', label: t('Browser sharing') },
              { value: 'stream-push', label: t('OBS stream') },
            ]}
            value={shareMethod}
            onChange={handleShareMethodChange}
          />
        </div>
      )}

      {shareMethod === 'stream-push' ? (
        <div className="h-full w-full pt-16">
          <StreamPushPage roomId={currentRoomId} />
        </div>
      ) : (
        <WebrtcSharePage
          className={className}
          style={style}
          onStatsPeerConnectionChange={onStatsPeerConnectionChange}
          onP2PStateChange={onP2PStateChange}
        />
      )}

      <RequestNotification
        items={joinRequestNotifications}
        onClose={handleCloseJoinNotification}
      />
    </div>
  )
}

export default SharePage
