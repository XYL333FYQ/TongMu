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
    <Modal open={open} onClose={onClose} title="输入房间号" footer={null}>
      <form className="tongmu-home__join-dialog" onSubmit={joinRoom}>
        <label htmlFor="join-room-id">输入朋友分享的房间号</label>
        <input
          id="join-room-id"
          autoFocus
          placeholder="房间号"
          maxLength={64}
          value={roomId}
          onChange={(event) => setRoomId(event.target.value)}
        />
        <button type="submit" disabled={!roomId.trim()}>
          加入房间 <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </button>
      </form>
    </Modal>
  )
}
