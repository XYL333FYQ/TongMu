import { t, useTranslation } from '@/i18n'
import {
  Children,
  Fragment,
  isValidElement,
  useState,
  type ReactNode,
} from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  Film,
  Headphones,
  Monitor,
  MessageSquare,
  Users,
  ListVideo,
  Plus,
  LogOut,
  Settings,
  Share2,
  PanelRightClose,
  PanelRight,
  VolumeX,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { LanguageSwitch } from '@/components/LanguageSwitch'
import { Modal } from '@/components/ui/Modal'
import { useSocket } from '@/hooks/useSocket'
import { useRoomStore } from '@/store/roomStore'
import { useRoomExperienceStore } from '@/store/roomExperienceStore'
import { leaveCurrentRoom } from '@/modules/room/leaveRoom'
import { roomErrorMessage } from '@/modules/room/roomErrors'
import type { RoomActivity } from '@/modules/room/roomExperience'
import { ActivityDiscussion } from './ActivityDiscussion'
import { RoomPolicySettings } from './RoomPolicySettings'
import { SharingStatusPanel } from './SharingStatusPanel'
import type { SharingMode } from '@/modules/screen-sharing/hooks/useConnectionStats'
import type { P2PStatus } from '@/modules/p2p/types'

interface RoomLayoutProps {
  roomId: string
  isHost: boolean
  title?: string
  onBack?: () => void
  headerActions?: ReactNode
  mainContent: ReactNode
  controls?: ReactNode
  rightPanel: ReactNode
  controlLabels?: string[]
  peerConnection?: RTCPeerConnection | null
  sharingRole?: 'sender' | 'receiver'
  sharingMode?: SharingMode
  p2pEnabled?: boolean
  p2pPC?: RTCPeerConnection | null
  p2pStatus?: P2PStatus
  p2pFallbackNotice?: boolean
  onToggleP2P?: (enabled: boolean) => void
  sharingActive?: boolean
  webFullscreen?: boolean
}
function flatten(node: ReactNode): ReactNode[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<{ children?: ReactNode }>(child) && child.type === Fragment
      ? flatten(child.props.children)
      : [child]
  )
}
const activities = [
  { value: 'watch', label: 'Watch', Icon: Film },
  { value: 'listen', label: 'Listen', Icon: Headphones },
  { value: 'screen', label: 'Screen', Icon: Monitor },
] as const

