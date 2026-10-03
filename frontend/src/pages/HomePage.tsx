import { t, useTranslation } from '@/i18n'
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
    label: 'Watch together',
    description: 'Watch synchronized video and share every scene with friends.',
    icon: Clapperboard,
    tone: 'watch',
    activity: 'watch',
    detail: 'Add content in a room and keep playback in sync with friends.',
    action: 'Create a watch room',
  },
  {
    label: 'Music',
    description: 'Listen in sync and share your favorite music.',
    icon: Headphones,
    tone: 'listen',
    activity: 'listen',
    detail: 'Add music, manage the queue and listen together in a room.',
    action: 'Create a room for music',
  },
  {
    label: 'Screen sharing',
    description: 'Share your screen and explore more together.',
    icon: MonitorUp,
    tone: 'screen',
    activity: 'screen',
    detail: 'Share your screen and system audio with friends in a room.',
    action: 'Create a screen-sharing room',
  },
  {
    label: 'Live chat',
    description: 'Chat in a room and share the moment.',
    icon: MessageCircle,
    tone: 'chat',
    activity: 'chat',
    detail:
      'Chat, on-screen comments and voice are available in each room. Find your friends and join in.',
    action: 'Find a room',
  },
] as const
type ExperienceActivity = (typeof experiences)[number]['activity']

export default function HomePage({
  directory,
}: {
  directory: RoomDirectoryView
}) {
  useTranslation()
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
            <h1 id="home-title">{t('Watch and listen together.')}</h1>
            <p>
              {t(
                'Watch videos, follow shows, listen to music and share screens in one room.'
              )}
              <br />
              {t('Make time for the people who enjoy the same things.')}
            </p>
            <div className="tongmu-home__hero-actions">
              <button
                type="button"
                className="tongmu-home__primary-action"
                disabled={!guest && !canCreate}
                onClick={() => startRoom('watch')}
              >
                <Plus className="h-5 w-5" aria-hidden="true" />
                {t('Create room')}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
            {!guest && !canCreate && (
              <p className="tongmu-home__permission">
                {user?.status === 'pending'
                  ? t(
                      'Your account is awaiting approval and cannot create a room yet.'
                    )
                  : t('Only administrators can create rooms on this server.')}
              </p>
            )}
          </div>
          <span className="tongmu-home__connection" role="status">
            <Radio className="h-3.5 w-3.5" aria-hidden="true" />
            {connected
              ? t('Connected')
              : autoLoginStatus !== 'done'
                ? t('Connecting…')
                : t('Connection unavailable')}
          </span>
        </section>

        <section
          className="tongmu-home__experiences"
          aria-label={t('Activities in TongMu')}
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
                  <strong>{t(label)}</strong>
                  <span>{t(description)}</span>
                  <small>
                    {t('Learn more')}{' '}
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
                    {t(experience.label)}
                  </span>
                  <p>{t(experience.detail)}</p>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    selectedExperience === 'chat'
                      ? guardNavigate('/rooms')
                      : startRoom(selectedExperience)
                  }
                >
                  {t(experience.action)}{' '}
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
              <p className="tongmu-home__section-kicker">
                {t('Keep spending time together')}
              </p>
              <h2 id="continue-title">
                {activeRoomName || t('Return to your room')}
              </h2>
            </div>
            <button
              type="button"
              onClick={() => navigate(roomPath(activeRoomId) ?? '/')}
            >
              {t('Return to room')}
              <ArrowRight className="h-4 w-4" />
            </button>
          </section>
        )}

        <section className="tongmu-home__rooms" aria-labelledby="rooms-title">
          <div className="tongmu-home__section-head">
            <h2 id="rooms-title">
              <span aria-hidden="true">✦</span> {t('Active rooms')}
            </h2>
            <button type="button" onClick={() => navigate('/rooms')}>
              {t('View all')}
              <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
          {roomsLoading ? (
            <p className="tongmu-home__room-message" role="status">
              {t('Finding rooms…')}
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
                <p>{t('There are no public rooms yet.')}</p>
                <p>
                  {t("Have a friend's room ID?")}{' '}
                  <button type="button" onClick={() => setJoinOpen(true)}>
                    {t('Join by room ID')}
                    <ArrowRight className="h-4 w-4" />
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
                      {room.mode === 'screen-share'
                        ? t('Screen sharing')
                        : t('Watch together')}
                    </span>
                  </span>
                  <span className="tongmu-home__room-info">
                    <strong>{room.name || t('Untitled room')}</strong>
                    <span>
                      <i aria-hidden="true" />
                      {room.sharerOnline
                        ? t('Host online')
                        : t('Host is offline')}
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
