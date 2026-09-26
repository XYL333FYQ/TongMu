import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  Clapperboard,
  Headphones,
  MessageCircle,
  MonitorUp,
  Play,
  Plus,
  Radio,
  Users,
} from 'lucide-react'
import { JoinRoomDialog } from '@/components/JoinRoomDialog'
import { useRoomExitGuard } from '@/hooks/useRoomExitGuard'
import type { RoomDirectoryView } from '@/hooks/useRoomDirectory'
import { featuredRooms, roomPath } from '@/lib/roomDirectory'
import { useAuthStore } from '@/store/authStore'
import { useRoomStore } from '@/store/roomStore'
import { useSystemSettingsStore } from '@/store/systemSettingsStore'
import { useSocket } from '@/hooks/useSocket'

const experiences = [
  {
    label: '一起看',
    description: '同步播放视频，与朋友共享每一幕。',
    icon: Clapperboard,
    tone: 'watch',
    activity: 'watch',
    detail: '在房间里添加影片，播放进度会与朋友同步。',
    action: '创建一起看房间',
  },
  {
    label: '一起听',
    description: '同步听音乐，分享喜欢的旋律。',
    icon: Headphones,
    tone: 'listen',
    activity: 'listen',
    detail: '房间里的「一起听」可以添加音乐、管理播放队列，并同步播放。',
    action: '创建房间并打开一起听',
  },
  {
    label: '屏幕共享',
    description: '分享你的屏幕，一起看更多内容。',
    icon: MonitorUp,
    tone: 'screen',
    activity: 'screen',
    detail: '进入屏幕共享房间后，可与朋友分享屏幕和系统音频。',
    action: '创建屏幕共享房间',
  },
  {
    label: '实时聊天',
    description: '在房间里聊天，分享此刻的心情。',
    icon: MessageCircle,
    tone: 'chat',
    activity: 'chat',
    detail: '聊天、弹幕和语音都在房间内。先找到朋友的房间，再一起交流。',
    action: '寻找房间',
  },
] as const
type ExperienceActivity = (typeof experiences)[number]['activity']

