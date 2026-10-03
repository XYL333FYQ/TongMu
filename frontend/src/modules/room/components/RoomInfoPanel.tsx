import { t, useTranslation } from '@/i18n'
import { useState } from 'react'
import { Crown, UserRound, UserX, Volume2, VolumeX } from 'lucide-react'
import { useSocket } from '@/hooks/useSocket'
import { useRoomStore, type Viewer } from '@/store/roomStore'
import { useRoomExperienceStore } from '@/store/roomExperienceStore'
import { Button } from '@/components/ui/Button'
import { ConfirmModal } from '@/components/ui/Modal'
import { roomErrorMessage } from '../roomErrors'

/** Member and admission tools only; room rules live in the toolbar settings. */
export function RoomInfoPanel({
  roomId,
  isHost,
}: {
  roomId: string
  isHost: boolean
}) {
  useTranslation()

  const { socket, connected } = useSocket()
  const viewers = useRoomStore((s) => s.viewers)
  const experience = useRoomExperienceStore((s) => s.snapshot)
  const manage = experience?.permissions.manageMembers ?? isHost
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [transfer, setTransfer] = useState<Viewer | null>(null)
  const perform = (
    event: string,
    payload: Record<string, unknown>,
    success?: () => void
  ) => {
    if (!socket || busy || !connected) return
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
          else success?.()
        }
      )
  }
  return (
    <div className="tm-members-panel">
      {experience?.joinRequests?.length ? (
        <section aria-label={t('Waiting to join')}>
          <h3>{t('Waiting to join')}</h3>
          {experience.joinRequests.map((request) => (
            <div key={request.socketId} className="tm-admission-row">
              <span>{request.username}</span>
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  perform('approve-join', { viewerSocketId: request.socketId })
                }
              >
                {t('Allow')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() =>
                  perform('reject-join', { viewerSocketId: request.socketId })
                }
              >
                {t('Decline')}
              </Button>
            </div>
          ))}
        </section>
      ) : null}
      <h3>{t('In this room')}</h3>
      {experience?.host.online && (
        <div className="tm-member-row">
          <span className="tm-member-avatar">
            <Crown size={18} />
          </span>
          <div>
            <strong>
              {experience.host.socketId === socket?.id ? t('You') : t('Host')}
            </strong>
            <span>
              {experience.isDelegate
                ? t('Temporary activity host')
                : t('Room host')}
            </span>
          </div>
        </div>
      )}
      {viewers
        .filter((v) => v.socketId !== experience?.host.socketId)
        .map((viewer) => (
          <div className="tm-member-row" key={viewer.socketId}>
            <span className="tm-member-avatar">
              <UserRound size={18} />
            </span>
            <div>
              <strong>
                {viewer.username || t('Guest')}
                {viewer.socketId === socket?.id ? t(' (you)') : ''}
              </strong>
              <span>
                {viewer.role === 'guest' ? t('Guest') : t('Member')}
                {viewer.muted ? t(' · Chat muted') : ''}
              </span>
            </div>
            {manage &&
              viewer.socketId !== socket?.id &&
              viewer.role !== 'root' && (
                <div className="tm-member-actions">
                  {viewer.userId && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={
                        viewer.muted
                          ? t('Unmute {value1}', { value1: viewer.username })
                          : t('Mute {value1}', { value1: viewer.username })
                      }
                      disabled={busy}
                      icon={
                        viewer.muted ? (
                          <Volume2 size={15} />
                        ) : (
                          <VolumeX size={15} />
                        )
                      }
                      onClick={() =>
                        perform(
                          viewer.muted ? 'unmute-viewer' : 'mute-viewer',
                          {
                            viewerSocketId: viewer.socketId,
                            userId: viewer.userId,
                          }
                        )
                      }
                    />
                  )}
                  {viewer.role !== 'guest' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t('Transfer ownership to {value1}', {
                        value1: viewer.username,
                      })}
                      disabled={busy}
                      icon={<Crown size={15} />}
                      onClick={() => setTransfer(viewer)}
                    />
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={t('Remove {value1}', {
                      value1: viewer.username,
                    })}
                    disabled={busy}
                    icon={<UserX size={15} />}
                    onClick={() =>
                      perform('kick-viewer', {
                        viewerSocketId: viewer.socketId,
                      })
                    }
                  />
                </div>
              )}
          </div>
        ))}
      {!experience?.host.online && (
        <p className="tm-panel-note">
          {t(
            'The owner is away. An eligible online member can become the acting host after 30 seconds.'
          )}
        </p>
      )}
      <p className="tm-panel-note">
        {t(
          'Only selected content is shared. Your personal library remains private.'
        )}
      </p>
      {error && (
        <p className="room-inline-error" role="alert">
          {t(error)}
        </p>
      )}
      <ConfirmModal
        open={!!transfer}
        onClose={() => setTransfer(null)}
        title={t('Transfer room ownership?')}
        okText={t('Transfer ownership')}
        cancelText={t('Cancel')}
        confirmLoading={busy}
        onOk={() => {
          if (transfer)
            perform(
              'transfer-host',
              { viewerSocketId: transfer.socketId },
              () => setTransfer(null)
            )
        }}
      >
        <p>
          {transfer?.username}{' '}
          {t(
            'will become the room owner. Ownership will not return to you automatically.'
          )}
        </p>
      </ConfirmModal>
    </div>
  )
}
