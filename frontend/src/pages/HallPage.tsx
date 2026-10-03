import { t, useTranslation } from '@/i18n'
import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  ArrowUpRight,
  Film,
  Headphones,
  Monitor,
  Plus,
  RefreshCw,
  Search,
  Users,
  Lock,
  DoorOpen,
} from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import { useSystemSettingsStore } from '@/store/systemSettingsStore'
import { useRoomDirectory } from '@/hooks/useRoomDirectory'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { JoinRoomDialog } from '@/components/JoinRoomDialog'
import { RoomCoverImage } from '@/components/RoomCoverImage'
import { roomPath } from '@/lib/roomDirectory'

/** The old home and discovery URLs share one directory and one set of actions. */
export default function HallPage() {
  useTranslation()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const { authResolved, isAuthenticated, user } = useAuthStore()
  const { rooms, loading, error, refresh } = useRoomDirectory(
    authResolved,
    isAuthenticated,
    user?.id
  )
  const creationMode = useSystemSettingsStore((s) => s.roomCreationMode)
  const canCreate =
    !!user &&
    user.status !== 'pending' &&
    user.role !== 'guest' &&
    (creationMode === 'all-users' ||
      user.role === 'root' ||
      user.role === 'admin')
  const [activity, setActivity] = useState('all')
  const [joinOpen, setJoinOpen] = useState(false)
  const query = params.get('q') ?? ''
  const visible = rooms.filter(
    (room) =>
      room.status === 'active' &&
      (activity === 'all' ||
        (room.activity ??
          (room.mode === 'screen-share' ? 'screen' : 'watch')) === activity) &&
      `${room.name ?? ''} ${room.roomId}`
        .toLowerCase()
        .includes(query.trim().toLowerCase())
  )
  const icons = { watch: Film, listen: Headphones, screen: Monitor }
  const labels = {
    watch: t('Watch together'),
    listen: t('Listen together'),
    screen: t('Screen sharing'),
  }

  return (
    <section className="tm-hall" aria-labelledby="hall-title">
      <header className="tm-hall-heading">
        <div>
          <p className="tm-eyebrow">{t('YOUR SHARED SPACE')}</p>
          <h1 id="hall-title">{t('Room hall')}</h1>
          <p>{t('Find your people. Pick something to enjoy together.')}</p>
        </div>
        <div className="tm-hall-actions">
          <Button
            variant="secondary"
            icon={<DoorOpen size={18} />}
            onClick={() => setJoinOpen(true)}
          >
            {t('Join by ID')}
          </Button>
          {canCreate && (
            <Button icon={<Plus size={18} />} onClick={() => navigate('/room')}>
              {t('Create room')}
            </Button>
          )}
        </div>
      </header>
      <div className="tm-directory-toolbar">
        <div className="tm-filter-group" aria-label={t('Filter by activity')}>
          {['all', 'watch', 'listen', 'screen'].map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={activity === value}
              onClick={() => setActivity(value)}
            >
              {value === 'all'
                ? t('All rooms')
                : value === 'watch'
                  ? t('Watch')
                  : value === 'listen'
                    ? t('Listen')
                    : t('Screen')}
            </button>
          ))}
        </div>
        <label className="tm-directory-search">
          <Search size={18} aria-hidden="true" />
          <input
            aria-label={t('Search rooms')}
            placeholder={t('Search name or room ID')}
            value={query}
            onChange={(e) => {
              const next = new URLSearchParams(params)
              if (e.target.value) next.set('q', e.target.value)
              else next.delete('q')
              setParams(next, { replace: true })
            }}
          />
        </label>
        <Button
          variant="ghost"
          icon={<RefreshCw size={18} />}
          aria-label={t('Refresh rooms')}
          disabled={loading}
          onClick={() => void refresh()}
        />
      </div>
      <div className="tm-directory-count" role="status">
        {loading
          ? t('Finding rooms…')
          : t(
              visible.length === 1
                ? '{count} room available'
                : '{count} rooms available',
              { count: visible.length }
            )}
        <span>
          {t('Private rooms are available through a link or exact ID.')}
        </span>
      </div>
      {loading ? (
        <div className="tm-directory-empty">
          <Spinner tip={t('Loading rooms…')} />
        </div>
      ) : error ? (
        <div className="tm-directory-empty" role="alert">
          <h2>{t('Could not load rooms')}</h2>
          <p>{t('Please check your connection and try again.')}</p>
          <Button onClick={() => void refresh()}>{t('Try again')}</Button>
        </div>
      ) : !isAuthenticated ? (
        <div className="tm-directory-empty">
          <h2>{t('Connecting to TongMu')}</h2>
          <p>
            {t(
              'Check your server connection if this takes longer than expected.'
            )}
          </p>
        </div>
      ) : visible.length === 0 ? (
        <div className="tm-directory-empty">
          <div className="tm-empty-symbol">
            <Users size={32} />
          </div>
          <h2>
            {query || activity !== 'all'
              ? t('No matching rooms')
              : t('A little quiet here')}
          </h2>
          <p>
            {query || activity !== 'all'
              ? t('Try another name, room ID, or activity.')
              : canCreate
                ? t('Create a room above, or join a friend with their room ID.')
                : t(
                    'Join a friend with their room ID, or choose an available room.'
                  )}
          </p>
        </div>
      ) : (
        <div className="tm-room-grid">
          {visible.map((room) => {
            const kind =
              room.activity ??
              (room.mode === 'screen-share' ? 'screen' : 'watch')
            const Icon = icons[kind]
            const accessLabel = room.requireApproval
              ? t('Approval required')
              : room.allowGuests === false
                ? t('Members only')
                : room.hasPassword
                  ? t('Password protected')
                  : null
            const roomName =
              room.name || t('Room {value1}', { value1: room.roomId })
            return (
              <article className="tm-room-card" key={room.roomId}>
                <div className={`tm-room-art tm-room-art--${kind}`}>
                  <RoomCoverImage
                    roomId={room.roomId}
                    coverUrl={room.coverUrl}
                  />
                  <span className="tm-room-presence">
                    <span data-online={room.sharerOnline} />
                    {room.sharerOnline ? t('Host online') : t('Host away')}
                  </span>
                  <div className="tm-room-card-type">
                    <Icon size={15} strokeWidth={1.7} aria-hidden="true" />
                    {labels[kind]}
                  </div>
                  {accessLabel && (
                    <span className="tm-room-access">
                      {room.hasPassword && (
                        <Lock size={12} aria-label={t('Password protected')} />
                      )}
                      {accessLabel}
                    </span>
                  )}
                </div>
                <div className="tm-room-card-body">
                  <h2 title={roomName}>{roomName}</h2>
                  <div className="tm-room-card-footer">
                    <div className="tm-room-card-details">
                      <p className="tm-room-card-meta">
                        <Users size={14} aria-hidden="true" />
                        {room.viewerCount} / {room.maxViewers}
                      </p>
                      <small>#{room.roomId}</small>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<ArrowUpRight size={16} />}
                      onClick={() =>
                        navigate(roomPath(room.roomId) ?? '/', {
                          state: {
                            fromList: true,
                            hasPassword: room.hasPassword,
                            name: room.name,
                          },
                        })
                      }
                    >
                      {t('Join room')}
                    </Button>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      )}
      <JoinRoomDialog
        open={joinOpen}
        onClose={() => setJoinOpen(false)}
        onJoin={(path) => navigate(path)}
      />
    </section>
  )
}
