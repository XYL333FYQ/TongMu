import { t, useTranslation } from '@/i18n'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { LogIn } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Title, Paragraph } from '@/components/ui/Typography'
import { Input } from '@/components/ui/Input'
import { roomPath } from '@/lib/roomDirectory'

export default function JoinByRoomIdPage() {
  useTranslation()
  const navigate = useNavigate()
  const [roomIdInput, setRoomIdInput] = useState('')

  const handleJoin = () => {
    const path = roomPath(roomIdInput)
    if (path) navigate(path)
  }

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <Card className="relative w-full max-w-md text-center">
        <div>
          <div
            className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
            style={{
              backgroundColor: 'var(--md-sys-color-primary-container)',
              color: 'var(--md-sys-color-on-primary-container)',
            }}
          >
            <LogIn className="h-6 w-6" />
          </div>
          <Title level={3} className="m-0">
            {t('Join a room')}
          </Title>
          <Paragraph type="secondary" className="mt-2">
            {t('Enter the room ID shared by the host.')}
          </Paragraph>

          <div className="mt-6 flex w-full gap-2">
            <Input
              size="lg"
              placeholder={t('Room ID')}
              aria-label={t('Room ID')}
              value={roomIdInput}
              onChange={(e) => setRoomIdInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleJoin()
              }}
              maxLength={64}
              autoFocus
            />
            <Button
              variant="secondary"
              size="lg"
              icon={<LogIn className="h-5 w-5 shrink-0" />}
              onClick={handleJoin}
              disabled={!roomIdInput.trim()}
              className="shrink-0 whitespace-nowrap"
            >
              {t('Join')}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  )
}
