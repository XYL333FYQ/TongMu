import { t, useTranslation } from '@/i18n'
import { useEffect, useRef, useState } from 'react'
import {
  Routes,
  Route,
  useLocation,
  useNavigate,
  type Location,
} from 'react-router-dom'
import { useRoomStore } from '@/store/roomStore'
import { useRoomExperienceStore } from '@/store/roomExperienceStore'
import { useSocket } from '@/hooks/useSocket'
import { RequireAuth } from '@/components/RequireAuth'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import RoomPage from './RoomPage'
import { leaveCurrentRoom } from './leaveRoom'

const roomIdAt = (location: Location) =>
  /^\/room\/([^/]+)\/?$/.exec(location.pathname)?.[1]

/** Keep one room tree alive while the user browses the rest of TongMu. */
export function RoomRuntime() {
  useTranslation()

  const location = useLocation()
  const navigate = useNavigate()
  const { socket } = useSocket()
  const activeRoomId = useRoomStore((state) => state.activeRoomId)
  const localMuted = useRoomExperienceStore((state) => state.localMuted)
  const [saved, setSaved] = useState<Location | null>(() =>
    roomIdAt(location) ? location : null
  )
  const [pending, setPending] = useState<Location | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [error, setError] = useState('')
  const mediaContainer = useRef<HTMLDivElement>(null)
  // Router changes select a persisted room tree; this also covers browser back/forward.
  /* eslint-disable react-hooks/set-state-in-effect -- Synchronize the external router with the persistent room tree. */
  useEffect(() => {
    const target = roomIdAt(location)
    if (!target || saved?.pathname === location.pathname) return
    if (activeRoomId && target !== activeRoomId) setPending(location)
    else setSaved(location)
  }, [location, activeRoomId, saved?.pathname])
  /* eslint-enable react-hooks/set-state-in-effect */
  useEffect(() => {
    const container = mediaContainer.current
    if (!container || !localMuted) return
    const previous = new Map<HTMLMediaElement, boolean>()
    const mute = () =>
      container
        .querySelectorAll<HTMLMediaElement>('video, audio')
        .forEach((media) => {
          if (!previous.has(media)) previous.set(media, media.muted)
          media.muted = true
        })
    mute()
    const keepMuted = (event: Event) => {
      const media = event.target
      if (media instanceof HTMLMediaElement && !media.muted) media.muted = true
    }
    container.addEventListener('volumechange', keepMuted, true)
    const observer = new MutationObserver(mute)
    observer.observe(container, { subtree: true, childList: true })
    return () => {
      observer.disconnect()
      container.removeEventListener('volumechange', keepMuted, true)
      previous.forEach((muted, media) => {
        media.muted = muted
      })
    }
  }, [localMuted, saved?.pathname])
  const visible = !!saved && location.pathname === saved.pathname
  const shouldKeep = !!saved && (visible || activeRoomId === roomIdAt(saved))
  const cancel = () => {
    setPending(null)
    setError('')
    if (saved) navigate(saved.pathname, { replace: true })
  }
  const switchRoom = async () => {
    setLeaving(true)
    setError('')
    try {
      await leaveCurrentRoom(socket)
      setSaved(pending)
      setPending(null)
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : t('Could not leave your current room.')
      )
    } finally {
      setLeaving(false)
    }
  }
  return (
    <>
      {shouldKeep && (
        <div
          ref={mediaContainer}
          className="tongmu-room-runtime"
          hidden={!visible}
          aria-hidden={!visible}
        >
          <Routes location={saved!}>
            <Route
              path="/room/:roomId"
              element={
                <RequireAuth>
                  <RoomPage />
                </RequireAuth>
              }
            />
          </Routes>
        </div>
      )}
      <Modal
        open={!!pending}
        onClose={cancel}
        title={t('Switch rooms?')}
        footer={
          <>
            <Button onClick={cancel} disabled={leaving}>
              {t('Stay in this room')}
            </Button>
            <Button
              variant="primary"
              loading={leaving}
              onClick={() => void switchRoom()}
            >
              {t('Leave & join')}
            </Button>
          </>
        }
      >
        <p>
          {t(
            'Leave your current room before joining another. This stops your local playback, voice and screen share.'
          )}
        </p>
        {error && (
          <p role="alert" className="room-inline-error">
            {t(error)}
          </p>
        )}
      </Modal>
    </>
  )
}
