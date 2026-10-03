import { t, useTranslation } from '@/i18n'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Cloud,
  FileText,
  Heart,
  ListMusic,
  MessageCircle,
  Radio,
  Search,
  ThumbsUp,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { apiGet, apiPost } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import { formatMusicTime } from './domain'
import {
  catalogErrorMessage,
  formatQualityFacts,
  isQualityAvailable,
  normalizeCatalogTrack,
  qualityLabel,
  qualityOptions,
} from './catalog-domain'
import { useNcmCatalogStore, type NcmCatalogView } from './catalog-store'
import {
  isMusicQuality,
  MUSIC_QUALITY_VALUES,
  type MusicQuality,
} from './source-resolver'
import type {
  MusicCatalogAlbum,
  MusicCatalogAlbumSummary,
  MusicCatalogArtistDetail,
  MusicCatalogCommentPage,
  MusicCatalogLyrics,
  MusicCatalogPage,
  MusicCatalogPlaylist,
  MusicCatalogPlaylistDetail,
  MusicCatalogSearchItem,
  MusicCatalogTrack,
  NcmCatalogSearchType,
} from './catalog-types'
import { useMusicStore } from './store'

interface NcmCatalogPanelProps {
  isHost: boolean
  loggedIn: boolean
  onAddTrack: (item: {
    sourceRef: string
    title: string
    artist?: string
    album?: string
    artworkUrl?: string | null
    durationMs?: number
    metadata?: Record<string, unknown>
  }) => boolean
}

interface CatalogApiBody {
  success?: boolean
  code?: string
  message?: string
  data?: unknown
  items?: unknown[]
  [key: string]: unknown
}

type DetailTarget =
  | { kind: 'playlist'; id: string }
  | { kind: 'album'; id: string }
  | { kind: 'artist'; id: string }

type AuxiliaryTarget = {
  kind: 'lyrics' | 'comments'
  track: MusicCatalogTrack
  commentMode?: 'hot' | 'latest'
} | null

const navOptions: Array<{
  value: NcmCatalogView | 'albums' | 'artists'
  label: string
  icon: typeof Search
  private?: boolean
}> = [
  { value: 'search', label: 'Search', icon: Search },
  { value: 'playlists', label: 'Playlists', icon: ListMusic, private: true },
  { value: 'albums', label: 'Saved albums', icon: ListMusic, private: true },
  { value: 'artists', label: 'Saved artists', icon: ListMusic, private: true },
  { value: 'liked', label: 'Liked', icon: Heart, private: true },
  { value: 'fm', label: 'Personal FM', icon: Radio, private: true },
  { value: 'cloud', label: 'Cloud music', icon: Cloud, private: true },
]

function unwrap<T>(body: CatalogApiBody | null): T | null {
  if (!body) return null
  if (body.data && typeof body.data === 'object' && !Array.isArray(body.data))
    return body.data as T
  return body as T
}

function errorFrom(result: { data: CatalogApiBody | null }): string {
  return catalogErrorMessage(result.data?.code, result.data?.message)
}

function pageFrom<T>(body: CatalogApiBody | null): MusicCatalogPage<T> | null {
  const value = unwrap<MusicCatalogPage<T>>(body)
  if (
    !value ||
    !Array.isArray(value.items) ||
    !Number.isSafeInteger(value.offset) ||
    !Number.isSafeInteger(value.pageSize) ||
    typeof value.hasMore !== 'boolean'
  )
    return null
  return {
    items: value.items,
    offset: value.offset,
    pageSize: value.pageSize,
    hasMore: value.hasMore,
    total: typeof value.total === 'number' ? value.total : null,
  }
}

function isTrack(
  value: MusicCatalogSearchItem | MusicCatalogTrack
): value is MusicCatalogTrack {
  return typeof value === 'object' && value !== null && 'trackId' in value
}

function isPlaylist(
  value: MusicCatalogSearchItem
): value is MusicCatalogPlaylist {
  return typeof value === 'object' && value !== null && 'playlistId' in value
}

function isAlbumSummary(
  value: MusicCatalogSearchItem
): value is MusicCatalogAlbumSummary {
  return typeof value === 'object' && value !== null && 'albumId' in value
}

function qualityPreference(): MusicQuality {
  try {
    const stored = localStorage.getItem('tongmu-music-quality')
    return isMusicQuality(stored) ? stored : 'exhigh'
  } catch {
    return 'exhigh'
  }
}

function rememberQuality(value: MusicQuality): void {
  try {
    localStorage.setItem('tongmu-music-quality', value)
  } catch {
    // A blocked localStorage must not prevent queueing a song.
  }
}

