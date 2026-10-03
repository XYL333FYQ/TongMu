import { t, useTranslation } from '@/i18n'
import { useState, useMemo, useEffect, useRef } from 'react'
import { Play, Trash2, Film, Monitor, ListVideo, Maximize } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Text, Paragraph } from '@/components/ui/Typography'
import { Tag } from '@/components/ui/Tag'
import { Select } from '@/components/ui/Select'
import { ConfirmModal, Modal } from '@/components/ui/Modal'
import { message } from '@/components/ui/message'
import { useSocket } from '@/hooks/useSocket'
import { useRoomStore, type Movie } from '@/store/roomStore'
import { useRoomExperienceStore } from '@/store/roomExperienceStore'
import { roomErrorMessage } from '../roomErrors'
import {
  filterQualitiesByVip,
  getBilibiliUserInfo,
} from '@/modules/bilibili/bilibiliApi'
import {
  resolveMediaInput,
  stripTransientMediaDescriptor,
  toBilibiliResolvedSource,
  type ResolvedMedia,
} from '@/modules/media/mediaApi'
import { extractBvid, resolveBilibiliViaCli } from '@/modules/bilibili/cliApi'
import type { ResolvedSource } from '@/modules/bilibili/types'
import { BilibiliParseSettings } from './BilibiliParseSettings'
import {
  getEffectivePreferMp4,
  getActiveCliProxyUrl,
} from '@/modules/room/watch-together/movie-source-resolver'
import {
  useBilibiliParsePreferences,
  getBilibiliParseOptions,
} from '@/modules/bilibili/parseOptions'
import { useCliAgentStore } from '@/store/cliAgentStore'
import { cn } from '@/lib/utils'

interface MovieListPanelProps {
  isHost: boolean
}

const SOURCE_LABELS: Record<string, string> = {
  bilibili: 'Bilibili',
  mp4: 'Media link',
  webdav: 'WebDAV',
  ftp: 'FTP',
  openlist: 'OpenList',
  smb: 'SMB',
  emby: 'Emby',
  jellyfin: 'Jellyfin',
  'server-files': 'Server files',
  url: 'Media link',
  'web-page': 'Webpage',
  'browser-page': 'Browser resolver',
  live: 'Live',
  anime: 'Anime',
  anisubs: 'Anime subscriptions',
  kazumi: 'Kazumi',
}

/** 格式标签映射，用于在影片卡片中显示真实媒体格式 */
const FORMAT_LABELS: Record<string, string> = {
  mp4: 'MP4',
  hls: 'HLS',
  flv: 'FLV',
  dash: 'DASH',
  webm: 'WebM',
  mkv: 'MKV',
  mov: 'MOV',
  avi: 'AVI',
  wmv: 'WMV',
  ts: 'TS',
}

