import { t, useTranslation } from '@/i18n'
import { useEffect, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useSocket } from '@/hooks/useSocket'
import { useRoomExperienceStore } from '@/store/roomExperienceStore'
import { defaultRoomPolicy, type RoomPolicy } from '../roomExperience'
import { roomErrorMessage } from '../roomErrors'

export function RoomPolicySettings({
  roomId,
  open,
  onClose,
}: {
  roomId: string
  open: boolean
  onClose: () => void
}) {
  useTranslation()

  const snapshot = useRoomExperienceStore((s) => s.snapshot)
  const { socket } = useSocket()
  const [policy, setPolicy] = useState<RoomPolicy>(defaultRoomPolicy)
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [changePassword, setChangePassword] = useState(false)
  const [approval, setApproval] = useState(false)
  const [limit, setLimit] = useState(10)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Opening creates a draft; incoming snapshots must not overwrite edits.
  /* eslint-disable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect -- Create a new draft on open without overwriting edits on incoming room snapshots. */
  useEffect(() => {
    if (open && snapshot) {
      setName(snapshot.name ?? '')
      setPolicy(snapshot.policy)
      setApproval(snapshot.requireApproval)
      setLimit(snapshot.maxViewers)
      setChangePassword(false)
      setPassword('')
      setError('')
    }
  }, [open])
  /* eslint-enable react-hooks/exhaustive-deps, react-hooks/set-state-in-effect */
  const save = () => {
    if (!socket || busy || !snapshot?.permissions.settings) return
    if (!name.trim()) {
      setError(t('Enter a room name.'))
      return
    }
    setBusy(true)
    setError('')
    socket.timeout(8000).emit(
      'update-room-settings',
      {
        roomId,
        name: name.trim(),
        policy,
        requireApproval: approval,
        maxViewers: limit,
        ...(changePassword ? { password } : {}),
      },
      (
        timeout: Error | null,
        response: { success: boolean; message?: string }
      ) => {
        setBusy(false)
        if (timeout || !response?.success)
          setError(
            timeout
              ? t('Saving timed out. Your entries are kept.')
              : roomErrorMessage(response?.message)
          )
        else onClose()
      }
    )
  }
  const option = (
    key: 'visibility' | 'lifetime' | 'collaboration',
    values: [string, string][]
  ) => (
    <div className="tm-settings-options">
      {values.map(([value, label]) => (
        <button
          type="button"
          key={value}
          aria-pressed={policy[key] === value}
          onClick={() => setPolicy({ ...policy, [key]: value })}
        >
          {t(label)}
        </button>
      ))}
    </div>
  )
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('Room settings')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('Cancel')}
          </Button>
          <Button
            disabled={busy || !snapshot?.permissions.settings}
            onClick={save}
          >
            {busy ? t('Saving…') : t('Save settings')}
          </Button>
        </>
      }
    >
      <label htmlFor="edit-room-name" className="mb-2">
        {t('Room name')}
      </label>
      <Input
        id="edit-room-name"
        className="mb-4"
        maxLength={120}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="tm-room-settings">
        <fieldset>
          <legend>{t('Discovery')}</legend>
          {option('visibility', [
            ['public', 'Public'],
            ['private', 'Private'],
          ])}
          <p>{t('Private rooms require a link or exact room ID.')}</p>
        </fieldset>
        <fieldset>
          <legend>{t('Retention')}</legend>
          {option('lifetime', [
            ['temporary', 'Temporary'],
            ['persistent', 'Fixed'],
          ])}
          <p>
            {policy.lifetime === 'temporary'
              ? t('Removed after 24 hours with nobody inside.')
              : t('Room ID, rules, lists, and progress are kept when empty.')}
          </p>
        </fieldset>
        <fieldset>
          <legend>{t('Collaboration')}</legend>
          {option('collaboration', [
            ['host', 'Host controls'],
            ['shared', 'Participate together'],
          ])}
        </fieldset>
        <label className="tm-check">
          <input
            type="checkbox"
            checked={policy.allowGuests}
            onChange={(e) =>
              setPolicy({ ...policy, allowGuests: e.target.checked })
            }
          />
          {t('Allow guests to join')}
        </label>
        <label className="tm-check">
          <input
            type="checkbox"
            checked={approval}
            onChange={(e) => setApproval(e.target.checked)}
          />
          {t('Require host approval')}
        </label>
        <label htmlFor="room-member-limit">{t('Viewer limit')}</label>
        <Input
          id="room-member-limit"
          type="number"
          min={1}
          max={100}
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
        />
        <label className="tm-check">
          <input
            type="checkbox"
            checked={changePassword}
            onChange={(e) => setChangePassword(e.target.checked)}
          />
          {snapshot?.hasPassword
            ? t('Replace or remove the password')
            : t('Set a password')}
        </label>
        {changePassword && (
          <Input
            type="password"
            aria-label={t('New room password')}
            maxLength={128}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('Leave empty to remove the password')}
          />
        )}
        <details>
          <summary>{t('Fine permissions')}</summary>
          <label className="tm-check">
            <input
              type="checkbox"
              checked={policy.guestCollaboration}
              onChange={(e) =>
                setPolicy({ ...policy, guestCollaboration: e.target.checked })
              }
            />
            {t('Allow guests to collaborate')}
          </label>
          {Object.entries({
            selectContent: 'Choose content and edit queues',
            playback: 'Control playback',
            switchActivity: 'Switch activities',
            screenShare: 'Start screen sharing',
          }).map(([key, label]) => (
            <label className="tm-check" key={key}>
              <input
                type="checkbox"
                checked={
                  policy.permissions[key as keyof RoomPolicy['permissions']] ??
                  (policy.collaboration === 'shared' &&
                    (key === 'selectContent' || key === 'playback'))
                }
                onChange={(e) =>
                  setPolicy({
                    ...policy,
                    permissions: {
                      ...policy.permissions,
                      [key]: e.target.checked,
                    },
                  })
                }
              />
              {t(label)}
            </label>
          ))}
        </details>
        {error && (
          <p role="alert" className="room-inline-error">
            {t(error)}
          </p>
        )}
      </div>
    </Modal>
  )
}
