import { t, useTranslation } from '@/i18n'
import { useEffect, useState } from 'react'
import { Vote, ArrowRightLeft } from 'lucide-react'
import { useSocket } from '@/hooks/useSocket'
import { useRoomExperienceStore } from '@/store/roomExperienceStore'
import { Button } from '@/components/ui/Button'
import { roomErrorMessage } from '../roomErrors'

const labels = { watch: 'Watch', listen: 'Listen', screen: 'Screen' }
export function ActivityDiscussion({ roomId }: { roomId: string }) {
  useTranslation()

  const snapshot = useRoomExperienceStore((s) => s.snapshot)
  const { socket } = useSocket()
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pollId = snapshot?.poll?.id
  useEffect(() => {
    if (!pollId) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [pollId])
  if (
    !snapshot ||
    (!snapshot.requests.length &&
      !snapshot.poll &&
      !snapshot.suggestions?.length)
  )
    return null
  const action = (event: string, payload: Record<string, unknown>) => {
    if (!socket || busy) return
    setBusy(true)
    setError('')
    socket
      .timeout(8000)
      .emit(
        event,
        { roomId, ...payload },
        (
          timeout: Error | null,
          response: { success: boolean; message?: string }
        ) => {
          setBusy(false)
          if (timeout || !response?.success)
            setError(
              timeout
                ? t('The request timed out. Try again.')
                : roomErrorMessage(response?.message)
            )
        }
      )
  }
  const poll = snapshot.poll
  const ended = !!poll && (poll.ended || now >= poll.expiresAt)
  return (
    <section
      className="tm-room-discussion"
      aria-label={t('Activity requests and poll')}
    >
      {snapshot.suggestions?.map((suggestion) => (
        <div key={suggestion.id} className="tm-discussion-row">
          <Vote size={18} />
          <p>
            <strong>{suggestion.username}</strong> {t('suggests')}{' '}
            <strong>{suggestion.title}</strong> {t('for the watch queue.')}
          </p>
          {snapshot.permissions.selectContent && (
            <div>
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  action('room:content:resolve', {
                    suggestionId: suggestion.id,
                    accepted: true,
                  })
                }
              >
                {t('Add to queue')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  action('room:content:resolve', {
                    suggestionId: suggestion.id,
                    accepted: false,
                  })
                }
              >
                {t('Decline')}
              </Button>
            </div>
          )}
        </div>
      ))}
      {snapshot.requests.map((request) => (
        <div key={request.id} className="tm-discussion-row">
          <ArrowRightLeft size={18} />
          <p>
            <strong>{request.username}</strong> {t('suggests switching to')}{' '}
            <strong>{t(labels[request.activity])}</strong>.
          </p>
          {snapshot.permissions.switchActivity && (
            <div>
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  action('room:activity:resolve', {
                    requestId: request.id,
                    decision: 'accept',
                  })
                }
              >
                {t('Accept')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  action('room:activity:resolve', {
                    requestId: request.id,
                    decision: 'poll',
                  })
                }
              >
                {t('Ask everyone')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  action('room:activity:resolve', {
                    requestId: request.id,
                    decision: 'reject',
                  })
                }
              >
                {t('Decline')}
              </Button>
            </div>
          )}
        </div>
      ))}
      {poll && (
        <div className="tm-discussion-row">
          <Vote size={20} />
          <div>
            <strong>
              {t('Switch to')} {t(labels[poll.activity])}?
            </strong>
            <p>
              {t('Advisory vote ·')}{' '}
              {ended
                ? t('Ended')
                : t('{value1} seconds left', {
                    value1: Math.max(
                      0,
                      Math.ceil((poll.expiresAt - now) / 1000)
                    ),
                  })}{' '}
              · {poll.yes} {t('yes /')} {poll.no} {t('no')}
            </p>
            <p>
              {t(
                'The host makes the final choice. You can change your vote before it ends.'
              )}
            </p>
          </div>
          <div>
            <Button
              size="sm"
              variant={poll.ownVote === true ? 'primary' : 'secondary'}
              disabled={busy || ended}
              onClick={() =>
                action('room:activity:vote', { pollId: poll.id, value: true })
              }
            >
              {t('Yes')}
            </Button>
            <Button
              size="sm"
              variant={poll.ownVote === false ? 'primary' : 'secondary'}
              disabled={busy || ended}
              onClick={() =>
                action('room:activity:vote', { pollId: poll.id, value: false })
              }
            >
              {t('No')}
            </Button>
          </div>
        </div>
      )}
      {error && <p role="alert">{t(error)}</p>}
    </section>
  )
}
