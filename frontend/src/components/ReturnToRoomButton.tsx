import { t, useTranslation } from '@/i18n'
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  ArrowUpRight,
  LogOut,
  MonitorOff,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { useRoomStore } from '@/store/roomStore'
import { useRoomExperienceStore } from '@/store/roomExperienceStore'
import { useSocket } from '@/hooks/useSocket'
import { Button } from '@/components/ui/Button'
import { leaveCurrentRoom } from '@/modules/room/leaveRoom'
import { roomErrorMessage } from '@/modules/room/roomErrors'

export function ReturnToRoomButton() {
  useTranslation()

  const location = useLocation()
  const navigate = useNavigate()
  const { socket, connected } = useSocket()
  const activeRoomId = useRoomStore((state) => state.activeRoomId)
  const roomName = useRoomStore((state) => state.roomName)
  const sharing = useRoomStore((state) => state.isSharing)
  const localMuted = useRoomExperienceStore((state) => state.localMuted)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!activeRoomId || location.pathname === `/room/${activeRoomId}`)
    return null

  const exit = async () => {
    setBusy(true)
    setError('')
    try {
      await leaveCurrentRoom(socket)
    } catch (error) {
      setError(
        error instanceof Error ? error.message : 'Could not leave the room.'
      )
    } finally {
      setBusy(false)
    }
  }
  const stopSharing = () => {
    if (!socket?.connected) {
      setError('Reconnect before stopping the shared screen.')
      return
    }
    setBusy(true)
    setError('')
    socket
      .timeout(8000)
      .emit(
        'room:screen:stop',
        { roomId: activeRoomId },
        (
          timeout: Error | null,
          response?: { success: boolean; message?: string }
        ) => {
          setBusy(false)
          if (timeout || !response?.success)
            setError(
              timeout
                ? 'Stopping was not confirmed. Try again.'
                : roomErrorMessage(response?.message)
            )
        }
      )
  }
  return (
    <aside className="room-session-bar" aria-label={t('Active room')}>
      <span className="room-session-bar__status">
        <i aria-hidden="true" />
        <span>
          <strong>{roomName || activeRoomId}</strong>
          <small>{connected ? t('Still connected') : t('Reconnecting…')}</small>
        </span>
      </span>
      <div className="room-session-bar__actions">
        <Button
          variant="primary"
          size="sm"
          icon={<ArrowUpRight size={16} />}
          onClick={() => navigate(`/room/${activeRoomId}`)}
        >
          {t('Return to room')}
        </Button>
        <Button
          size="sm"
          aria-pressed={localMuted}
          icon={localMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          onClick={() =>
            useRoomExperienceStore.getState().setLocalMuted(!localMuted)
          }
        >
          {localMuted ? t('Unmute sound') : t('Mute sound')}
        </Button>
        {sharing && (
          <Button
            size="sm"
            icon={<MonitorOff size={16} />}
            onClick={stopSharing}
            disabled={busy || !connected}
          >
            {t('Stop sharing')}
          </Button>
        )}
        <Button
          size="sm"
          icon={<LogOut size={16} />}
          onClick={() => void exit()}
          loading={busy}
        >
          {t('Exit room')}
        </Button>
      </div>
      {error && (
        <p role="alert" className="room-inline-error">
          {t(error)}
        </p>
      )}
    </aside>
  )
}
