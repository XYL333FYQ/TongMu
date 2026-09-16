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
import { formatMusicTime, modeLabel } from './domain'
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
  { value: 'sequential', label: '顺序播放' },
  { value: 'repeat-one', label: '单曲循环' },
  { value: 'repeat-all', label: '列表循环' },
  { value: 'shuffle', label: '随机播放' },
]

function clampProgress(value: number, duration: number): number {
  return Math.min(Math.max(0, value), Math.max(1, duration))
}

/** Together Listen controls with the narrow NCM login surface. */
export function TogetherListenPanel({
  roomId,
  isHost,
}: TogetherListenPanelProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [sourceRef, setSourceRef] = useState('music://fixture/blue-hour')
  const [title, setTitle] = useState('Blue Hour')
  const [artist, setArtist] = useState('本地夹具')
  const [ncmStatus, setNcmStatus] = useState<NcmStatusResponse | null>(null)
  const [ncmQr, setNcmQr] = useState<NcmQrResponse | null>(null)
  const [ncmBusy, setNcmBusy] = useState(false)
  const sync = useMusicSync({ roomId, isHost, audioRef })
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
    if (!sessionId || ncmQr?.status === 'logged-in') return
    const poll = async () => {
      const result = await apiGet<NcmQrResponse>(
        `/api/music/ncm/login/qr/${encodeURIComponent(sessionId)}`
      )
      if (!result.ok || !result.data) return
      setNcmQr(result.data)
      if (result.data.status === 'logged-in') {
        const current = await apiGet<NcmStatusResponse>('/api/music/ncm/status')
        if (current.ok && current.data) setNcmStatus(current.data)
      }
    }
    const timer = window.setInterval(() => {
      void poll()
    }, 1500)
    return () => window.clearInterval(timer)
  }, [ncmQr?.sessionId, ncmQr?.status])

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
    if (!isHost) return
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
              一起听
            </h3>
            <p className="truncate text-[11px] text-[var(--md-sys-color-on-surface-variant)]">
              {state.status === 'reconnecting'
                ? '正在重连…'
                : state.hostOffline
                  ? '房主离线'
                  : '房间音乐同步'}
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
            ? '加载中'
            : state.connected
              ? '已连接'
              : '未连接'}
        </span>
      </div>

      <div
        data-testid="ncm-status"
        className="mt-2 flex min-w-0 items-center justify-between gap-2 rounded-lg bg-[var(--md-sys-color-surface-container-low)] px-2 py-1.5 text-[11px] text-[var(--md-sys-color-on-surface-variant)]"
      >
        <span className="truncate">
          网易云：
          {ncmStatus?.loggedIn
            ? `已登录${ncmStatus.displayName ? ` · ${ncmStatus.displayName}` : ''}`
            : '未登录'}
        </span>
        {isHost && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disableAnimation
            disabled={ncmBusy}
            onClick={() =>
              void (ncmStatus?.loggedIn ? logoutNcm() : startNcmLogin())
            }
          >
            {ncmStatus?.loggedIn ? '退出' : '扫码登录'}
          </Button>
        )}
      </div>
      {isHost && ncmQr?.qrImageDataUrl && ncmQr.status !== 'logged-in' && (
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-[var(--md-sys-color-outline-variant)] p-2">
          <img
            src={ncmQr.qrImageDataUrl}
            alt="网易云登录二维码"
            className="h-20 w-20 rounded bg-white p-1"
          />
          <span className="text-[11px] text-[var(--md-sys-color-on-surface-variant)]">
            {ncmQr.status === 'scanned'
              ? '已扫码，请确认登录'
              : '请使用网易云手机客户端扫码'}
          </span>
        </div>
      )}

      <div className="mt-3 min-w-0 rounded-xl bg-[var(--md-sys-color-surface-container)] p-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-[var(--md-sys-color-on-surface)]">
            {state.currentItem?.title || '尚未选择歌曲'}
          </p>
          <p className="truncate text-xs text-[var(--md-sys-color-on-surface-variant)]">
            {state.currentItem?.artist || '添加本地夹具开始一起听'}
          </p>
        </div>
        <input
          aria-label="音乐播放进度"
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
            aria-label="上一首"
            title="上一首"
            size="sm"
            variant="ghost"
            disableAnimation
            icon={<SkipBack className="h-4 w-4" />}
            onClick={() => sync.previous()}
          />
          <Button
            aria-label={state.isPlaying ? '暂停' : '播放'}
            title={state.isPlaying ? '暂停' : '播放'}
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
            aria-label="下一首"
            title="下一首"
            size="sm"
            variant="ghost"
            disableAnimation
            icon={<SkipForward className="h-4 w-4" />}
            onClick={() => sync.next()}
          />
          <select
            aria-label="播放模式"
            value={state.playMode}
            onChange={(event) =>
              sync.setMode(event.target.value as MusicPlayMode)
            }
            disabled={!isHost || !state.connected}
            className="ml-1 max-w-[7rem] rounded-lg border border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-high)] px-2 py-1.5 text-xs text-[var(--md-sys-color-on-surface)]"
          >
            {modeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {isHost && state.pendingHostRequests.length > 0 && (
        <div className="mt-2 rounded-lg border border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-secondary-container)] p-2 text-xs text-[var(--md-sys-color-on-secondary-container)]">
          <div className="mb-1 font-medium">待处理的观众控制申请</div>
          {state.pendingHostRequests.map((request) => (
            <div
              key={request.requestId}
              className="flex items-center justify-between gap-2 py-1"
            >
              <span className="truncate">
                {request.action === 'seek'
                  ? '拖动进度'
                  : request.action === 'select'
                    ? '选择歌曲'
                    : request.action === 'previous'
                      ? '上一首'
                      : request.action === 'next'
                        ? '下一首'
                        : request.action === 'play'
                          ? '播放'
                          : '暂停'}
              </span>
              <span className="flex shrink-0 gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="primary"
                  disableAnimation
                  onClick={() => sync.respondControl(request.requestId, true)}
                >
                  同意
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disableAnimation
                  onClick={() => sync.respondControl(request.requestId, false)}
                >
                  拒绝
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
            队列 ({state.queue.length})
          </div>
          <span className="text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
            {modeLabel(state.playMode)}
          </span>
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-0.5">
          {state.queue.length === 0 ? (
            <p className="py-2 text-xs text-[var(--md-sys-color-on-surface-variant)]">
              队列为空，可添加本地夹具或 NCM stable ref。
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
                {isHost && (
                  <>
                    <button
                      type="button"
                      aria-label="上移歌曲"
                      title="上移"
                      onClick={() => moveQueueItem(index, -1)}
                      disabled={index === 0}
                      className="rounded p-1 disabled:opacity-40"
                    >
                      <ChevronUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label="下移歌曲"
                      title="下移"
                      onClick={() => moveQueueItem(index, 1)}
                      disabled={index === state.queue.length - 1}
                      className="rounded p-1 disabled:opacity-40"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      aria-label="移除歌曲"
                      title="移除"
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

      {isHost ? (
        <form
          className="mt-2 grid grid-cols-[1fr_auto] gap-1.5"
          onSubmit={handleAdd}
        >
          <div className="min-w-0 space-y-1.5">
            <Input
              aria-label="音乐 sourceRef"
              value={sourceRef}
              onChange={(event) => setSourceRef(event.target.value)}
              size="sm"
              placeholder="music://fixture/blue-hour"
            />
            <div className="grid grid-cols-2 gap-1.5">
              <Input
                aria-label="歌曲名称"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                size="sm"
                placeholder="歌曲名称"
              />
              <Input
                aria-label="歌手"
                value={artist}
                onChange={(event) => setArtist(event.target.value)}
                size="sm"
                placeholder="歌手"
              />
            </div>
          </div>
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disableAnimation
            icon={<Plus className="h-4 w-4" />}
            aria-label="添加歌曲"
            title="添加歌曲"
          >
            添加
          </Button>
        </form>
      ) : (
        <div className="mt-2 flex items-center gap-2 text-[11px] text-[var(--md-sys-color-on-surface-variant)]">
          <RotateCcw className="h-3.5 w-3.5 shrink-0" />
          播放、切歌和拖动进度会向房主申请控制权限。
          {state.pendingControlRequests.length > 0 &&
            `（待处理 ${state.pendingControlRequests.length}）`}
        </div>
      )}

      {state.error && (
        <p
          role="alert"
          className="mt-1 truncate text-[11px] text-[var(--md-sys-color-error)]"
        >
          {state.error}
        </p>
      )}
    </Card>
  )
}
