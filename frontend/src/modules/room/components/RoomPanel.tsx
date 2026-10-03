import { t, useTranslation } from '@/i18n'
import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Film,
  Lock,
  Users,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { InputPassword } from '@/components/ui/InputPassword'
import { Switch } from '@/components/ui/Switch'
import { Modal } from '@/components/ui/Modal'
import { useRoomStore, type RoomMode } from '@/store/roomStore'
import { useAuthStore } from '@/store/authStore'
import { useSystemSettingsStore } from '@/store/systemSettingsStore'
import { useSocket } from '@/hooks/useSocket'
import { storeRoomMediaGrant } from '@/modules/media/roomMediaGrant'
import { defaultRoomPolicy, type RoomPolicy } from '../roomExperience'
import { roomErrorMessage } from '../roomErrors'
import { dispatchRoomMediaTeardown } from '@/lib/mediaTeardown'

interface RoomPanelProps {
  onModeSelected?: (mode: RoomMode) => void
}

function RuleChoice<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: T
  onChange: (value: T) => void
  options: { value: T; label: string; description: string }[]
}) {
  useTranslation()

  return (
    <fieldset className="room-rule-group">
      <legend>{label}</legend>
      <div className="room-rule-options">
        {options.map((option) => (
          <button
            type="button"
            key={option.value}
            className="room-rule-option"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
          >
            <span>{option.label}</span>
            <small>{option.description}</small>
          </button>
        ))}
      </div>
    </fieldset>
  )
}

