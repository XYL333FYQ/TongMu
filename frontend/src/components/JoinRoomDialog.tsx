import { t, useTranslation } from '@/i18n'
import { useState, type FormEvent } from 'react'
import { ArrowRight } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { roomPath } from '@/lib/roomDirectory'

export function JoinRoomDialog({
  open,
  onClose,
  onJoin,
}: {
  open: boolean
  onClose: () => void
  onJoin: (path: string) => void
}) {
  useTranslation()

  const [roomId, setRoomId] = useState('')

  const joinRoom = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const path = roomPath(roomId)
    if (!path) return
    setRoomId('')
    onClose()
    onJoin(path)
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('Join by room ID')}
      footer={null}
    >
      <form className="tongmu-home__join-dialog" onSubmit={joinRoom}>
        <label htmlFor="join-room-id">
          {t('Enter the room ID shared by your friend')}
        </label>
        <input
          id="join-room-id"
          autoFocus
          placeholder={t('Room ID')}
          maxLength={64}
          value={roomId}
          onChange={(event) => setRoomId(event.target.value)}
        />
        <button type="submit" disabled={!roomId.trim()}>
          {t('Join room')}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </form>
    </Modal>
  )
}
