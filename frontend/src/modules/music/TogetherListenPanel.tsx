import { t, useTranslation } from '@/i18n'
import { useEffect, useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronUp,
  ListMusic,
  Music2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  SkipBack,
  SkipForward,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { cn } from '@/lib/utils'
import { apiGet, apiPost } from '@/lib/api'
import { useRoomExperienceStore } from '@/store/roomExperienceStore'
import { formatMusicTime, modeLabel } from './domain'
import { formatQualityFacts } from './catalog-domain'
import { NcmCatalogPanel } from './NcmCatalogPanel'
import { useMusicSync } from './useMusicSync'
import type { MusicPlayMode } from './types'

interface TogetherListenPanelProps {
  roomId: string
  isHost: boolean
}

interface NcmStatusResponse {
  success?: boolean
  loggedIn?: boolean
  displayName?: string | null
  status?: 'none' | 'logged-in' | 'invalid'
}

interface NcmQrResponse {
  success?: boolean
  loggedIn?: boolean
  displayName?: string | null
  status?:
    | 'idle'
    | 'qr-created'
    | 'waiting'
    | 'scanned'
    | 'authorized'
    | 'expired'
    | 'failed'
    | 'logged-in'
  sessionId?: string
  qrImageDataUrl?: string
  expiresAt?: number
}

const modeOptions: Array<{ value: MusicPlayMode; label: string }> = [
  { value: 'sequential', label: 'In order' },
  { value: 'repeat-one', label: 'Repeat one' },
  { value: 'repeat-all', label: 'Repeat all' },
  { value: 'shuffle', label: 'Shuffle' },
]

function clampProgress(value: number, duration: number): number {
  return Math.min(Math.max(0, value), Math.max(1, duration))
}

/** Together Listen controls with the narrow NCM login surface. */
export function TogetherListenPanel({
  roomId,
  isHost,
}: TogetherListenPanelProps) {
  useTranslation()

  const audioRef = useRef<HTMLAudioElement>(null)
  const [sourceRef, setSourceRef] = useState('music://fixture/blue-hour')
  const [title, setTitle] = useState('Blue Hour')
  const [artist, setArtist] = useState('Test audio')
  const [ncmStatus, setNcmStatus] = useState<NcmStatusResponse | null>(null)
  const [ncmQr, setNcmQr] = useState<NcmQrResponse | null>(null)
  const [ncmBusy, setNcmBusy] = useState(false)
  const sync = useMusicSync({ roomId, isHost, audioRef })
  const permissions = useRoomExperienceStore((s) => s.snapshot?.permissions)
  const canSelect = permissions?.selectContent ?? isHost
  const canControl = permissions?.playback ?? isHost
  const { state } = sync
  const duration = state.currentItem ? state.currentItem.durationMs / 1000 : 0

  useEffect(() => {
    let cancelled = false
    void apiGet<NcmStatusResponse>('/api/music/ncm/status').then((result) => {
      if (!cancelled && result.ok && result.data) setNcmStatus(result.data)
    })
    return () => {
      cancelled = true
    }
  }, [roomId])

  useEffect(() => {
    const sessionId = ncmQr?.sessionId
    if (!sessionId || ['logged-in', 'expired', 'failed'].includes(ncmQr?.status ?? '')) return
    let cancelled = false
    let polling = false
    const poll = async () => {
      if (polling || cancelled) return
      if (ncmQr?.expiresAt && ncmQr.expiresAt <= Date.now()) {
        setNcmQr(previous => previous ? { ...previous, status: 'expired', qrImageDataUrl: undefined } : previous)
        return
      }
      polling = true
      const result = await apiGet<NcmQrResponse>(
        `/api/music/ncm/login/qr/${encodeURIComponent(sessionId)}`
      )
      polling = false
      if (cancelled) return
      if (!result.ok || !result.data) {
        setNcmQr(previous => previous ? { ...previous, status: 'failed', qrImageDataUrl: undefined } : previous)
        return
      }
      setNcmQr(result.data)
      if (result.data.status === 'logged-in') {
        const current = await apiGet<NcmStatusResponse>('/api/music/ncm/status')
        if (current.ok && current.data) setNcmStatus(current.data)
      }
    }
    const timer = window.setInterval(() => {
      void poll()
    }, 1500)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [ncmQr?.sessionId, ncmQr?.status, ncmQr?.expiresAt])

  const startNcmLogin = async () => {
    setNcmBusy(true)
    try {
      const result = await apiGet<NcmQrResponse>('/api/music/ncm/login/qr')
      if (result.ok && result.data) setNcmQr(result.data)
    } finally {
      setNcmBusy(false)
    }
  }

  const logoutNcm = async () => {
    setNcmBusy(true)
    try {
      const result = await apiPost<NcmStatusResponse>('/api/music/ncm/logout')
      if (result.ok) {
        setNcmQr(null)
        setNcmStatus({ success: true, loggedIn: false, status: 'none' })
      }
    } finally {
      setNcmBusy(false)
    }
  }

  const handleAdd = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const source = sourceRef.trim()
    const name = title.trim()
    if (!source || !name) return
    sync.addFixture({
      sourceRef: source,
      title: name,
      artist: artist.trim(),
      durationMs: 4_000,
    })
  }

  const moveQueueItem = (index: number, direction: -1 | 1) => {
    if (!canSelect) return
    const nextIndex = index + direction
    if (nextIndex < 0 || nextIndex >= state.queue.length) return
    const ids = state.queue.map((item) => item.queueItemId)
    ;[ids[index], ids[nextIndex]] = [ids[nextIndex], ids[index]]
    sync.reorder(ids)
  }

  return (
    <Card
      className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden p-3 md:p-4"
      disableAnimation
    >
      <audio
        ref={audioRef}
        preload="metadata"
        className="hidden"
        aria-hidden="true"
      />
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]"
            aria-hidden="true"
          >
            <Music2 className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold text-[var(--md-sys-color-on-surface)]">
              {t('Music')}
            </h3>
            <p className="truncate text-[11px] text-[var(--md-sys-color-on-surface-variant)]">
              {state.status === 'reconnecting'
                ? t('Reconnecting…')
                : state.hostOffline
                  ? t('Host is offline')
                  : t('Listen together')}
            </p>
          </div>
        </div>
        <span
          className={cn(
            'shrink-0 rounded-full px-2 py-1 text-[11px]',
            state.connected && state.status !== 'error'
              ? 'bg-[var(--md-sys-color-secondary-container)] text-[var(--md-sys-color-on-secondary-container)]'
              : 'bg-[var(--md-sys-color-error-container)] text-[var(--md-sys-color-on-error-container)]'
          )}
        >
          {state.status === 'loading'
            ? t('Loading…')
            : state.connected
              ? t('Connected')
              : t('Disconnected')}
        </span>
      </div>

      <div
        data-testid="ncm-status"
        className="mt-2 flex min-w-0 items-center justify-between gap-2 rounded-lg bg-[var(--md-sys-color-surface-container-low)] px-2 py-1.5 text-[11px] text-[var(--md-sys-color-on-surface-variant)]"
      >
        <span className="truncate">
          {t('NetEase Music: ')}
          {!ncmStatus
            ? t('Checking…')
            : ncmStatus.loggedIn
              ? t('Connected{value1}', {
                  value1: ncmStatus.displayName
                    ? ` · ${ncmStatus.displayName}`
                    : '',
                })
              : t('Not connected')}
        </span>
        {canSelect && ncmStatus && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disableAnimation
            disabled={ncmBusy}
            onClick={() =>
              void (ncmStatus?.loggedIn ? logoutNcm() : startNcmLogin())
            }
          >
            {ncmStatus?.loggedIn ? t('Disconnect') : ncmQr ? t('Refresh QR code') : t('Connect with QR')}
          </Button>
        )}
      </div>
      {ncmQr?.status === 'expired' && (
        <p role="status" className="mt-2 text-sm text-[var(--md-sys-color-on-surface-variant)]">
          {t('This code expired. Generate a new one.')}
        </p>
      )}
      {ncmQr?.status === 'failed' && (
        <p role="alert" className="mt-2 text-sm text-[var(--md-sys-color-error)]">
          {t('Connection failed')} · {t('Refresh QR code')}
        </p>
      )}
      {canSelect && ncmQr?.qrImageDataUrl && !['logged-in', 'expired', 'failed'].includes(ncmQr.status ?? '') && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-[var(--md-sys-color-outline-variant)] p-2">
          <img
            src={ncmQr.qrImageDataUrl}
            alt={t('NetEase Music sign-in code')}
            className="h-20 w-20 rounded bg-white p-1"
          />
          <span role="status" className="text-[11px] text-[var(--md-sys-color-on-surface-variant)]">
            {ncmQr.status === 'scanned'
              ? t('Scanned. Confirm in the app.')
              : t('Scan with the NetEase Music app.')}
          </span>
        </div>
      )}

      <NcmCatalogPanel
        isHost={canSelect}
        loggedIn={Boolean(ncmStatus?.loggedIn)}
        onAddTrack={sync.addMusic}
      />

      <div className="mt-3 min-w-0 rounded-xl bg-[var(--md-sys-color-surface-container)] p-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-[var(--md-sys-color-on-surface)]">
            {state.currentItem?.title || t('Your next song starts here')}
          </p>
          <p className="truncate text-xs text-[var(--md-sys-color-on-surface-variant)]">
            {state.currentItem?.artist ||
              t('Choose a song from NetEase Music to listen together.')}
          </p>
          {sync.qualityFacts &&
            state.currentSourceRef?.startsWith('music://ncm/') && (
              <p className="mt-1 break-words text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
                {formatQualityFacts(
                  sync.qualityFacts.requestedQuality,
                  sync.qualityFacts.actualQuality,
                  sync.qualityFacts.availableQualities
                )}
              </p>
            )}
        </div>
        <input
          aria-label={t('Music position')}
          type="range"
          min={0}
          max={Math.max(1, duration)}
          step={0.1}
          value={clampProgress(state.positionSec, duration)}
          onChange={(event) => sync.seek(Number(event.target.value))}
          className="mt-2 h-1.5 w-full cursor-pointer accent-[var(--md-sys-color-primary)]"
          disabled={!state.currentItem || !state.connected}
        />
        <div className="mt-1 flex justify-between text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
          <span>{formatMusicTime(state.positionSec)}</span>
          <span>{formatMusicTime(duration)}</span>
        </div>
        <div className="mt-2 flex items-center justify-center gap-1.5">
          <Button
            aria-label={t('Previous track')}
            title={t('Previous track')}
            size="sm"
            variant="ghost"
            disableAnimation
            icon={<SkipBack className="h-4 w-4" />}
            onClick={() => sync.previous()}
          />
          <Button
            aria-label={state.isPlaying ? t('Pause') : t('Play')}
            title={state.isPlaying ? t('Pause') : t('Play')}
            size="sm"
            variant="primary"
            disableAnimation
            icon={
              state.isPlaying ? (
                <Pause className="h-4 w-4" />
              ) : (
                <Play className="h-4 w-4" />
              )
            }
            onClick={() => sync.play()}
            disabled={!state.currentItem || !state.connected}
          />
          <Button
            aria-label={t('Next track')}
            title={t('Next track')}
            size="sm"
            variant="ghost"
            disableAnimation
            icon={<SkipForward className="h-4 w-4" />}
            onClick={() => sync.next()}
          />
          <select
            aria-label={t('Playback mode')}
            value={state.playMode}
            onChange={(event) =>
              sync.setMode(event.target.value as MusicPlayMode)
            }
            disabled={!canControl || !state.connected}
            className="ml-1 max-w-[7rem] rounded-lg border border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-high)] px-2 py-1.5 text-xs text-[var(--md-sys-color-on-surface)]"
          >
            {modeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {t(option.label)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {isHost && state.pendingHostRequests.length > 0 && (
        <div className="mt-2 rounded-lg border border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-secondary-container)] p-2 text-xs text-[var(--md-sys-color-on-secondary-container)]">
          <div className="mb-1 font-medium">{t('Playback requests')}</div>
          {state.pendingHostRequests.map((request) => (
            <div
              key={request.requestId}
              className="flex items-center justify-between gap-2 py-1"
            >
              <span className="truncate">
                {request.action === 'seek'
                  ? t('Seek')
                  : request.action === 'select'
                    ? t('Choose track')
                    : request.action === 'previous'
                      ? t('Previous track')
                      : request.action === 'next'
                        ? t('Next track')
                        : request.action === 'play'
                          ? t('Play')
                          : t('Pause')}
              </span>
              <span className="flex shrink-0 gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="primary"
                  disableAnimation
                  onClick={() => sync.respondControl(request.requestId, true)}
                >
                  {t('Accept')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disableAnimation
                  onClick={() => sync.respondControl(request.requestId, false)}
                >
                  {t('Decline')}
                </Button>
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-2 flex min-h-0 flex-1 flex-col">
        <div className="mb-1 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1 text-xs font-medium text-[var(--md-sys-color-on-surface)]">
            <ListMusic className="h-3.5 w-3.5" />
            {t('Queue (')}
            {state.queue.length})
          </div>
          <span className="text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
            {modeLabel(state.playMode)}
          </span>
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-0.5">
          {state.queue.length === 0 ? (
            <p className="py-2 text-xs text-[var(--md-sys-color-on-surface-variant)]">
              {t('Your queue is empty. Choose a song above to get started.')}
            </p>
          ) : (
            state.queue.map((item, index) => (
              <div
                key={item.queueItemId}
                className={cn(
                  'flex min-w-0 items-center gap-1 rounded-lg px-2 py-1.5 text-xs',
                  item.queueItemId === state.currentQueueItemId
                    ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                    : 'bg-[var(--md-sys-color-surface-container-low)] text-[var(--md-sys-color-on-surface)]'
                )}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 truncate text-left"
                  onClick={() => sync.select(item.queueItemId)}
                  title={item.title}
                >
                  {item.title}
                  {item.artist ? ` · ${item.artist}` : ''}
                </button>
                {canSelect && (
                  <>
                    <button
                      type="button"
                      aria-label={t('Move track up')}
                      title={t('Move up')}
                      onClick={() => moveQueueItem(index, -1)}
                      disabled={index === 0}
                      className="rounded p-1 disabled:opacity-40"
                    >
                      <ChevronUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={t('Move track down')}
                      title={t('Move down')}
                      onClick={() => moveQueueItem(index, 1)}
                      disabled={index === state.queue.length - 1}
                      className="rounded p-1 disabled:opacity-40"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label={t('Remove track')}
                      title={t('Remove')}
                      onClick={() => sync.remove(item.queueItemId)}
                      className="rounded p-1 text-[var(--md-sys-color-error)]"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </>
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {canSelect &&
      import.meta.env.DEV &&
      import.meta.env.VITE_MUSIC_FIXTURES === 'true' ? (
        <form
          className="mt-2 grid grid-cols-[1fr_auto] gap-1.5"
          onSubmit={handleAdd}
        >
          <div className="min-w-0 space-y-1.5">
            <Input
              aria-label={t('Test music reference')}
              value={sourceRef}
              onChange={(event) => setSourceRef(event.target.value)}
              size="sm"
              placeholder="music://fixture/blue-hour"
            />
            <div className="grid grid-cols-2 gap-1.5">
              <Input
                aria-label={t('Track title')}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                size="sm"
                placeholder={t('Track title')}
              />
              <Input
                aria-label={t('Artist')}
                value={artist}
                onChange={(event) => setArtist(event.target.value)}
                size="sm"
                placeholder={t('Artist')}
              />
            </div>
          </div>
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disableAnimation
            icon={<Plus className="h-4 w-4" />}
            aria-label={t('Add track')}
            title={t('Add track')}
          >
            {t('Add')}
          </Button>
        </form>
      ) : !canControl ? (
        <div className="mt-2 flex items-center gap-2 text-[11px] text-[var(--md-sys-color-on-surface-variant)]">
          <RotateCcw className="h-3.5 w-3.5 shrink-0" />
          {t('Playback changes are sent to the host for approval.')}
          {state.pendingControlRequests.length > 0 &&
            t('(Waiting: {value1}）', {
              value1: state.pendingControlRequests.length,
            })}
        </div>
      ) : null}

      {state.error && (
        <p
          role="alert"
          className="mt-1 truncate text-[11px] text-[var(--md-sys-color-error)]"
        >
          {t(state.error)}
        </p>
      )}
    </Card>
  )
}