export function RoomPanel({ onModeSelected }: RoomPanelProps) {
  useTranslation()

  const navigate = useNavigate()
  const { socket, connected } = useSocket()
  const user = useAuthStore((state) => state.user)
  const creationMode = useSystemSettingsStore((state) => state.roomCreationMode)
  const canCreate =
    user &&
    user.role !== 'guest' &&
    (creationMode === 'all-users' ||
      user.role === 'admin' ||
      user.role === 'root')
  const [name, setName] = useState('')
  const [policy, setPolicy] = useState<RoomPolicy>({
    ...defaultRoomPolicy,
    permissions: {},
  })
  const [password, setPassword] = useState('')
  const [approval, setApproval] = useState(false)
  const [maxViewers, setMaxViewers] = useState('10')
  const [advanced, setAdvanced] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const patchPolicy = (patch: Partial<RoomPolicy>) =>
    setPolicy((current) => ({ ...current, ...patch }))

  const createRoom = () => {
    if (!socket || !connected) {
      setError(t('Connection unavailable. Wait a moment, then try again.'))
      return
    }
    setConfirmOpen(false)
    setCreating(true)
    setError('')
    socket.timeout(12000).emit(
      'create-room',
      {
        name: name.trim(),
        mode: 'watch-together',
        policy,
        password: password || undefined,
        requireApproval: approval,
        maxViewers: Number(maxViewers),
      },
      (
        timeout: Error | null,
        response: {
          success: boolean
          message?: string
          data?: { roomId: string; mode?: RoomMode; mediaGrant?: string }
        }
      ) => {
        setCreating(false)
        if (timeout) {
          setError(
            t(
              'The server did not respond. Your settings are still here; try again.'
            )
          )
          return
        }
        if (!response?.success || !response.data?.roomId) {
          setError(roomErrorMessage(response?.message))
          return
        }
        const roomId = response.data.roomId
        dispatchRoomMediaTeardown(true)
        useRoomStore.getState().reset()
        useRoomStore.getState().setRoomId(roomId)
        useRoomStore.getState().setMode('watch-together')
        useRoomStore.getState().setRoomSettings({
          requireApproval: approval,
          maxViewers: Number(maxViewers),
          password: password ? 'configured' : null,
        })
        storeRoomMediaGrant(roomId, response.data.mediaGrant)
        try {
          sessionStorage.setItem('zcontrol-host-room', roomId)
        } catch {
          /* Server ownership still restores on return. */
        }
        navigate(`/room/${roomId}`, { replace: true })
        onModeSelected?.('watch-together')
      }
    )
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) {
      setError(t('Give your room a name.'))
      return
    }
    if (useRoomStore.getState().activeRoomId) setConfirmOpen(true)
    else createRoom()
  }

  return (
    <div className="tongmu-create-wrap">
      <section className="tongmu-create">
        <Button
          variant="secondary"
          size="sm"
          className="xl:hidden"
          icon={<ArrowLeft size={16} />}
          onClick={() => navigate('/')}
        >
          {t('Hall')}
        </Button>
        <div className="room-create-heading">
          <div className="room-create-symbol">
            <Film size={24} />
          </div>
          <div>
            <h1>{t('Create a room')}</h1>
            <p>
              {t(
                'Start with a video. Switch to music or screen sharing when you are inside.'
              )}
            </p>
          </div>
        </div>
        {!canCreate ? (
          <div className="room-create-access">
            <Lock size={22} />
            <h2>
              {user?.role === 'guest'
                ? t('Sign in to create a room')
                : t('Room creation is limited')}
            </h2>
            <p>
              {user?.role === 'guest'
                ? t('You can still join rooms as a guest.')
                : t(
                    'Your platform administrator controls who can create rooms.'
                  )}
            </p>
            {user?.role === 'guest' && (
              <Button variant="primary" onClick={() => navigate('/login')}>
                {t('Sign in')}
              </Button>
            )}
          </div>
        ) : (
          <form onSubmit={submit} className="room-create-form">
            <Input
              label={t('Room name')}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('Friday movie night')}
              maxLength={120}
              required
              autoComplete="off"
            />
            <RuleChoice
              label={t('How long should it stay?')}
              value={policy.lifetime}
              onChange={(lifetime) => patchPolicy({ lifetime })}
              options={[
                {
                  value: 'temporary',
                  label: t('Temporary'),
                  description: t('Clears after 24 hours with no one inside.'),
                },
                {
                  value: 'persistent',
                  label: t('Fixed'),
                  description: t('Keep the room, settings and saved queues.'),
                },
              ]}
            />
            <RuleChoice
              label={t('Who can find it?')}
              value={policy.visibility}
              onChange={(visibility) => patchPolicy({ visibility })}
              options={[
                {
                  value: 'public',
                  label: t('Public'),
                  description: t('Listed in the hall.'),
                },
                {
                  value: 'private',
                  label: t('Private'),
                  description: t('Only a link or exact room ID.'),
                },
              ]}
            />
            <RuleChoice
              label={t('Who controls the activity?')}
              value={policy.collaboration}
              onChange={(collaboration) => patchPolicy({ collaboration })}
              options={[
                {
                  value: 'host',
                  label: t('Host controls'),
                  description: t('Members can chat, suggest and request.'),
                },
                {
                  value: 'shared',
                  label: t('Together'),
                  description: t(
                    'Signed-in members choose content and control playback.'
                  ),
                },
              ]}
            />
            <div className="room-create-toggle">
              <Users size={18} />
              <Switch
                label={t('Allow guests')}
                checked={policy.allowGuests}
                onChange={(event) =>
                  patchPolicy({
                    allowGuests: event.target.checked,
                    guestCollaboration: false,
                  })
                }
              />
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-expanded={advanced}
              icon={<ChevronDown size={16} />}
              onClick={() => setAdvanced((value) => !value)}
            >
              {t('Joining rules & permissions')}
            </Button>
            {advanced && (
              <div className="room-create-advanced">
                <InputPassword
                  label={t('Password (optional)')}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  maxLength={128}
                  autoComplete="new-password"
                />
                <Switch
                  label={t('Ask the host to approve new members')}
                  checked={approval}
                  onChange={(event) => setApproval(event.target.checked)}
                />
                <Input
                  label={t('Member limit')}
                  type="number"
                  min={1}
                  max={100}
                  step={1}
                  value={maxViewers}
                  onChange={(event) => setMaxViewers(event.target.value)}
                  required
                />
                {policy.allowGuests && (
                  <Switch
                    label={t('Let guests collaborate')}
                    checked={policy.guestCollaboration}
                    onChange={(event) =>
                      patchPolicy({ guestCollaboration: event.target.checked })
                    }
                  />
                )}
                {(
                  [
                    'selectContent',
                    'playback',
                    'switchActivity',
                    'screenShare',
                  ] as const
                ).map((key, index) => (
                  <Switch
                    key={key}
                    label={
                      [
                        t('Members choose content'),
                        t('Members control playback'),
                        t('Members switch activities'),
                        t('Members start screen sharing'),
                      ][index]
                    }
                    checked={
                      policy.permissions[key] ??
                      (index < 2 && policy.collaboration === 'shared')
                    }
                    onChange={(event) =>
                      patchPolicy({
                        permissions: {
                          ...policy.permissions,
                          [key]: event.target.checked,
                        },
                      })
                    }
                  />
                ))}
              </div>
            )}
            {error && (
              <p className="room-inline-error" role="alert">
                {t(error)}
              </p>
            )}
            <Button
              variant="primary"
              type="submit"
              size="lg"
              block
              loading={creating}
              disabled={!connected}
              icon={<ArrowRight size={18} />}
            >
              {t('Create room')}
            </Button>
          </form>
        )}
      </section>
      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={t('Leave your current room?')}
        footer={
          <>
            <Button onClick={() => setConfirmOpen(false)}>
              {t('Stay here')}
            </Button>
            <Button variant="primary" onClick={createRoom}>
              {t('Leave & create')}
            </Button>
          </>
        }
      >
        <p>
          {t(
            'Creating a room ends your membership in the current room and stops your local media and voice connection.'
          )}
        </p>
      </Modal>
    </div>
  )
}