export function MovieListPanel({ isHost }: MovieListPanelProps) {
  useTranslation()

  const { socket } = useSocket()
  const movies = useRoomStore((state) => state.movies)
  const currentMovieId = useRoomStore((state) => state.currentMovieId)
  const requestMoviePlay = useRoomStore((state) => state.requestMoviePlay)
  const roomId = useRoomStore((state) => state.roomId)
  const removeMovie = useRoomStore((state) => state.removeMovie)
  const updateMovie = useRoomStore((state) => state.updateMovie)
  const setPendingQualityChange = useRoomStore(
    (state) => state.setPendingQualityChange
  )
  const setViewerCliResolvedSource = useRoomStore(
    (state) => state.setViewerCliResolvedSource
  )
  const triggerViewerSourceReload = useRoomStore(
    (state) => state.triggerViewerSourceReload
  )
  const viewerCliResolvedSource = useRoomStore(
    (state) => state.viewerCliResolvedSource
  )
  const mode = useRoomStore((state) => state.mode)
  const experience = useRoomExperienceStore((state) => state.snapshot)
  const canPlay = experience?.permissions.playback ?? isHost
  const watchActive =
    experience?.activity === 'watch' || (!experience && mode !== 'screen-share')
  const [playingId, setPlayingId] = useState<number | null>(null)
  const playInFlightRef = useRef(false)
  const [search, setSearch] = useState('')
  const [removingId, setRemovingId] = useState<number | null>(null)
  const [qualityLoadingId, setQualityLoadingId] = useState<number | null>(null)
  const [pageLoadingId, setPageLoadingId] = useState<number | null>(null)
  const [bilibiliVip, setBilibiliVip] = useState(false)
  const isScreenShare = mode === 'screen-share'

  // 弹窗显示完整影片列表
  const [showListModal, setShowListModal] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Movie | null>(null)
  const removeInFlightRef = useRef(false)

  // 获取当前 B站 会员状态，用于过滤清晰度列表
  const hasBilibiliMovie = movies.some((m) => m.sourceType === 'bilibili')
  useEffect(() => {
    if (!hasBilibiliMovie) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 无 B站影片时重置会员状态
      setBilibiliVip(false)
      return
    }
    let cancelled = false
    getBilibiliUserInfo().then((info) => {
      if (!cancelled) setBilibiliVip(info?.vipStatus === 1)
    })
    return () => {
      cancelled = true
    }
  }, [hasBilibiliMovie])

  const filteredMovies = useMemo(() => {
    if (!search.trim()) return movies
    const keyword = search.trim().toLowerCase()
    return movies.filter((m) => m.title.toLowerCase().includes(keyword))
  }, [movies, search])

  const handlePlay = (movieId: number) => {
    if (!isHost || !canPlay || !watchActive || playInFlightRef.current) {
      message.info(
        !watchActive
          ? t('Switch to Watch to play.')
          : t('Playback permission is required.')
      )
      return
    }
    if (!socket?.connected || !roomId) {
      message.error(t('Reconnect to the room first.'))
      return
    }
    playInFlightRef.current = true
    setPlayingId(movieId)
    socket
      .timeout(8000)
      .emit(
        'play-movie',
        { roomId, movieId },
        (
          timeout: Error | null,
          response?: { success: boolean; message?: string }
        ) => {
          playInFlightRef.current = false
          setPlayingId(null)
          if (useRoomStore.getState().roomId !== roomId) return
          if (timeout || !response?.success) {
            message.error(
              timeout
                ? t('Playback was not confirmed. Try again.')
                : roomErrorMessage(response?.message)
            )
            return
          }
          requestMoviePlay(movieId)
        }
      )
  }

  const handleRemove = async (movieId: number): Promise<boolean> => {
    if (removeInFlightRef.current) return false
    if (!isHost) {
      message.info(t('You do not have permission to remove content.'))
      return false
    }
    if (!roomId) {
      message.error(t('Reconnect to the room first.'))
      return false
    }
    removeInFlightRef.current = true
    setRemovingId(movieId)
    try {
      await removeMovie(roomId, movieId)
      message.success(t('Removed from the queue.'))
      return true
    } catch (err) {
      console.error('[MovieListPanel] remove movie error:', err)
      message.error(
        err instanceof Error ? err.message : t('Could not remove the video.')
      )
      return false
    } finally {
      removeInFlightRef.current = false
      setRemovingId(null)
    }
  }

  const handleQualityChange = async (movie: Movie, value: string) => {
    if (!isHost || isScreenShare || !roomId) return
    const qn = Number(value)
    if (!Number.isFinite(qn) || qn === movie.currentQn) return

    setQualityLoadingId(movie.id)
    try {
      const parsePrefs = getBilibiliParseOptions(movie.id)
      const proxyUrl = parsePrefs.cliEnabled ? getActiveCliProxyUrl() : null
      if (parsePrefs.cliEnabled && !proxyUrl) {
        throw new Error('Start your local CLI resolver.')
      }
      let resolved: ResolvedSource
      let mediaCore: ResolvedMedia | undefined

      if (proxyUrl) {
        // CLI 已连接：使用本地 CLI 代理解析，强制 DASH，不再降级 MP4
        const bvid = extractBvid(movie.url)
        if (bvid && movie.cid) {
          resolved = await resolveBilibiliViaCli(
            proxyUrl,
            bvid,
            movie.cid,
            qn,
            false,
            true
          )
        } else {
          throw new Error(
            'The BV ID or content ID is missing. The CLI resolver cannot use this item.'
          )
        }
      } else {
        mediaCore = await resolveMediaInput(movie.sourceInput || movie.url, {
          roomId,
          requestedQn: qn,
          preferMp4: getEffectivePreferMp4(movie.id),
          cid: movie.cid,
        })
        resolved = toBilibiliResolvedSource(mediaCore)
      }
      await updateMovie(roomId, movie.id, {
        ...(mediaCore
          ? {
              url: mediaCore.descriptor.finalUrl,
              sourceInput: movie.sourceInput || movie.url,
              mediaDescriptor: stripTransientMediaDescriptor(
                mediaCore.descriptor
              ),
            }
          : {}),
        audioUrl: resolved.audioUrl,
        format: resolved.format,
        videoCodec: resolved.videoCodec,
        audioCodec: resolved.audioCodec,
        duration: resolved.duration,
        cid: resolved.cid,
        currentQn: resolved.currentQn,
        acceptQuality: resolved.acceptQuality,
      })
      if (movie.id === currentMovieId) {
        setPendingQualityChange({ movieId: movie.id, resolved })
      }
    } catch (err) {
      console.error('[MovieListPanel] change quality error:', err)
      message.error(
        err instanceof Error ? err.message : t('Could not change quality.')
      )
    } finally {
      setQualityLoadingId(null)
    }
  }

  /**
   * 观众端通过本地 CLI 切换清晰度。
   *
   * 仅影响当前客户端：用观众自己的 B站 Cookie 解析所选清晰度的 DASH 地址，
   * 覆盖房主广播的源，但不写入影片列表也不广播。
   */
  const handleViewerQualityChange = async (movie: Movie, value: string) => {
    if (isHost || isScreenShare) return
    const qn = Number(value)
    if (!Number.isFinite(qn) || qn === movie.currentQn) return

    const proxyUrl = getActiveCliProxyUrl()
    if (!proxyUrl) {
      message.error(t('Local CLI resolver disconnected.'))
      return
    }

    const bvid = extractBvid(movie.url)
    if (!bvid || !movie.cid) {
      message.error(t('Could not resolve this Bilibili video.'))
      return
    }

    setQualityLoadingId(movie.id)
    try {
      const resolved = await resolveBilibiliViaCli(
        proxyUrl,
        bvid,
        movie.cid,
        qn,
        false,
        true
      )
      setViewerCliResolvedSource({ movieId: movie.id, resolved })
      if (movie.id === currentMovieId) {
        triggerViewerSourceReload()
      }
    } catch (err) {
      console.error('[MovieListPanel] viewer change quality error:', err)
      message.error(
        err instanceof Error ? err.message : t('Could not change CLI quality.')
      )
    } finally {
      setQualityLoadingId(null)
    }
  }

  /**
   * 切换分P（分集）。
   *
   * 多 P 视频每个分集有独立的 cid 和 m4s 文件，必须用对应 cid 重新请求 playurl。
   * 切换后更新 movie 的 cid/duration/videoUrl/audioUrl 等字段，并触发当前播放影片的重新 attach。
   */
  const handlePageChange = async (movie: Movie, value: string) => {
    if (!isHost || isScreenShare || !roomId) return
    const page = Number(value)
    if (!Number.isFinite(page) || page === movie.currentPage) return

    setPageLoadingId(movie.id)
    try {
      const parsePrefs = getBilibiliParseOptions(movie.id)
      const proxyUrl = parsePrefs.cliEnabled ? getActiveCliProxyUrl() : null
      if (parsePrefs.cliEnabled && !proxyUrl) {
        throw new Error('Start your local CLI resolver.')
      }
      const targetPage = movie.pages?.find((p) => p.page === page)
      let resolved: ResolvedSource
      let mediaCore: ResolvedMedia | undefined

      if (proxyUrl && targetPage) {
        // CLI 已连接：使用本地 CLI 代理解析目标分P，强制 DASH，不再降级 MP4
        const bvid = extractBvid(movie.url)
        if (bvid && targetPage.cid) {
          resolved = await resolveBilibiliViaCli(
            proxyUrl,
            bvid,
            targetPage.cid,
            movie.currentQn,
            false,
            true
          )
        } else {
          throw new Error(
            'The BV ID or content ID is missing. The CLI resolver cannot use this item.'
          )
        }
      } else {
        mediaCore = await resolveMediaInput(movie.sourceInput || movie.url, {
          roomId,
          requestedQn: movie.currentQn,
          preferMp4: getEffectivePreferMp4(movie.id),
          page,
        })
        resolved = toBilibiliResolvedSource(mediaCore)
      }
      await updateMovie(roomId, movie.id, {
        ...(mediaCore
          ? {
              url: mediaCore.descriptor.finalUrl,
              sourceInput: movie.sourceInput || movie.url,
              mediaDescriptor: stripTransientMediaDescriptor(
                mediaCore.descriptor
              ),
            }
          : {}),
        audioUrl: resolved.audioUrl,
        format: resolved.format,
        videoCodec: resolved.videoCodec,
        audioCodec: resolved.audioCodec,
        duration: resolved.duration,
        cid: resolved.cid,
        currentQn: resolved.currentQn,
        acceptQuality: resolved.acceptQuality,
        currentPage: resolved.currentPage ?? page,
      })
      if (movie.id === currentMovieId) {
        setPendingQualityChange({ movieId: movie.id, resolved })
      }
    } catch (err) {
      console.error('[MovieListPanel] change page error:', err)
      message.error(
        err instanceof Error ? err.message : t('Could not change episode.')
      )
    } finally {
      setPageLoadingId(null)
    }
  }

  // 影片列表内容（卡片和弹窗共用）
  const movieListContent = (
    <>
      {isScreenShare && (
        <div
          className="flex items-center gap-2 rounded-[var(--md-sys-shape-corner)] p-2"
          style={{
            backgroundColor:
              'color-mix(in srgb, var(--md-sys-color-secondary-container) calc(var(--glass-strength) * 100%), transparent)',
          }}
        >
          <Monitor
            className="h-4 w-4 flex-shrink-0"
            style={{ color: 'var(--md-sys-color-secondary)' }}
          />
          <Paragraph type="secondary" className="m-0 text-xs">
            {t('Video playback is paused during screen sharing.')}
          </Paragraph>
        </div>
      )}

      <Input
        size="sm"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t('Search the queue…')}
        className="px-2.5"
      />

      {/* QueueScrolling区域 — pl-2.5 平衡左右剩余宽度，
          scrollbar-gutter:stable 占右侧 10px，pl-2.5 补左侧 10px，
          使视频卡片左右距面板边缘宽度一致 */}
      <div className="movie-list-scroll min-h-[120px] min-w-0 flex-1 overflow-y-auto rounded-[var(--md-sys-shape-corner)] pl-2.5">
        {filteredMovies.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-8 text-center">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-full"
              style={{
                backgroundColor: 'var(--glass-bg)',
              }}
            >
              <Film
                className="h-5 w-5 opacity-40"
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              />
            </div>
            <Paragraph type="secondary" className="m-0 text-xs">
              {search
                ? t('No matching videos.')
                : isHost
                  ? t('Your queue is empty. Use Choose content to add a video.')
                  : t('Your queue is empty. Suggest content for everyone.')}
            </Paragraph>
          </div>
        )}
        <div className="flex flex-col gap-1.5">
          {filteredMovies.map((movie, idx) => {
            const isActive = movie.id === currentMovieId
            return (
              <div
                key={movie.id}
                className={cn(
                  'zen-item-enter rounded-[var(--md-sys-shape-corner)] border p-2.5 transition-all',
                  isActive
                    ? 'border-[var(--md-sys-color-primary)] bg-[var(--md-sys-color-primary-container)] shadow-md'
                    : 'glass border-transparent hover:-translate-y-0.5 hover:border-[var(--md-sys-color-outline-variant)] hover:shadow-md'
                )}
                style={
                  {
                    '--item-delay': `${idx * 50}ms`,
                  } as React.CSSProperties
                }
              >
                <div
                  draggable={false}
                  className={cn(
                    'grid items-center gap-2',
                    isHost
                      ? 'grid-cols-[auto_1fr_auto_auto]'
                      : 'grid-cols-[auto_1fr]'
                  )}
                >
                  <div
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                    style={{
                      background: isActive
                        ? 'var(--md-sys-color-primary)'
                        : 'color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent)',
                    }}
                  >
                    <Film
                      className="h-3 w-3"
                      style={{
                        color: isActive
                          ? 'var(--md-sys-color-on-primary)'
                          : 'var(--md-sys-color-primary)',
                      }}
                    />
                  </div>
                  <div className="min-w-0 overflow-hidden">
                    <Paragraph
                      className="m-0 truncate text-xs font-medium"
                      title={movie.title}
                    >
                      {movie.title}
                    </Paragraph>
                    <div className="mt-1 flex items-center gap-1.5">
                      <Tag
                        color="primary"
                        className="inline-flex min-w-0 max-w-full truncate"
                      >
                        {movie.sourceType === 'mp4' && movie.format
                          ? FORMAT_LABELS[movie.format] ||
                            movie.format.toUpperCase()
                          : SOURCE_LABELS[movie.sourceType] || movie.sourceType}
                      </Tag>
                      {movie.pages && movie.pages.length > 1 && (
                        <Tag
                          className="inline-flex items-center gap-1"
                          style={{
                            backgroundColor:
                              'color-mix(in srgb, var(--md-sys-color-tertiary-container) calc(var(--glass-strength) * 100%), transparent)',
                            color: 'var(--md-sys-color-on-tertiary-container)',
                          }}
                        >
                          <ListVideo className="h-2.5 w-2.5" />P
                          {movie.currentPage ?? 1}/{movie.pages.length}
                        </Tag>
                      )}
                    </div>
                    {movie.sourceType === 'bilibili' &&
                      movie.acceptQuality &&
                      movie.acceptQuality.length > 0 && (
                        <BilibiliQualitySelect
                          movie={movie}
                          isHost={isHost}
                          isScreenShare={isScreenShare}
                          qualityLoadingId={qualityLoadingId}
                          bilibiliVip={bilibiliVip}
                          selectedQn={
                            viewerCliResolvedSource?.movieId === movie.id
                              ? viewerCliResolvedSource.resolved.currentQn
                              : undefined
                          }
                          onChange={(value) =>
                            isHost
                              ? handleQualityChange(movie, value)
                              : handleViewerQualityChange(movie, value)
                          }
                        />
                      )}
                    {isHost &&
                      movie.sourceType === 'bilibili' &&
                      movie.pages &&
                      movie.pages.length > 1 && (
                        <Select
                          className="mt-1.5"
                          size="sm"
                          value={String(movie.currentPage ?? 1)}
                          options={movie.pages.map((p) => ({
                            label: `P${p.page} ${p.part}`,
                            value: String(p.page),
                          }))}
                          disabled={
                            !isHost ||
                            isScreenShare ||
                            pageLoadingId === movie.id
                          }
                          onChange={(value) => handlePageChange(movie, value)}
                        />
                      )}
                  </div>
                  {isHost && (
                    <Button
                      variant={isActive ? 'primary' : 'secondary'}
                      size="sm"
                      className="h-7 flex-shrink-0 px-2"
                      icon={<Play className="h-3.5 w-3.5" />}
                      onClick={() => handlePlay(movie.id)}
                      loading={playingId === movie.id}
                      disabled={
                        !isHost ||
                        !canPlay ||
                        !watchActive ||
                        playingId !== null
                      }
                      title={
                        !watchActive
                          ? t('Switch to Watch to play.')
                          : isHost && canPlay
                            ? t('Play')
                            : t('Playback permission required')
                      }
                    />
                  )}
                  {isHost && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 flex-shrink-0 px-2"
                      icon={<Trash2 className="h-3.5 w-3.5" />}
                      onClick={() => setDeleteTarget(movie)}
                      loading={removingId === movie.id}
                      disabled={!isHost || isScreenShare}
                      title={
                        isScreenShare
                          ? t('Switch to Watch to edit the queue.')
                          : isHost
                            ? t('Remove')
                            : t('Queue permission required')
                      }
                    />
                  )}
                </div>
                {/* Bilibili playback settings：每个 B站 影片独享一份配置；房主可操作，Members可查看并独立On CLI 代理 */}
                {movie.sourceType === 'bilibili' && !isScreenShare && (
                  <BilibiliParseSettings
                    movieId={movie.id}
                    roomId={roomId}
                    isHost={isHost}
                  />
                )}
              </div>
            )
          })}
        </div>
      </div>
    </>
  )

  return (
    <div className="glass-card zen-card flex h-full min-w-0 flex-col overflow-hidden rounded-[var(--md-sys-shape-corner)]">
      {/* 卡片头部：图标 + 标题 + 影片数量 + Fullscreen按钮 */}
      <div className="flex items-center gap-2.5 border-b border-[var(--glass-border)] px-4 py-3">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
          style={{
            backgroundColor: 'var(--md-sys-color-primary-container)',
          }}
        >
          <Film
            className="h-4 w-4"
            style={{ color: 'var(--md-sys-color-on-primary-container)' }}
          />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <Text className="text-sm font-semibold leading-tight">
            {t('Queue')}
          </Text>
          <Text
            type="secondary"
            className="text-[10px] uppercase tracking-wide"
          >
            {filteredMovies.length} {t('videos')}
          </Text>
        </div>
        <button
          type="button"
          onClick={() => setShowListModal(true)}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)] transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
          style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
          title={t('Expand queue')}
          aria-label={t('Expand queue')}
        >
          <Maximize className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 卡片内容 — 外层 px-0.5(2px) + 内层 pl-2.5(10px)/scrollbar-gutter(10px) = 12px 左右剩余 */}
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-0.5 py-3">
        {movieListContent}
      </div>

      {/* 完整Queue弹窗 */}
      <Modal
        open={showListModal}
        onClose={() => setShowListModal(false)}
        title={t('Queue ({value1} videos)', { value1: movies.length })}
        className="max-w-2xl"
      >
        <div className="flex max-h-[70vh] flex-col gap-2.5 overflow-hidden">
          {movieListContent}
        </div>
      </Modal>
      <ConfirmModal
        open={deleteTarget !== null}
        onClose={() => {
          if (!removeInFlightRef.current) setDeleteTarget(null)
        }}
        title={t('Remove video')}
        okText={t('Remove')}
        confirmLoading={removingId === deleteTarget?.id}
        onOk={() => {
          if (!deleteTarget) return
          void handleRemove(deleteTarget.id).then((removed) => {
            if (removed) setDeleteTarget(null)
          })
        }}
      >
        {t('Remove from the room queue:')} {deleteTarget?.title}?
      </ConfirmModal>
    </div>
  )
}