function trackKey(track: MusicCatalogTrack): string {
  return track.trackId
}

export function NcmCatalogPanel({
  isHost,
  loggedIn,
  onAddTrack,
}: NcmCatalogPanelProps) {
  useTranslation()

  const accountId = useAuthStore((state) => state.user?.id || null)
  const catalog = useNcmCatalogStore()
  const musicPositionSec = useMusicStore((state) => state.positionSec)
  const currentSourceRef = useMusicStore((state) => state.currentSourceRef)
  const [detailTarget, setDetailTarget] = useState<DetailTarget | null>(null)
  const [auxiliaryTarget, setAuxiliaryTarget] = useState<AuxiliaryTarget>(null)
  const [preferredQuality, setPreferredQuality] =
    useState<MusicQuality>(qualityPreference)
  const [commentMode, setCommentMode] = useState<'hot' | 'latest'>('latest')
  const [searchOffset, setSearchOffset] = useState(0)
  const [privateOffset, setPrivateOffset] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const searchAbortRef = useRef<AbortController | null>(null)
  const detailAbortRef = useRef<AbortController | null>(null)
  const auxiliaryAbortRef = useRef<AbortController | null>(null)

  const setError = catalog.setError

  const changeSearchQuery = useCallback((value: string) => {
    setSearchOffset(0)
    useNcmCatalogStore.getState().setSearchQuery(value)
  }, [])

  const changeSearchType = useCallback((value: NcmCatalogSearchType) => {
    setSearchOffset(0)
    useNcmCatalogStore.getState().setSearchType(value)
  }, [])

  useEffect(() => {
    const state = useNcmCatalogStore.getState()
    if (state.accountId !== accountId) state.resetForAccount(accountId)
    if (!loggedIn) state.clearPrivate()
  }, [accountId, loggedIn])

  useEffect(() => {
    searchAbortRef.current?.abort()
    const catalogState = useNcmCatalogStore.getState()
    const searchQuery = catalogState.searchQuery
    const searchType = catalogState.searchType
    const view = catalogState.view
    if (view !== 'search' || !searchQuery.trim()) {
      catalogState.setSearchResults(null)
      catalogState.setLoading(false)
      return
    }
    const timer = window.setTimeout(() => {
      const controller = new AbortController()
      const generation = useNcmCatalogStore.getState().generation
      searchAbortRef.current = controller
      useNcmCatalogStore.getState().setLoading(true)
      const params = new URLSearchParams({
        query: searchQuery.trim(),
        type: searchType,
        offset: String(searchOffset),
        pageSize: '20',
      })
      void apiGet<CatalogApiBody>(
        `/api/music/ncm/search?${params.toString()}`,
        { signal: controller.signal }
      )
        .then((result) => {
          if (
            controller.signal.aborted ||
            useNcmCatalogStore.getState().generation !== generation
          )
            return
          if (!result.ok) {
            setError(errorFrom(result))
            return
          }
          const page = pageFrom<MusicCatalogSearchItem>(result.data)
          if (!page) {
            setError(t('The music service returned an invalid search result.'))
            return
          }
          const normalizedItems: MusicCatalogSearchItem[] = []
          for (const item of page.items) {
            if (!isTrack(item)) {
              normalizedItems.push(item)
              continue
            }
            const normalized = normalizeCatalogTrack(item)
            if (normalized) normalizedItems.push(normalized)
          }
          useNcmCatalogStore
            .getState()
            .setSearchResults({ ...page, items: normalizedItems })
        })
        .catch(() => {
          if (!controller.signal.aborted) setError(t('Could not search music.'))
        })
        .finally(() => {
          if (
            !controller.signal.aborted &&
            useNcmCatalogStore.getState().generation === generation
          )
            useNcmCatalogStore.getState().setLoading(false)
        })
    }, 300)
    return () => {
      window.clearTimeout(timer)
      searchAbortRef.current?.abort()
    }
  }, [
    catalog.searchQuery,
    catalog.searchType,
    catalog.view,
    searchOffset,
    setError,
  ])

  useEffect(() => {
    const view = catalog.view
    if (!['playlists', 'albums', 'artists', 'liked', 'fm', 'cloud'].includes(view)) return
    if (!loggedIn || !accountId) {
      setError(t('Connect your NetEase Music account first.'))
      return
    }
    const controller = new AbortController()
    const generation = useNcmCatalogStore.getState().generation
    useNcmCatalogStore.getState().setLoading(true)
    const path = view === 'albums'
      ? '/api/music/ncm/subscribed-albums'
      : view === 'artists'
        ? '/api/music/ncm/subscribed-artists'
        : view === 'playlists'
          ? '/api/music/ncm/playlists'
          : view === 'liked'
            ? '/api/music/ncm/liked'
            : view === 'cloud'
              ? '/api/music/ncm/cloud'
              : '/api/music/ncm/fm'
    const params = view === 'fm' ? '' : `?offset=${privateOffset}&pageSize=20`
    void apiGet<CatalogApiBody>(`${path}${params}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (
          controller.signal.aborted ||
          useNcmCatalogStore.getState().generation !== generation
        )
          return
        if (!result.ok) {
          setError(errorFrom(result))
          return
        }
        const page = pageFrom<MusicCatalogSearchItem>(
          result.data
        )
        if (!page) {
          setError(t('The music service returned an invalid collection.'))
          return
        }
        useNcmCatalogStore.getState().setPrivatePage(page)
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(t('Could not load your collection.'))
      })
      .finally(() => {
        if (
          !controller.signal.aborted &&
          useNcmCatalogStore.getState().generation === generation
        )
          useNcmCatalogStore.getState().setLoading(false)
      })
    return () => controller.abort()
  }, [accountId, catalog.view, loggedIn, privateOffset, setError])

  useEffect(() => {
    if (!detailTarget) return
    detailAbortRef.current?.abort()
    const controller = new AbortController()
    detailAbortRef.current = controller
    const generation = useNcmCatalogStore.getState().generation
    useNcmCatalogStore.getState().setLoading(true)
    const path =
      detailTarget.kind === 'playlist'
        ? `/api/music/ncm/playlist/${detailTarget.id}?offset=0&pageSize=30`
        : detailTarget.kind === 'album'
          ? `/api/music/ncm/album/${detailTarget.id}`
          : `/api/music/ncm/artist/${detailTarget.id}?offset=0&pageSize=30`
    void apiGet<CatalogApiBody>(path, { signal: controller.signal })
      .then((result) => {
        if (
          controller.signal.aborted ||
          useNcmCatalogStore.getState().generation !== generation
        )
          return
        if (!result.ok) {
          setError(errorFrom(result))
          return
        }
        const value = unwrap<
          | MusicCatalogPlaylistDetail
          | MusicCatalogAlbum
          | MusicCatalogArtistDetail
        >(result.data)
        if (!value) {
          setError(t('The music service returned invalid details.'))
          return
        }
        if (detailTarget.kind === 'playlist' && 'playlist' in value)
          useNcmCatalogStore
            .getState()
            .setPlaylistDetail(value as MusicCatalogPlaylistDetail)
        else if (detailTarget.kind === 'album' && 'albumId' in value)
          useNcmCatalogStore
            .getState()
            .setAlbumDetail(value as MusicCatalogAlbum)
        else if (detailTarget.kind === 'artist' && 'artist' in value)
          useNcmCatalogStore
            .getState()
            .setArtistDetail(value as MusicCatalogArtistDetail)
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError(t('Could not load music details.'))
      })
      .finally(() => {
        if (
          !controller.signal.aborted &&
          useNcmCatalogStore.getState().generation === generation
        )
          useNcmCatalogStore.getState().setLoading(false)
      })
    return () => controller.abort()
  }, [detailTarget, setError])

  const loadAuxiliary = useCallback(
    (
      kind: 'lyrics' | 'comments',
      track: MusicCatalogTrack,
      mode: 'hot' | 'latest' = commentMode
    ) => {
      setAuxiliaryTarget({
        kind,
        track,
        commentMode: kind === 'comments' ? mode : undefined,
      })
      auxiliaryAbortRef.current?.abort()
      const controller = new AbortController()
      auxiliaryAbortRef.current = controller
      const catalogGeneration = useNcmCatalogStore.getState().generation
      const musicState = useMusicStore.getState()
      const guardedGeneration =
        musicState.currentSourceRef === track.sourceRef
          ? musicState.musicGeneration
          : null
      const path =
        kind === 'lyrics'
          ? `/api/music/ncm/lyrics/${track.trackId}`
          : `/api/music/ncm/comments/song/${track.trackId}?mode=${mode}&offset=0&pageSize=20`
      void apiGet<CatalogApiBody>(path, { signal: controller.signal })
        .then((result) => {
          if (
            controller.signal.aborted ||
            useNcmCatalogStore.getState().generation !== catalogGeneration
          )
            return
          const currentMusic = useMusicStore.getState()
          if (
            guardedGeneration !== null &&
            (currentMusic.currentSourceRef !== track.sourceRef ||
              currentMusic.musicGeneration !== guardedGeneration)
          )
            return
          if (!result.ok) {
            setError(errorFrom(result))
            return
          }
          if (kind === 'lyrics') {
            const value = unwrap<MusicCatalogLyrics>(result.data)
            if (value) {
              useNcmCatalogStore.getState().setLyrics(track.trackId, value)
              setError(null)
            } else setError(t('Invalid lyrics.'))
          } else {
            const value = unwrap<MusicCatalogCommentPage>(result.data)
            if (value) {
              useNcmCatalogStore
                .getState()
                .setComments(`${track.trackId}:song`, value)
              setError(null)
            } else setError(t('Invalid comments.'))
          }
        })
        .catch(() => {
          if (!controller.signal.aborted)
            setError(
              kind === 'lyrics'
                ? t('Could not load lyrics.')
                : t('Could not load comments.')
            )
        })
    },
    [commentMode, setError]
  )

  const chooseQuality = useCallback((value: string) => {
    if (!isMusicQuality(value)) return
    setPreferredQuality(value)
    rememberQuality(value)
  }, [])

  const addTrack = useCallback(
    (track: MusicCatalogTrack) => {
      if (!isHost) {
        setError(t('Queue permission required.'))
        return
      }
      if (!isQualityAvailable(track, preferredQuality)) {
        setError(
          t('“{value1}” is unavailable. Choose an available quality.', {
            value1: qualityLabel(preferredQuality),
          })
        )
        return
      }
      const accepted = onAddTrack({
        sourceRef: track.sourceRef,
        title: track.title,
        artist: track.artist,
        album: track.album,
        artworkUrl: track.artworkUrl,
        durationMs: track.durationMs || 0,
        metadata: {
          provider: 'ncm',
          trackId: track.trackId,
          requestedQuality: preferredQuality,
        },
      })
      if (accepted) {
        setNotice(t('Added to queue: {title}', { title: track.title }))
        window.setTimeout(() => setNotice(null), 2_500)
      }
    },
    [isHost, onAddTrack, preferredQuality, setError]
  )

  const openView = useCallback(
    (view: NcmCatalogView | 'albums' | 'artists') => {
      setDetailTarget(null)
      setAuxiliaryTarget(null)
      setPrivateOffset(0)
      catalog.setPrivatePage(null)
      catalog.setView(view)
    },
    [catalog]
  )

  const detailTitle =
    detailTarget?.kind === 'playlist'
      ? catalog.playlistDetail?.playlist.title
      : detailTarget?.kind === 'album'
        ? catalog.albumDetail?.title
        : detailTarget?.kind === 'artist'
          ? catalog.artistDetail?.artist.name
          : null

  const renderQuality = useCallback(
    (track: MusicCatalogTrack) => {
      const options = qualityOptions(track)
      const displayedOptions = options.includes(preferredQuality)
        ? options
        : [preferredQuality, ...options]
      return (
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
          <label className="flex min-w-0 items-center gap-1">
            <span className="shrink-0">{t('Audio quality')}</span>
            <select
              aria-label={t('{value1} Quality', { value1: track.title })}
              value={preferredQuality}
              onChange={(event) => chooseQuality(event.target.value)}
              className="max-w-[8rem] rounded border border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-high)] px-1.5 py-1 text-[10px] text-[var(--md-sys-color-on-surface)]"
            >
              {displayedOptions.map((quality) => (
                <option
                  key={quality}
                  value={quality}
                  disabled={!isQualityAvailable(track, quality)}
                >
                  {qualityLabel(quality)}
                  {isQualityAvailable(track, quality)
                    ? ''
                    : t(' (unavailable)')}
                </option>
              ))}
            </select>
          </label>
          {track.availableQualities.length > 0 ? (
            <span>
              {formatQualityFacts(
                preferredQuality,
                null,
                track.availableQualities,
                track.availableMaximum
              )}
            </span>
          ) : (
            <span>
              {t(
                'Available quality is unknown. Your choice will be checked before playback.'
              )}
            </span>
          )}
        </div>
      )
    },
    [chooseQuality, preferredQuality]
  )

  const renderTrack = useCallback(
    (track: MusicCatalogTrack, index = 0) => (
      <div
        key={`${trackKey(track)}-${index}`}
        className="min-w-0 rounded-lg bg-[var(--md-sys-color-surface-container-low)] p-2"
      >
        <div className="flex min-w-0 items-start gap-2">
          {track.artworkUrl ? (
            <img
              src={track.artworkUrl}
              alt=""
              className="h-9 w-9 shrink-0 rounded object-cover"
              loading="lazy"
            />
          ) : (
            <div
              className="h-9 w-9 shrink-0 rounded bg-[var(--md-sys-color-surface-container-high)]"
              aria-hidden="true"
            />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium text-[var(--md-sys-color-on-surface)]">
              {track.title}
            </p>
            <p className="truncate text-[11px] text-[var(--md-sys-color-on-surface-variant)]">
              {track.artist || t('Unknown artist')}
              {track.album ? ` · ${track.album}` : ''}
              {track.durationMs
                ? ` · ${formatMusicTime(track.durationMs / 1000)}`
                : ''}
            </p>
            {renderQuality(track)}
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-1">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disableAnimation
              onClick={() => addTrack(track)}
              disabled={!isHost}
              aria-label={t('Add {value1} to queue', { value1: track.title })}
            >
              {t('Add to queue')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disableAnimation
              onClick={() => loadAuxiliary('lyrics', track)}
              aria-label={t('View {value1} Lyrics', { value1: track.title })}
              icon={<FileText className="h-3.5 w-3.5" />}
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disableAnimation
              onClick={() => loadAuxiliary('comments', track)}
              aria-label={t('View {value1} Comments', { value1: track.title })}
              icon={<MessageCircle className="h-3.5 w-3.5" />}
            />
          </div>
        </div>
      </div>
    ),
    [addTrack, isHost, loadAuxiliary, renderQuality]
  )

  const renderPlaylist = useCallback(
    (playlist: MusicCatalogPlaylist, index = 0) => (
      <button
        key={`${playlist.playlistId}-${index}`}
        type="button"
        onClick={() =>
          setDetailTarget({ kind: 'playlist', id: playlist.playlistId })
        }
        className="flex min-w-0 items-center gap-2 rounded-lg bg-[var(--md-sys-color-surface-container-low)] p-2 text-left hover:bg-[var(--md-sys-color-surface-container-high)]"
      >
        {playlist.artworkUrl ? (
          <img
            src={playlist.artworkUrl}
            alt=""
            className="h-9 w-9 shrink-0 rounded object-cover"
            loading="lazy"
          />
        ) : (
          <div
            className="h-9 w-9 shrink-0 rounded bg-[var(--md-sys-color-surface-container-high)]"
            aria-hidden="true"
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">
            {playlist.title}
          </span>
          <span className="block truncate text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
            {playlist.creatorName || t('Unknown creator')} ·{' '}
            {playlist.trackCount ?? '?'} {t('tracks')}
          </span>
        </span>
      </button>
    ),
    []
  )

  const renderSearchItem = (item: MusicCatalogSearchItem, index: number) => {
    if (isTrack(item)) return renderTrack(item, index)
    if (isPlaylist(item)) return renderPlaylist(item, index)
    if (isAlbumSummary(item))
      return (
        <button
          key={`${item.albumId}-${index}`}
          type="button"
          onClick={() => setDetailTarget({ kind: 'album', id: item.albumId })}
          className="flex min-w-0 items-center gap-2 rounded-lg bg-[var(--md-sys-color-surface-container-low)] p-2 text-left hover:bg-[var(--md-sys-color-surface-container-high)]"
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium">
              {item.title}
            </span>
            <span className="block truncate text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
              {item.artist || t('Unknown artist')} · {item.trackCount ?? '?'}{' '}
              {t('tracks')}
            </span>
          </span>
          <span className="shrink-0 text-[10px]">{t('Open album')}</span>
        </button>
      )
    return (
      <button
        key={`${item.artistId}-${index}`}
        type="button"
        onClick={() => setDetailTarget({ kind: 'artist', id: item.artistId })}
        className="flex min-w-0 items-center gap-2 rounded-lg bg-[var(--md-sys-color-surface-container-low)] p-2 text-left hover:bg-[var(--md-sys-color-surface-container-high)]"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">
            {item.name}
          </span>
          <span className="block truncate text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
            {item.trackCount ?? '?'} {t('tracks ·')} {item.albumCount ?? '?'}{' '}
            {t('albums')}
          </span>
        </span>
        <span className="shrink-0 text-[10px]">{t('Open artist')}</span>
      </button>
    )
  }

  const renderDetails = () => {
    if (catalog.playlistDetail) {
      return (
        <div className="space-y-1.5">
          <div className="rounded-lg bg-[var(--md-sys-color-surface-container-low)] p-2">
            <p className="text-xs font-medium">
              {catalog.playlistDetail.playlist.title}
            </p>
            <p className="mt-0.5 text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
              {catalog.playlistDetail.playlist.description ||
                t('No description')}
            </p>
          </div>
          {catalog.playlistDetail.tracks.map(renderTrack)}
          {catalog.playlistDetail.hasMore && (
            <p className="text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
              {t('Open the playlist to browse more tracks.')}
            </p>
          )}
        </div>
      )
    }
    if (catalog.albumDetail)
      return (
        <div className="space-y-1.5">
          <div className="rounded-lg bg-[var(--md-sys-color-surface-container-low)] p-2">
            <p className="text-xs font-medium">{catalog.albumDetail.title}</p>
            <p className="text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
              {catalog.albumDetail.artist || t('Unknown artist')} ·{' '}
              {catalog.albumDetail.description || t('No description')}
            </p>
          </div>
          {catalog.albumDetail.tracks.map(renderTrack)}
        </div>
      )
    if (catalog.artistDetail)
      return (
        <div className="space-y-1.5">
          <div className="rounded-lg bg-[var(--md-sys-color-surface-container-low)] p-2">
            <p className="text-xs font-medium">
              {catalog.artistDetail.artist.name}
            </p>
            <p className="text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
              {t('Popular tracks:')}{' '}
              {catalog.artistDetail.artist.topTracks.length}{' '}
              {t('tracks · Albums')} {catalog.artistDetail.artist.albums.length}{' '}
              {t('albums')}
            </p>
          </div>
          {catalog.artistDetail.artist.topTracks.map(renderTrack)}
          {catalog.artistDetail.artist.albums.map((album, index) => (
            <button
              key={`${album.albumId}-${index}`}
              type="button"
              onClick={() =>
                setDetailTarget({ kind: 'album', id: album.albumId })
              }
              className="block w-full truncate rounded-lg bg-[var(--md-sys-color-surface-container-low)] p-2 text-left text-xs"
            >
              {t('Albums：')}
              {album.title} · {album.artist || t('Unknown artist')}
            </button>
          ))}
        </div>
      )
    return null
  }

  const renderAuxiliary = () => {
    if (!auxiliaryTarget) return null
    const track = auxiliaryTarget.track
    if (auxiliaryTarget.kind === 'lyrics') {
      const lyrics = catalog.lyrics[track.trackId]
      const activeLine =
        currentSourceRef === track.sourceRef
          ? [...(lyrics?.original || [])]
              .reverse()
              .find(
                (line) =>
                  line.timestampMs !== null &&
                  line.timestampMs <= musicPositionSec * 1_000
              )?.timestampMs
          : null
      return (
        <div
          className="mt-2 rounded-lg border border-[var(--md-sys-color-outline-variant)] p-2"
          aria-live="polite"
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <p className="text-xs font-medium">
              {t('Lyrics ·')} {track.title}
            </p>
            <button
              type="button"
              className="text-[10px] underline"
              onClick={() => setAuxiliaryTarget(null)}
            >
              {t('Close')}
            </button>
          </div>
          {!lyrics ? (
            <p className="text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
              {t('Loading lyrics…')}
            </p>
          ) : (
            <div className="max-h-48 space-y-0.5 overflow-y-auto text-[11px]">
              {(
                [
                  ['Original', lyrics.original],
                  ['Translation', lyrics.translated],
                  ['Romanized', lyrics.romanized],
                ] as const
              ).map(([label, lines]) => (
                <section key={label} className="mb-1">
                  <p className="mb-0.5 text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
                    {t(label)}
                  </p>
                  {lines.length === 0 ? (
                    <p className="px-1 text-[10px]">
                      {t('No {kind} lyrics.', { kind: t(label) })}
                    </p>
                  ) : (
                    lines.map((line, index) => (
                      <p
                        key={`${label}-${line.timestampMs ?? 'u'}-${index}`}
                        className={
                          label === 'Original' &&
                          line.timestampMs === activeLine
                            ? 'rounded bg-[var(--md-sys-color-primary-container)] px-1'
                            : 'px-1'
                        }
                      >
                        {line.text}
                      </p>
                    ))
                  )}
                </section>
              ))}
            </div>
          )}
        </div>
      )
    }
    const activeCommentMode = auxiliaryTarget.commentMode || 'latest'
    const comments = catalog.comments[`${track.trackId}:song`]
    return (
      <div
        className="mt-2 rounded-lg border border-[var(--md-sys-color-outline-variant)] p-2"
        aria-live="polite"
      >
        <div className="mb-1 flex items-center justify-between gap-2">
          <p className="text-xs font-medium">
            {t('Comments ·')} {track.title}
          </p>
          <button
            type="button"
            className="text-[10px] underline"
            onClick={() => setAuxiliaryTarget(null)}
          >
            {t('Close')}
          </button>
        </div>
        <div className="mb-1 flex gap-1">
          <Button
            type="button"
            size="sm"
            variant={activeCommentMode === 'latest' ? 'secondary' : 'ghost'}
            disableAnimation
            onClick={() => {
              setCommentMode('latest')
              loadAuxiliary('comments', track, 'latest')
            }}
          >
            {t('Newest')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={activeCommentMode === 'hot' ? 'secondary' : 'ghost'}
            disableAnimation
            onClick={() => {
              setCommentMode('hot')
              loadAuxiliary('comments', track, 'hot')
            }}
          >
            {t('Popular')}
          </Button>
        </div>
        {!comments ? (
          <p className="text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
            {t('Loading comments…')}
          </p>
        ) : (
          <div className="max-h-48 space-y-1.5 overflow-y-auto">
            {comments.items.length === 0 ? (
              <p className="text-[10px]">{t('No comments yet.')}</p>
            ) : (
              comments.items.map((comment) => (
                <div
                  key={comment.commentId}
                  className="border-b border-[var(--md-sys-color-outline-variant)] pb-1 text-[10px]"
                >
                  <p className="font-medium">{comment.authorName}</p>
                  <p className="whitespace-pre-wrap break-words">
                    {comment.text}
                  </p>
                  <p className="text-[9px] text-[var(--md-sys-color-on-surface-variant)]">
                    {t('Likes:')} {comment.likedCount}
                    {loggedIn && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disableAnimation
                        className="ml-1 h-5 px-1 text-[9px]"
                        icon={<ThumbsUp className="h-2.5 w-2.5" />}
                        onClick={() => {
                          void apiPost('/api/music/ncm/comment-like', {
                            resourceType: 'song',
                            resourceId: track.trackId,
                            commentId: comment.commentId,
                            liked: !comment.liked,
                          })
                        }}
                      >
                        {t('Like')}
                      </Button>
                    )}
                  </p>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    )
  }

  const showPrivate =
    catalog.view === 'playlists' ||
    catalog.view === 'albums' ||
    catalog.view === 'artists' ||
    catalog.view === 'liked' ||
    catalog.view === 'fm' ||
    catalog.view === 'cloud'
  const searchPage = catalog.searchResults
  const privatePage = catalog.privatePage
  const privateTracks =
    privatePage?.items.filter((item): item is MusicCatalogTrack =>
      isTrack(item)
    ) || []

  const pageControls = useMemo(() => {
    const page = showPrivate ? privatePage : searchPage
    if (!page || (!page.hasMore && page.offset === 0)) return null
    const setOffset = showPrivate ? setPrivateOffset : setSearchOffset
    return (
      <div className="flex items-center justify-between gap-2 pt-1 text-[10px]">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disableAnimation
          disabled={page.offset === 0}
          onClick={() => setOffset(Math.max(0, page.offset - page.pageSize))}
        >
          {t('Previous page')}
        </Button>
        <span>
          {page.offset + 1}–{page.offset + page.items.length}
          {page.total !== null ? ` / ${page.total}` : ''}
        </span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disableAnimation
          disabled={!page.hasMore}
          onClick={() => setOffset(page.offset + page.pageSize)}
        >
          {t('Next page')}
        </Button>
      </div>
    )
  }, [privatePage, searchPage, showPrivate])

  return (
    <div className="mt-3 min-w-0 border-t border-[var(--md-sys-color-outline-variant)] pt-3">
      <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Search className="h-3.5 w-3.5 shrink-0" />
          <p className="truncate text-xs font-medium">{t('Find your music')}</p>
        </div>
        <span className="shrink-0 text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
          {loggedIn
            ? t('Your personal collection')
            : t('Search the public catalog')}
        </span>
      </div>
      <div
        className="flex min-w-0 gap-1 overflow-x-auto pb-1"
        role="tablist"
        aria-label={t('Music categories')}
      >
        {navOptions.map((option) => {
          const Icon = option.icon
          const selected = catalog.view === option.value
          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => openView(option.value)}
              className={`inline-flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[10px] ${selected ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]' : 'bg-[var(--md-sys-color-surface-container-low)] text-[var(--md-sys-color-on-surface-variant)]'}`}
            >
              <Icon className="h-3 w-3" />
              {t(option.label)}
              {option.private && !loggedIn ? t(' · Sign in') : ''}
            </button>
          )
        })}
      </div>

      {catalog.error && (
        <p
          role="alert"
          className="mb-1 text-[10px] text-[var(--md-sys-color-error)]"
        >
          {catalog.error}
        </p>
      )}
      {notice && (
        <p
          role="status"
          className="mb-1 text-[10px] text-[var(--md-sys-color-primary)]"
        >
          {t(notice)}
        </p>
      )}

      {detailTarget ? (
        <div className="min-w-0">
          <div className="mb-1 flex items-center gap-1">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disableAnimation
              icon={<ArrowLeft className="h-3.5 w-3.5" />}
              onClick={() => {
                setDetailTarget(null)
                catalog.setPlaylistDetail(null)
                catalog.setAlbumDetail(null)
                catalog.setArtistDetail(null)
              }}
            >
              {t('Back')}
            </Button>
            <span className="truncate text-xs font-medium">
              {detailTitle || t('Details')}
            </span>
          </div>
          {renderDetails()}
        </div>
      ) : (
        <>
          {catalog.view === 'search' && (
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-1.5">
              <Input
                aria-label={t('Search music')}
                size="sm"
                placeholder={t('Search songs, playlists, albums or artists')}
                value={catalog.searchQuery}
                onChange={(event) => changeSearchQuery(event.target.value)}
              />
              <select
                aria-label={t('Search category')}
                value={catalog.searchType}
                onChange={(event) =>
                  changeSearchType(event.target.value as NcmCatalogSearchType)
                }
                className="max-w-[5.5rem] rounded border border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-high)] px-1.5 text-xs"
              >
                <option value="song">{t('Songs')}</option>
                <option value="playlist">{t('Playlists')}</option>
                <option value="album">{t('Albums')}</option>
                <option value="artist">{t('Artist')}</option>
              </select>
            </div>
          )}
          {showPrivate && !loggedIn ? (
            <div className="rounded-lg bg-[var(--md-sys-color-surface-container-low)] p-3 text-center text-[11px] text-[var(--md-sys-color-on-surface-variant)]">
              {t(
                'Connect your NetEase Music account above to browse playlists, liked songs, Personal FM and cloud music from your own account.'
              )}
            </div>
          ) : showPrivate ? (
            <div className="mt-2 space-y-1.5">
              {['playlists', 'albums', 'artists'].includes(catalog.view)
                ? catalog.privateItems.map(renderSearchItem)
                : privateTracks.map((track, index) => (
                    <div key={`${track.trackId}-${index}`}>
                      {catalog.view === 'fm' && (
                        <div className="mb-0.5 text-right">
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            disableAnimation
                            onClick={() => {
                              void apiPost<CatalogApiBody>(
                                '/api/music/ncm/fm/dislike',
                                { trackId: track.trackId }
                              ).then((result) => {
                                if (!result.ok) setError(errorFrom(result))
                                else
                                  setNotice(
                                    t(
                                      'Removed from your Personal FM recommendations.'
                                    )
                                  )
                              })
                            }}
                          >
                            {t('Dislike')}
                          </Button>
                        </div>
                      )}
                      {renderTrack(track)}
                    </div>
                  ))}
              {catalog.loading && <p role="status" className="text-[10px]">{t('Loading……')}</p>}
              {!catalog.loading && !catalog.error && privatePage?.items.length === 0 && (
                <p role="status" className="text-[10px]">{t('Your collection is empty.')}</p>
              )}
            </div>
          ) : (
            <div className="mt-2 space-y-1.5">
              {searchPage?.items.map(renderSearchItem)}
              {!catalog.searchQuery.trim() && (
                <p className="py-2 text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
                  {t(
                    'Search for music, then choose a track and quality. Unavailable quality options stay disabled.'
                  )}
                </p>
              )}
              {catalog.loading && (
                <p className="text-[10px]">{t('Loading……')}</p>
              )}
              {searchPage &&
                searchPage.items.length === 0 &&
                !catalog.loading && (
                  <p className="text-[10px]">{t('No results found.')}</p>
                )}
            </div>
          )}
          {pageControls}
          {auxiliaryTarget && renderAuxiliary()}
        </>
      )}
      <span className="sr-only">
        {t('Default quality:')} {qualityLabel(preferredQuality)}.{' '}
        {t('Quality choices:')} {MUSIC_QUALITY_VALUES.length} {t('options')}
      </span>
    </div>
  )
}
