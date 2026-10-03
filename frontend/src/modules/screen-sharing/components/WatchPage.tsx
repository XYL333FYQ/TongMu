import { t, useTranslation } from '@/i18n'
/**
 * 观众端分发器。
 *
 * 分离式架构：根据 roomMode + shareMethod 分发到不同子组件。
 * - watch-together → RoomLayout + WatchTogetherPanel（一起看模式）
 * - screen-share + stream-push → StreamPushViewer（OBS 推流拉流）
 * - screen-share + webrtc → WebrtcWatchPage（WebRTC 接收）
 *
 * 分发器职责：
 * 1. 加入房间流程（useJoinRoom）
 * 2. 子模式状态订阅（useStreamStatus / useShareMethod）
 * 3. 未加入时的 JoinRoomForm / 加载动画
 *
 * WebRTC 和 OBS 推流的业务逻辑互不感知，各自在子组件中独立实现。
 */
import { useState } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { message } from '@/components/ui/message'
import { useSocket } from '@/hooks/useSocket'
import { useRoomStore } from '@/store/roomStore'
import { Spinner } from '@/components/ui/Spinner'
import { Text } from '@/components/ui/Typography'
import { CommentPanel } from '@/components/CommentPanel'
import { WatchTogetherPanel } from '@/modules/room/watch-together/WatchTogetherPanel'
import { usePlayerRemountKey } from '@/modules/room/watch-together/usePlayerRemountKey'
import { RoomLayout } from '@/modules/room/components/RoomLayout'
import { RoomInfoPanel } from '@/modules/room/components/RoomInfoPanel'
import { MovieListPanel } from '@/modules/room/components/MovieListPanel'
import { MoviePushPanel } from '@/modules/room/components/MoviePushPanel'
import { useRoomExperienceStore } from '@/store/roomExperienceStore'
import { TogetherListenPanel } from '@/modules/music'
import { useJoinRoom } from '../hooks/useJoinRoom'
import { useStreamStatus } from '../hooks/useStreamStatus'
import { useShareMethod } from '../hooks/useShareMethod'
import { JoinRoomForm } from './JoinRoomForm'
import StreamPushViewer from './StreamPushViewer'
import WebrtcWatchPage from './WebrtcWatchPage'
import SharePage from './SharePage'
import type { P2PStateSnapshot } from './WebrtcSharePage'
import type { JoinFormValues } from '../types'
import { roomPath } from '@/lib/roomDirectory'
import { useAuthStore } from '@/store/authStore'
import { getGuestNickname } from '@/modules/room/guestNickname'
import { Button } from '@/components/ui/Button'