/**
 * B站清晰度选择器（响应式）。
 *
 * 每个影片的解析偏好（preferMp4）独立存储在 localStorage 中。
 * 使用 useBilibiliParsePreferences 订阅配置变化，确保在 BilibiliParseSettings
 * 中切换 MP4/DASH 模式时，当前影片的清晰度选择器能立即禁用/启用。
 */
interface BilibiliQualitySelectProps {
  movie: Movie
  isHost: boolean
  isScreenShare: boolean
  qualityLoadingId: number | null
  bilibiliVip: boolean
  selectedQn?: number
  onChange: (value: string) => void
}

function BilibiliQualitySelect({
  movie,
  isHost,
  isScreenShare,
  qualityLoadingId,
  bilibiliVip,
  selectedQn,
  onChange,
}: BilibiliQualitySelectProps) {
  useTranslation()

  // 订阅该影片解析偏好的变化，确保在 BilibiliParseSettings 中切换 MP4/DASH 模式后
  // 本组件能立即重新渲染，避免禁用状态停留在旧模式。
  const parsePrefs = useBilibiliParsePreferences(movie.id)

  // CLI 代理可用状态：观众端需要本地 CLI 在线才能切换清晰度。
  const cliAgentAvailable = useCliAgentStore(
    (s) => s.localOnline && s.agents.length > 0
  )

  // 使用生效的播放模式：CLI 未连接时强制 MP4，清晰度选择随之禁用
  const effectivePreferMp4 = getEffectivePreferMp4(movie.id)

  // 观众端未启用 CLI 时不显示清晰度选择器
  if (!isHost && !parsePrefs.cliEnabled) {
    return null
  }

  const canChangeQuality =
    isHost || (parsePrefs.cliEnabled && cliAgentAvailable)

  return (
    <Select
      className="mt-1.5"
      size="sm"
      value={String(
        selectedQn ?? movie.currentQn ?? movie.acceptQuality[0]?.id
      )}
      options={filterQualitiesByVip(movie.acceptQuality, bilibiliVip).map(
        (q) => ({
          label: q.resolution ? `${q.label} · ${q.resolution}` : q.label,
          value: String(q.id),
        })
      )}
      disabled={
        !canChangeQuality ||
        isScreenShare ||
        qualityLoadingId === movie.id ||
        effectivePreferMp4
      }
      onChange={onChange}
    />
  )
}