export default function HomePage({
  directory,
}: {
  directory: RoomDirectoryView
}) {
  const navigate = useNavigate()
  const { guardNavigate, confirmModal } = useRoomExitGuard()
  const { user, autoLoginStatus } = useAuthStore()
  const roomCreationMode = useSystemSettingsStore(
    (state) => state.roomCreationMode
  )
  const activeRoomId = useRoomStore((state) => state.activeRoomId)
  const activeRoomName = useRoomStore((state) => state.roomName)
  const setRoomMode = useRoomStore((state) => state.setMode)
  const { connected } = useSocket()
  const [joinOpen, setJoinOpen] = useState(false)
  const [selectedExperience, setSelectedExperience] =
    useState<ExperienceActivity | null>(null)
  const { rooms, loading: roomsLoading, error: roomsError } = directory
  const guest = !user || user.role === 'guest'
  const canCreate =
    !!user &&
    user.role !== 'guest' &&
    user.status !== 'pending' &&
    (user.role === 'root' ||
      user.role === 'admin' ||
      roomCreationMode === 'all-users')

  const startRoom = (activity: Exclude<ExperienceActivity, 'chat'>) => {
    if (!canCreate) {
      if (guest) guardNavigate('/login')
      return
    }
    setRoomMode(activity === 'screen' ? 'screen-share' : 'watch-together')
    guardNavigate(`/room?activity=${activity}`)
  }

  const visibleFeaturedRooms = featuredRooms(rooms)

  return (
    <>
      <div className="tongmu-home">
        <section className="tongmu-home__hero" aria-labelledby="home-title">
          <img
            className="tongmu-home__hero-image"
            src="/home-hero.png"
            alt=""
          />
          <div className="tongmu-home__hero-copy">
            <h1 id="home-title">一起看，也一起听。</h1>
            <p>
              在同一个房间里看视频、追番、听音乐、共享屏幕。
              <br />
              和有相同喜好的伙伴，一起创造更多美好的时光。
            </p>
            <div className="tongmu-home__hero-actions">
              <button
                type="button"
                className="tongmu-home__primary-action"
                disabled={!guest && !canCreate}
                onClick={() => startRoom('watch')}
              >
                <Plus className="h-5 w-5" aria-hidden="true" />
                创建房间
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            {!guest && !canCreate && (
              <p className="tongmu-home__permission">
                {user?.status === 'pending'
                  ? '账号正在等待审核，暂时不能创建房间。'
                  : '当前站点仅允许管理员创建房间。'}
              </p>
            )}
          </div>
          <span className="tongmu-home__connection" role="status">
            <Radio className="h-3.5 w-3.5" aria-hidden="true" />
            {connected
              ? '已连接'
              : autoLoginStatus !== 'done'
                ? '连接中…'
                : '连接暂不可用'}
          </span>
        </section>

        <section
          className="tongmu-home__experiences"
          aria-label="在 TongMu 一起做什么"
        >
          {experiences.map(
            ({ label, description, icon: Icon, tone, activity }) => (
              <button
                key={label}
                type="button"
                className={`tongmu-home__experience${selectedExperience === activity ? ' is-selected' : ''}`}
                aria-expanded={selectedExperience === activity}
                aria-controls="home-experience-detail"
                onClick={() =>
                  setSelectedExperience(
                    selectedExperience === activity ? null : activity
                  )
                }
              >
                <span className={`tongmu-home__experience-icon is-${tone}`}>
                  <Icon className="h-6 w-6" aria-hidden="true" />
                </span>
                <span className="tongmu-home__experience-copy">
                  <strong>{label}</strong>
                  <span>{description}</span>
                  <small>
                    了解更多{' '}
                    <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
                  </small>
                </span>
              </button>
            )
          )}
        </section>

        {selectedExperience &&
          (() => {
            const experience = experiences.find(
              (item) => item.activity === selectedExperience
            )!
            return (
              <div
                id="home-experience-detail"
                className="tongmu-home__experience-detail"
              >
                <div>
                  <span className="tongmu-home__experience-detail-label">
                    {experience.label}
                  </span>
                  <p>{experience.detail}</p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    selectedExperience === 'chat'
                      ? guardNavigate('/rooms')
                      : startRoom(selectedExperience)
                  }
                >
                  {experience.action}{' '}
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            )
          })()}

        {activeRoomId && (
          <section
            className="tongmu-home__continue"
            aria-labelledby="continue-title"
          >
            <div>
              <p className="tongmu-home__section-kicker">继续相聚</p>
              <h2 id="continue-title">{activeRoomName || '返回当前房间'}</h2>
            </div>
            <button
              type="button"
              onClick={() => navigate(roomPath(activeRoomId) ?? '/')}
            >
              回到房间 <ArrowRight className="h-4 w-4" />
            </button>
          </section>
        )}

        <section className="tongmu-home__rooms" aria-labelledby="rooms-title">
          <div className="tongmu-home__section-head">
            <h2 id="rooms-title">
              <span aria-hidden="true">✦</span> 正在进行的房间
            </h2>
            <button type="button" onClick={() => navigate('/rooms')}>
              查看全部 <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          {roomsLoading ? (
            <p className="tongmu-home__room-message" role="status">
              正在获取房间…
            </p>
          ) : roomsError ? (
            <p className="tongmu-home__room-message" role="alert">
              {roomsError}
            </p>
          ) : visibleFeaturedRooms.length === 0 ? (
            <div className="tongmu-home__empty">
              <span className="tongmu-home__empty-icon" aria-hidden="true">
                <Users className="h-5 w-5" />
              </span>
              <div className="tongmu-home__empty-copy">
                <p>暂时还没有公开房间。</p>
                <p>
                  有朋友的房间号？{' '}
                  <button type="button" onClick={() => setJoinOpen(true)}>
                    输入房间号加入 <ArrowRight className="h-4 w-4" />
                  </button>
                </p>
              </div>
            </div>
          ) : (
            <div className="tongmu-home__room-list">
              {visibleFeaturedRooms.map((room) => (
                <button
                  key={room.roomId}
                  type="button"
                  className="tongmu-home__room"
                  onClick={() => navigate(roomPath(room.roomId) ?? '/')}
                >
                  <span className="tongmu-home__room-visual" aria-hidden="true">
                    {room.mode === 'screen-share' ? (
                      <MonitorUp className="h-9 w-9" />
                    ) : (
                      <Play className="h-9 w-9" />
                    )}
                    <span>
                      {room.mode === 'screen-share' ? '屏幕共享' : '一起看'}
                    </span>
                  </span>
                  <span className="tongmu-home__room-info">
                    <strong>{room.name || '未命名房间'}</strong>
                    <span>
                      <i aria-hidden="true" />
                      {room.sharerOnline ? '房主在线' : '房主离线'}
                      <span className="tongmu-home__room-count">
                        <Users className="h-3.5 w-3.5" aria-hidden="true" />
                        {room.viewerCount}
                        {room.maxViewers > 0 ? ` / ${room.maxViewers}` : ''}
                      </span>
                    </span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
      <JoinRoomDialog
        open={joinOpen}
        onClose={() => setJoinOpen(false)}
        onJoin={guardNavigate}
      />
      {confirmModal}
    </>
  )
}