function WatchPage() {
  useTranslation()

  const { roomId } = useParams<{ roomId?: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const { socket, connected } = useSocket()

  // 从房间列表进入时携带的 state：{ fromList, hasPassword, name }
  // - hasPassword=true：显示密码输入框，不自动 requestJoin（避免空密码触发"密码错误"）
  // - hasPassword=false：显示加载动画，useJoinRoom 自动 requestJoin
  const navState = location.state as {
    fromList?: boolean
    hasPassword?: boolean
    name?: string | null
  } | null
  const fromList = navState?.fromList === true
  const listHasPassword = navState?.hasPassword === true
  const listRoomName = navState?.name ?? null

  const [isWebFullscreen, setIsWebFullscreen] = useState(false)
  const [screenConnection, setScreenConnection] =
    useState<RTCPeerConnection | null>(null)
  const [screenP2P, setScreenP2P] = useState<P2PStateSnapshot>({
    enabled: false,
    pc: null,
    status: 'idle',
    fallbackNotice: false,
    toggle: () => {},
  })

  // 1. 加入房间 hook
  // 分离式架构下不再需要 onApprovedScreenShare / onRoomModeChanged 创建 PC：
  // WebrtcWatchPage 挂载时自动 create PC，卸载时自动 cleanup PC。
  const { joinStatus, joinError, roomMode, requestJoin } = useJoinRoom({
    socket,
    roomId,
    connected,
    autoJoin: !(fromList && listHasPassword),
  })

  // 2. 推流子模式状态（仅 screen-share + stream-push 时使用）
  const streamStatus = useStreamStatus(socket, roomId ?? '')
  const { shareMethod } = useShareMethod(socket, roomId ?? '', false)
  const streamKey = useRoomStore((state) => state.streamKey)
  const exitRoom = useRoomStore((state) => state.exitRoom)
  const isGuest = useAuthStore((state) => state.user?.role === 'guest')
  const experience = useRoomExperienceStore((state) => state.snapshot)
  const actingHost = experience?.host.socketId === socket?.id && !!socket?.id
  const canSelect = experience?.permissions.selectContent ?? false

  // 切换影片时强制整个播放器重挂载（与房主端一致，跨引擎切换彻底清理）
  const playerRemountKey = usePlayerRemountKey()

  // 3.1 已加入且 roomMode === 'watch-together'：观众使用与房主统一的 RoomLayout
  if (joinStatus === 'approved' && roomMode) {
    return (
      <RoomLayout
        roomId={roomId ?? ''}
        isHost={false}
        peerConnection={screenConnection}
        sharingRole={
          experience?.screenPresenter === socket?.id ? 'sender' : 'receiver'
        }
        p2pEnabled={screenP2P.enabled}
        p2pPC={screenP2P.pc}
        p2pStatus={screenP2P.status}
        p2pFallbackNotice={screenP2P.fallbackNotice}
        onToggleP2P={screenP2P.toggle}
        mainContent={
          <>
            <div
              className="tm-stage-layer"
              hidden={roomMode !== 'watch-together'}
            >
              <WatchTogetherPanel
                key={playerRemountKey}
                roomId={roomId ?? ''}
                isHost={actingHost}
                isWebFullscreen={isWebFullscreen}
                onToggleWebFullscreen={() =>
                  setIsWebFullscreen((prev) => !prev)
                }
              />
            </div>
            {roomMode === 'screen-share' &&
              (shareMethod === 'stream-push' ? (
                <StreamPushViewer
                  roomId={roomId ?? ''}
                  streamKey={streamKey ?? roomId ?? ''}
                  streamStatus={streamStatus}
                  embedded
                />
              ) : experience?.permissions.screenShare &&
                (!experience.screenPresenter ||
                  experience.screenPresenter === socket?.id) ? (
                <SharePage
                  onStatsPeerConnectionChange={setScreenConnection}
                  onP2PStateChange={setScreenP2P}
                />
              ) : (
                <WebrtcWatchPage
                  roomId={roomId ?? ''}
                  embedded
                  onStatsPeerConnectionChange={setScreenConnection}
                  onP2PStateChange={setScreenP2P}
                />
              ))}
          </>
        }
        rightPanel={
          <CommentPanel
            socket={socket}
            roomId={roomId ?? ''}
            commentsOnly={false}
          />
        }
        controls={
          <>
            <RoomInfoPanel roomId={roomId ?? ''} isHost={false} />
            <MovieListPanel isHost={canSelect} />
            <MoviePushPanel isHost />
            <TogetherListenPanel roomId={roomId ?? ''} isHost={false} />
          </>
        }
        controlLabels={['Members', 'Queue', 'Add content', 'Music']}
        webFullscreen={isWebFullscreen}
      />
    )
  }

  // 4. 未加入或加入失败：根据入口来源渲染不同 UI
  // - 从房间列表进入的无密码房间：显示加载动画（useJoinRoom 正在自动加入）
  // - 从房间列表进入的有密码房间：显示密码输入框（隐藏房间号）
  // - 其他情况（直接访问 URL）：显示完整的 JoinRoomForm
  if (
    fromList &&
    !listHasPassword &&
    !joinError &&
    !(isGuest && !getGuestNickname()) &&
    (joinStatus === 'idle' || joinStatus === 'joining')
  ) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6">
        <Spinner tip={t('Joining your room…')} size={48} />
        {listRoomName && <Text type="secondary">{listRoomName}</Text>}
      </div>
    )
  }
  if (joinStatus === 'waiting')
    return (
      <div className="room-joining-state">
        <Spinner tip={t("Waiting for the host's approval…")} size={36} />
        <p>
          {t(
            'Your request is waiting. You will join here as soon as the host approves it.'
          )}
        </p>
        <Button
          onClick={() => {
            socket?.emit('room:join:cancel', { roomId })
            exitRoom()
            navigate('/')
          }}
        >
          {t('Cancel request and return')}
        </Button>
      </div>
    )

  const handleJoin = (values: JoinFormValues) => {
    if (!values.roomId.trim()) {
      message.warning(t('Enter a room ID.'))
      return
    }
    const targetRoomId = values.roomId.trim()
    if (targetRoomId !== roomId) {
      navigate(roomPath(targetRoomId) ?? '/')
    } else {
      requestJoin(targetRoomId, values.password ?? '', values.nickname)
    }
  }

  return (
    <JoinRoomForm
      initialRoomId={roomId ?? ''}
      joinStatus={joinStatus}
      error={joinError}
      onSubmit={handleJoin}
      onBack={() => {
        exitRoom()
        navigate('/')
      }}
      hideRoomId={fromList && listHasPassword}
      roomName={
        fromList && listHasPassword ? (listRoomName ?? undefined) : undefined
      }
      passwordRequired={fromList && listHasPassword}
    />
  )
}

export default WatchPage
