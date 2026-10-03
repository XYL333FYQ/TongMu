import { useRef, useState } from 'react'
import { ImagePlus, RotateCcw } from 'lucide-react'
import { t, useTranslation } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { englishErrorMessage } from '@/lib/errorMessage'
import { Button } from '@/components/ui/Button'
import { RoomCoverImage } from '@/components/RoomCoverImage'
import { useRoomExperienceStore } from '@/store/roomExperienceStore'

async function prepareCover(file: File): Promise<Blob> {
  // Some file pickers report an empty/OS-specific WebP MIME type. Read the
  // supported image signature rather than trusting the filename or registry.
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  const mime = [137, 80, 78, 71, 13, 10, 26, 10].every(
    (byte, index) => header[index] === byte
  )
    ? 'image/png'
    : header[0] === 255 && header[1] === 216 && header[2] === 255
      ? 'image/jpeg'
      : String.fromCharCode(...header.slice(0, 4)) === 'RIFF' &&
          String.fromCharCode(...header.slice(8, 12)) === 'WEBP'
        ? 'image/webp'
        : null
  if (!mime) throw new Error('Use a valid JPG, PNG or WebP image.')
  const image = new Blob([file], { type: mime })
  const url = URL.createObjectURL(image)
  try {
    await new Promise<void>((resolve, reject) => {
      const preview = new Image()
      preview.onload = () => resolve()
      preview.onerror = () =>
        reject(new Error('Use a valid JPG, PNG or WebP image.'))
      preview.src = url
    })
  } finally {
    URL.revokeObjectURL(url)
  }
  return image
}

export function RoomCoverEditor({
  roomId,
  onBusyChange,
}: {
  roomId: string
  onBusyChange: (busy: boolean) => void
}) {
  useTranslation()
  const snapshot = useRoomExperienceStore((state) => state.snapshot)
  const fileInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const update = async (file?: File) => {
    if (busy || !snapshot?.permissions.settings) return
    setError('')
    setSaved(false)
    if (file && file.size > 5 * 1024 * 1024) {
      setError('Choose an image smaller than 5 MB.')
      return
    }
    setBusy(true)
    onBusyChange(true)
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), 45_000)
    try {
      const body = file ? new FormData() : undefined
      if (file) body!.append('cover', await prepareCover(file), file.name)
      const response = await apiFetch(
        `/api/rooms/${encodeURIComponent(roomId)}/cover`,
        {
          method: file ? 'POST' : 'DELETE',
          body,
          signal: controller.signal,
        }
      )
      const data = (await response.json()) as {
        success: boolean
        coverUrl?: string | null
        message?: string
      }
      if (!response.ok || !data.success)
        throw new Error(
          data.message || 'Could not update the room cover. Try again.'
        )
      // Do not restore a room that was left while the upload was in flight.
      const current = useRoomExperienceStore.getState().snapshot
      if (current?.roomId === roomId)
        useRoomExperienceStore
          .getState()
          .setSnapshot({ ...current, coverUrl: data.coverUrl ?? null })
      setSaved(true)
    } catch (reason) {
      setError(
        controller.signal.aborted
          ? 'The cover request timed out. Check the preview, then try again.'
          : reason instanceof Error
            ? reason.message
            : 'Could not update the room cover. Try again.'
      )
    } finally {
      clearTimeout(deadline)
      setBusy(false)
      onBusyChange(false)
    }
  }

  return (
    <section className="tm-cover-editor" aria-label={t('Room cover')}>
      <div className="tm-cover-editor-preview">
        <RoomCoverImage roomId={roomId} coverUrl={snapshot?.coverUrl} />
      </div>
      <div className="tm-cover-editor-controls">
        <h3>{t('Room cover')}</h3>
        <p>
          {t(
            'Choose an image for your room card. JPG, PNG or WebP, up to 5 MB.'
          )}
        </p>
        <div className="tm-cover-editor-actions">
          <Button
            variant="secondary"
            size="sm"
            loading={busy}
            icon={<ImagePlus size={16} />}
            disabled={busy || !snapshot?.permissions.settings}
            onClick={() => fileInput.current?.click()}
          >
            {busy ? t('Saving…') : t('Upload cover')}
          </Button>
          {snapshot?.coverUrl && (
            <Button
              variant="ghost"
              size="sm"
              icon={<RotateCcw size={16} />}
              disabled={busy}
              onClick={() => void update()}
            >
              {t('Use default cover')}
            </Button>
          )}
        </div>
        <p className="tm-cover-editor-hint">
          {t('Cover changes are saved immediately.')}
        </p>
        {saved && <p role="status">{t('Room cover saved.')}</p>}
        {error && (
          <p className="room-inline-error" role="alert">
            {englishErrorMessage(
              error,
              'Could not update the room cover. Try again.'
            )}
          </p>
        )}
        <input
          ref={fileInput}
          className="sr-only"
          type="file"
          tabIndex={-1}
          aria-label={t('Choose a room cover image')}
          accept="image/jpeg,image/png,image/webp"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void update(file)
          }}
        />
      </div>
    </section>
  )
}
