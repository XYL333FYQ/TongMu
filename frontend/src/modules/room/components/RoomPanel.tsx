import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Monitor, Users, Headphones, ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Space } from '@/components/ui/Space'
import { Title, Paragraph } from '@/components/ui/Typography'
import { Switch } from '@/components/ui/Switch'
import { Input } from '@/components/ui/Input'
import { useRoomStore, type RoomMode } from '@/store/roomStore'
import { useSocket } from '@/hooks/useSocket'
import { message } from '@/components/ui/message'
import { storeRoomMediaGrant } from '@/modules/media/roomMediaGrant'

interface RoomPanelProps {
  onModeSelected?: (mode: RoomMode) => void
}

export function RoomPanel({ onModeSelected }: RoomPanelProps) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { socket, connected } = useSocket()
  const {
    setMode,
    setRoomId,
    setRoomSettings,
    reset: resetRoomStore,
    mode: storeMode,
  } = useRoomStore()
  // 默认模式从 store 读取，不再从 URL 读取 mode 参数。
  // 模式切换由后端房间状态管理，URL 只保留 /room/:roomId 形式。
  const initialActivity = searchParams.get('activity')
  const [selectedActivity, setSelectedActivity] = useState<
    'watch' | 'listen' | 'screen'
  >(
    initialActivity === 'listen' ||
      initialActivity === 'screen' ||
      initialActivity === 'watch'
      ? initialActivity
      : storeMode === 'screen-share'
        ? 'screen'
        : 'watch'
  )
  const selectedMode: RoomMode =
    selectedActivity === 'screen' ? 'screen-share' : 'watch-together'
  const [creating, setCreating] = useState(false)
  const [requireApproval, setRequireApproval] = useState(false)
  const [password, setPassword] = useState('')

  const handleCreateRoom = () => {
    if (!socket || !connected) {
      message.warning('Socket 尚未连接')
      return
    }
    setCreating(true)
    socket.emit(
      'create-room',
      {
        password: password || undefined,
        requireApproval,
        mode: selectedMode,
      },
      (response: {
        success: boolean
        data?: { roomId: string; mode?: RoomMode; mediaGrant?: string }
        message?: string
      }) => {
        setCreating(false)
        const roomId = response.data?.roomId
        if (response.success && roomId) {
          storeRoomMediaGrant(roomId, response.data?.mediaGrant)
          // 若之前有一个保持中的房间（主动离开但未退出），创建新房间意味着
          // 真正放弃旧房间：旧房间房主此时 emit host-leave 进入宽限期。
          // 必须在 resetRoomStore() 清掉 activeRoomId 之前读取。
          try {
            const prevActive = useRoomStore.getState().activeRoomId
            if (
              prevActive &&
              sessionStorage.getItem('zcontrol-host-room') === prevActive
            ) {
              socket?.emit('host-leave', () => {
                /* ack */
              })
            }
          } catch {
            // ignore
          }
          // 创建新房间前先重置 store，清除上一个房间的 movies/currentMovieId 等残留状态。
          // RoomPage 的 reset effect 是异步的（在渲染后执行），如果不在这里同步清理，
          // navigate 后 MovieListPanel 等组件会在 reset 前渲染一帧旧数据。
          resetRoomStore()
          setRoomId(roomId)
          setMode(response.data?.mode || selectedMode)
          // 同步 requireApproval 到 store：创建房间时房主选择的值必须与后端一致，
          // 否则 RoomInfoPanel 显示的开关状态与后端实际审批逻辑不符。
          setRoomSettings({ requireApproval })
          message.success('房间创建成功')
          // 在 sessionStorage 中标记当前用户为该房间的房主，
          // 刷新页面后 RoomPage 据此判断身份并走 register-host 流程。
          // URL 保持干净：/room/:roomId，不带任何查询参数。
          try {
            sessionStorage.setItem('zcontrol-host-room', roomId)
            if (selectedActivity === 'listen') {
              sessionStorage.setItem(
                `tongmu-room-start-activity:${roomId}`,
                'listen'
              )
            }
          } catch {
            // sessionStorage 不可用时忽略，仅影响刷新后身份判断
          }
          navigate(`/room/${roomId}`, {
            replace: true,
          })
          onModeSelected?.(response.data?.mode || selectedMode)
        } else {
          message.error(response.message || '创建房间失败')
        }
      }
    )
  }

  return (
    <div className="tongmu-create-wrap flex-1 flex items-center justify-center p-6">
      <section className="tongmu-create w-full">
        <div className="text-center mb-6">
          <Title level={3} className="m-0">
            创建房间
          </Title>
          <Paragraph type="secondary" className="m-0 mt-2">
            选好想一起做的事，再邀请朋友进来
          </Paragraph>
        </div>

        <Space direction="vertical" className="w-full">
          <div className="tongmu-create__activities grid grid-cols-1 sm:grid-cols-3 gap-3">
            <button
              onClick={() => setSelectedActivity('screen')}
              aria-pressed={selectedActivity === 'screen'}
              className="tongmu-create__activity"
            >
              <div className="tongmu-create__icon">
                <Monitor className="h-6 w-6" />
              </div>
              <Title level={5} className="m-0">
                远程共享
              </Title>
              <Paragraph type="secondary" className="m-0 mt-1 text-xs">
                共享你的屏幕、摄像头或系统音频，观众实时观看
              </Paragraph>
            </button>

            <button
              onClick={() => setSelectedActivity('watch')}
              aria-pressed={selectedActivity === 'watch'}
              className="tongmu-create__activity"
            >
              <div className="tongmu-create__icon">
                <Users className="h-6 w-6" />
              </div>
              <Title level={5} className="m-0">
                一起看
              </Title>
              <Paragraph type="secondary" className="m-0 mt-1 text-xs">
                同步播放视频，支持直链、WebDAV、SMB 与 B站
              </Paragraph>
            </button>
            <button
              onClick={() => setSelectedActivity('listen')}
              aria-pressed={selectedActivity === 'listen'}
              className="tongmu-create__activity"
            >
              <div className="tongmu-create__icon tongmu-create__icon--music">
                <Headphones className="h-6 w-6" />
              </div>
              <Title level={5} className="m-0">
                一起听
              </Title>
              <Paragraph type="secondary" className="m-0 mt-1 text-xs">
                创建一起看房间后，直接打开已有的一起听播放队列
              </Paragraph>
            </button>
          </div>

          <div
            className="my-2"
            style={{
              height: '1px',
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-outline) 40%, transparent)',
            }}
          />

          <Space direction="vertical" className="w-full">
            <Switch
              label="需要确认加入"
              checked={requireApproval}
              onChange={(e) => setRequireApproval(e.target.checked)}
            />
            <Input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="房间密码（可选）"
            />
          </Space>

          <Button
            variant="primary"
            size="lg"
            icon={<ArrowRight className="h-5 w-5" />}
            block
            loading={creating}
            onClick={handleCreateRoom}
          >
            创建房间
          </Button>
        </Space>
      </section>
    </div>
  )
}