/** One activity stage, one collaboration rail, one content picker. Panels stay mounted. */
export function RoomLayout({
  roomId,
  isHost,
  title,
  onBack,
  headerActions,
  mainContent,
  controls,
  rightPanel,
  controlLabels = [],
  webFullscreen = false,
  peerConnection = null,
  sharingRole,
  sharingMode = 'server-relay',
  p2pEnabled = false,
  p2pPC = null,
  p2pStatus = 'idle',
  p2pFallbackNotice = false,
  onToggleP2P,
}: RoomLayoutProps) {
  useTranslation()

  const navigate = useNavigate()
  const { socket, connected } = useSocket()
  const experience = useRoomExperienceStore((s) => s.snapshot)
  const localMuted = useRoomExperienceStore((s) => s.localMuted)
  const roomName = useRoomStore((s) => s.roomName)
  const mode = useRoomStore((s) => s.mode)
  const hasVideo = useRoomStore((s) => !!s.watchTogether.sourceUrl)
  const activity =
    experience?.activity ?? (mode === 'screen-share' ? 'screen' : 'watch')
  const [tab, setTab] = useState<'chat' | 'members' | 'queue'>('chat')
  const [railOpen, setRailOpen] = useState(true)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [screenWarning, setScreenWarning] = useState<RoomActivity | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const children = flatten(controls)
  const find = (names: string[]) =>
    children[controlLabels.findIndex((label) => names.includes(label))]
  const members = find(['房间状态', 'Room', 'Members'])
  const queue = find(['Queue', 'Queue'])
  const picker = find(['Add content', 'Sources', 'Add content'])
  const music = find(['Music', 'Music'])
  const canSwitch = experience?.permissions.switchActivity ?? isHost
  const canSelect = experience?.permissions.selectContent ?? isHost
  const canSettings = experience?.permissions.settings ?? isHost
  const performSwitch = (next: RoomActivity) => {
    if (!socket || !connected || busy || next === activity) return
    setBusy(true)
    setError('')
    socket
      .timeout(8000)
      .emit(
        canSwitch ? 'room:activity:switch' : 'room:activity:request',
        { roomId, activity: next },
        (
          timeout: Error | null,
          response: { success: boolean; message?: string }
        ) => {
          setBusy(false)
          if (timeout || !response?.success)
            setError(
              timeout
                ? t('The request timed out. Please try again.')
                : roomErrorMessage(response?.message)
            )
          else if (!canSwitch) setError(t('Your request was sent to the host.'))
        }
      )
  }
  const switchActivity = (next: RoomActivity) =>
    activity === 'screen' && canSwitch
      ? setScreenWarning(next)
      : performSwitch(next)
  const exit = async () => {
    setBusy(true)
    setError('')
    try {
      await leaveCurrentRoom(socket)
      navigate('/')
    } catch (e) {
      setError(e instanceof Error ? e.message : t('Could not leave the room.'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div
      className={`tm-room-workspace${webFullscreen ? ' tm-room-workspace--fullscreen' : ''}`}
    >
      <header className="tm-room-toolbar">
        <Button
          variant="ghost"
          icon={<ArrowLeft size={18} />}
          onClick={onBack ?? (() => navigate('/'))}
        >
          {t('Hall')}
        </Button>
        <div className="tm-room-title">
          <strong>
            {title || roomName || t('Room {value1}', { value1: roomId })}
          </strong>
          <span>
            #{roomId} ·{' '}
            {experience?.isDelegate
              ? t('Acting host')
              : connected
                ? t('Connected')
                : t('Reconnecting')}
          </span>
        </div>
        <div className="tm-room-toolbar-actions">
          {localMuted && (
            <Button
              variant="secondary"
              icon={<VolumeX size={18} />}
              aria-label={t('Unmute room sound')}
              title={t('Room sound is muted. Click to unmute.')}
              onClick={() =>
                useRoomExperienceStore.getState().setLocalMuted(false)
              }
            />
          )}
          <Button
            variant="ghost"
            icon={<Share2 size={18} />}
            aria-label={t('Copy invite link')}
            onClick={() => {
              void navigator.clipboard
                .writeText(`${window.location.origin}/room/${roomId}`)
                .then(
                  () => setError(t('Invite link copied.')),
                  () =>
                    setError(
                      t(
                        'Could not copy. Share the room address from your browser.'
                      )
                    )
                )
            }}
          />
          <LanguageSwitch />
          {canSettings && (
            <Button
              variant="ghost"
              icon={<Settings size={18} />}
              aria-label={t('Room settings')}
              onClick={() => setSettingsOpen(true)}
            />
          )}
          <Button
            variant="ghost"
            icon={
              railOpen ? (
                <PanelRightClose size={18} />
              ) : (
                <PanelRight size={18} />
              )
            }
            aria-label={
              railOpen ? t('Hide room sidebar') : t('Show room sidebar')
            }
            aria-expanded={railOpen}
            onClick={() => setRailOpen(!railOpen)}
          />
          <Button
            variant="ghost"
            icon={<LogOut size={18} />}
            disabled={busy}
            aria-label={t('Leave room')}
            onClick={() => void exit()}
          />
          {headerActions}
        </div>
      </header>
      <div className="tm-activity-row">
        <div className="tm-activity-picker" aria-label={t('Room activity')}>
          {activities.map(({ value, label, Icon }) => (
            <button
              key={value}
              type="button"
              aria-pressed={activity === value}
              disabled={busy || !connected}
              onClick={() => switchActivity(value)}
              title={
                canSwitch
                  ? t('Switch to {value1}', { value1: t(label) })
                  : t('Ask to switch to {value1}', { value1: t(label) })
              }
            >
              <Icon size={17} />
              {t(label)}
            </button>
          ))}
        </div>
        <span>
          {canSwitch
            ? t('You can switch activities')
            : t('Switching asks the host')}
        </span>
        {activity === 'watch' && hasVideo && picker && (
          <Button
            size="sm"
            icon={<Plus size={16} />}
            onClick={() => setPickerOpen(true)}
          >
            {canSelect ? t('Choose content') : t('Suggest content')}
          </Button>
        )}
      </div>
      {error && (
        <div className="tm-room-feedback" role="status">
          {t(error)}
        </div>
      )}
      <div className={`tm-room-body${railOpen ? '' : ' tm-room-body--wide'}`}>
        <section
          className={`tm-activity-stage tm-activity-stage--${activity}`}
          aria-label={t('Current activity')}
        >
          <div className="tm-video-stage" hidden={activity === 'listen'}>
            {mainContent}
            {activity === 'watch' && !hasVideo && (
              <div className="tm-watch-empty">
                <Film size={40} strokeWidth={1.3} />
                <h2>{t('Something good starts here')}</h2>
                <p>
                  {canSelect
                    ? t('Choose a video from a link or one of your sources.')
                    : t('Suggest a video for everyone to watch together.')}
                </p>
                {picker && (
                  <Button
                    variant="primary"
                    icon={<Plus size={17} />}
                    onClick={() => setPickerOpen(true)}
                  >
                    {canSelect ? t('Choose content') : t('Suggest content')}
                  </Button>
                )}
              </div>
            )}
          </div>
          <div className="tm-music-stage" hidden={activity !== 'listen'}>
            {music ?? (
              <div className="tm-stage-empty">
                <Headphones size={40} />
                <h2>{t('Listen together')}</h2>
                <p>
                  {t('Your music controls will be available after joining.')}
                </p>
              </div>
            )}
          </div>
        </section>
        <aside
          className="tm-collaboration-rail"
          hidden={!railOpen}
          aria-label={t('Room collaboration')}
        >
          <div
            className="tm-rail-tabs"
            role="tablist"
            aria-label={t('Room panels')}
          >
            {[
              { value: 'chat', label: t('Chat'), Icon: MessageSquare },
              { value: 'members', label: t('Members'), Icon: Users },
              { value: 'queue', label: t('Queue'), Icon: ListVideo },
            ].map(({ value, label, Icon }) => (
              <button
                type="button"
                key={value}
                role="tab"
                aria-selected={tab === value}
                aria-controls={`rail-${value}`}
                id={`tab-${value}`}
                onClick={() => setTab(value as typeof tab)}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </div>
          <div
            className="tm-rail-panel"
            role="tabpanel"
            id="rail-chat"
            aria-labelledby="tab-chat"
            hidden={tab !== 'chat'}
          >
            {rightPanel}
          </div>
          <div
            className="tm-rail-panel"
            role="tabpanel"
            id="rail-members"
            aria-labelledby="tab-members"
            hidden={tab !== 'members'}
          >
            {members}
            {activity === 'screen' && (
              <details className="tm-connection-details">
                <summary>{t('Connection & peer sharing')}</summary>
                <SharingStatusPanel
                  pc={peerConnection}
                  mode={sharingRole ?? (isHost ? 'sender' : 'receiver')}
                  sharingMode={sharingMode}
                  p2pEnabled={p2pEnabled}
                  p2pPC={p2pPC}
                  p2pStatus={p2pStatus}
                  fallbackNotice={p2pFallbackNotice}
                  onToggleP2P={onToggleP2P ?? (() => {})}
                />
              </details>
            )}
          </div>
          <div
            className="tm-rail-panel"
            role="tabpanel"
            id="rail-queue"
            aria-labelledby="tab-queue"
            hidden={tab !== 'queue'}
          >
            {queue ?? (
              <p className="tm-panel-note">
                {t('The watch queue is available in Watch.')}
              </p>
            )}
          </div>
        </aside>
      </div>
      <ActivityDiscussion roomId={roomId} />
      <Modal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title={canSelect ? t('Choose content') : t('Suggest content')}
        className="tm-source-dialog"
        footer={null}
      >
        {picker}
      </Modal>
      <RoomPolicySettings
        roomId={roomId}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      <Modal
        open={screenWarning !== null}
        onClose={() => setScreenWarning(null)}
        title={t('Stop sharing and switch?')}
        footer={
          <>
            <Button variant="secondary" onClick={() => setScreenWarning(null)}>
              {t('Keep sharing')}
            </Button>
            <Button
              onClick={() => {
                if (screenWarning) performSwitch(screenWarning)
                setScreenWarning(null)
              }}
            >
              {t('Stop and switch')}
            </Button>
          </>
        }
      >
        <p>
          {t(
            'Switching activities stops the current screen share. You will need to start sharing again when you return.'
          )}
        </p>
      </Modal>
    </div>
  )
}
