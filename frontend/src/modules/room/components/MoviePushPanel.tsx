import { t, useTranslation } from '@/i18n'
import { BilibiliLinkPreview } from './BilibiliLinkPreview'
import { useCallback, useEffect, useRef, useState } from 'react'
import { MovieSubmissionError } from '@/lib/movieSubmission'
import {
  Link2,
  QrCode,
  LogOut,
  FileVideo,
  User,
  Plus,
  Search,
  Crown,
  FolderOpen,
  Clapperboard,
  ListVideo,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Dropdown } from '@/components/ui/Dropdown'
import { Space } from '@/components/ui/Space'
import { Text, Paragraph } from '@/components/ui/Typography'
import { Modal } from '@/components/ui/Modal'
import { Tag } from '@/components/ui/Tag'

import { message } from '@/components/ui/message'
import { useRoomStore } from '@/store/roomStore'
import { AniSubsSelector } from '@/modules/anisubs/AniSubsSelector'
import { type AniSubsEpisode } from '@/modules/anisubs'
import { KazumiSelector } from '@/modules/kazumi/KazumiSelector'
import { type KazumiEpisode } from '@/modules/kazumi'
import {
  buildBilibiliImageProxyUrl,
  getBilibiliQrCode,
  pollBilibiliQrCode,
  getBilibiliLoginStatus,
  getBilibiliUserInfo,
  logoutBilibili,
  type BilibiliUserInfo,
  type ResolvedSource,
  type FTPParams,
} from '@/modules/room/watch-together/resolveSource'
import { filterQualitiesByVip } from '@/modules/bilibili/bilibiliApi'
import {
  extractBvid,
  resolveBilibiliViaCli,
  CliConnectionError,
  CliResolveError,
} from '@/modules/bilibili/cliApi'
import { getActiveCliProxyUrl } from '@/modules/room/watch-together/movie-source-resolver'
import { isInternalOpenListServer } from '@/modules/openlist/isInternal'
import OpenListBrowser from '@/modules/openlist/OpenListBrowser'
import MountBrowser from '@/modules/mounts/MountBrowser'
import WebDAVBrowser from '@/modules/webdav/WebDAVBrowser'
import ServerFilesBrowser from '@/modules/server-files/ServerFilesBrowser'
import {
  fetchAllMounts,
  type UnionMount,
  type MountType,
} from '@/modules/mounts'
import { useAuthStore } from '@/store/authStore'
import { useSocket } from '@/hooks/useSocket'
import { useRoomExperienceStore } from '@/store/roomExperienceStore'
import { roomErrorMessage } from '../roomErrors'
import { useSystemSettingsStore } from '@/store/systemSettingsStore'
import { cn } from '@/lib/utils'
import {
  MediaResolveError,
  resolveMediaInput,
  stripTransientMediaDescriptor,
  toBilibiliResolvedSource,
  type ResolvedMedia,
} from '@/modules/media/mediaApi'
import {
  buildServerFileStorageReference,
  buildStorageReference,
} from '@/modules/media/storageReference'
import {
  buildMediaServerReference,
  type MediaServerProviderId,
} from '@/modules/media/mediaServerReference'
import {
  buildAnimeProviderReference,
  stripTransientAnimeDescriptor,
} from '@/modules/media/animeReference'

type SourceType =
  | 'bilibili'
  | 'mp4'
  | 'webdav'
  | 'ftp'
  | 'openlist'
  | 'emby'
  | 'jellyfin'
  | 'anime'
  | 'kazumi'
  | 'server-files'

const ALL_SOURCE_OPTIONS: {
  value: string
  label: string
  rootOnly?: boolean
}[] = [
  { value: 'bilibili', label: 'Bilibili' },
  { value: 'mp4', label: 'Link or webpage' },
  { value: 'webdav', label: 'WebDAV' },
  { value: 'ftp', label: 'FTP' },
  { value: 'openlist', label: 'OpenList' },
  { value: 'emby', label: 'Emby' },
  { value: 'jellyfin', label: 'Jellyfin' },
  { value: 'anime', label: 'ani-subs' },
  { value: 'kazumi', label: 'Kazumi' },
  { value: 'server-files', label: 'Server files', rootOnly: true },
]

function extractTitleFromUrl(url: string) {
  try {
    const pathname = new URL(url).pathname
    const filename = pathname.split('/').pop() || url
    return decodeURIComponent(filename)
  } catch {
    return url
  }
}

function normalizeMountPath(path: string): string {
  if (!path) return path
  return path.trim().replace(/^\/+/, '/')
}

function mediaServerMoviePayload(
  provider: MediaServerProviderId,
  mountId: number,
  itemId: string,
  resolved: ResolvedMedia
) {
  const media = resolved.descriptor
  return {
    url: media.finalUrl,
    title: media.title || extractTitleFromUrl(itemId),
    source: provider,
    sourceInput: buildMediaServerReference({ provider, mountId, itemId }),
    mediaDescriptor: stripTransientMediaDescriptor(media),
    format: media.container,
    audioUrl: media.audioUrl,
    videoCodec: media.videoCodec,
    audioCodec: media.audioCodec,
    duration: media.duration,
    // The provider candidate/profile contract owns direct-vs-gateway choice.
    // Keep the legacy field false so old playback routes cannot bypass it.
    directLink: false,
    path: itemId,
  }
}

function formatDuration(seconds: number): string {
  if (!seconds || seconds <= 0) return ''
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  }
  return `${m}:${String(s).padStart(2, '0')}`
}

function mediaResolveMessage(error: unknown): string {
  if (error instanceof MediaResolveError) {
    switch (error.code) {
      case 'DRM_UNSUPPORTED':
        return t(
          'This source is protected by DRM and cannot be shared as a video.'
        )
      case 'NO_MEDIA_FOUND':
        return t(
          'No playable video was found on the page. Check the URL or try another source.'
        )
      case 'ACCESS_DENIED':
        return t(
          'The source denied access. Check that you have permission to use it.'
        )
      case 'TARGET_BLOCKED':
        return t('This address is not allowed. Check the URL.')
      case 'BROWSER_BUSY':
        return t('The browser resolver is busy. Try again shortly.')
      case 'CANCELLED':
        return t('Resolving was cancelled. Try again.')
      case 'TIMEOUT':
        return t('Resolving timed out. Try again.')
      default:
        break
    }
  }
  return t(
    'Could not resolve this link. Check that it is accessible and try again.'
  )
}

interface MoviePushPanelProps {
  isHost: boolean
}

export function MoviePushPanel({ isHost }: MoviePushPanelProps) {
  useTranslation()

  const { socket } = useSocket()
  const canSelect =
    useRoomExperienceStore(
      (state) => state.snapshot?.permissions.selectContent
    ) ?? isHost
  const canPlay =
    useRoomExperienceStore((state) => state.snapshot?.permissions.playback) ??
    isHost
  const [addMode, setAddMode] = useState<'queue' | 'play'>('queue')
  const playNextRef = useRef(false)
  const userRole = useAuthStore((state) => state.user?.role)
  const { betaFeaturesEnabled, fetchSettings } = useSystemSettingsStore()
  const addMovieStore = useRoomStore((state) => state.addMovie)
  const fetchMovies = useRoomStore((state) => state.fetchMovies)
  const roomId = useRoomStore((state) => state.roomId)
  // TongMu 默认就是统一入口；专用来源面板仍保留给高级配置与质量切换。
  const [sourceType, setSourceType] = useState<SourceType>('mp4')
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [qualityLoading, setQualityLoading] = useState(false)
  // 影片级浏览器播放引擎（playsvideo）开关：默认关闭——强制原生直连播放
  // （不兼容编码将无声），需要 MKV/DTS 等非常规格式重封装/转码时手动开启。
  // 与系统级开关两级门控。
  const [playsvideoEnabled, setPlaysvideoEnabled] = useState(false)
  // 包装 store 的 addMovie：为本面板全部添加路径统一注入 playsvideoEnabled，
  // 调用点无需逐个传参。roomId 已在闭包内固定，保持原调用签名不变。
  // B站 源保持启用：开关本就不显示（解析出的 MP4/DASH 必定原生可播），
  // 且保留原生失败时的 playsvideo 管线回退保险；其余源跟随面板开关。
  const addMovie = useCallback(
    async (_roomId: string, payload: Parameters<typeof addMovieStore>[1]) => {
      const content = {
        ...payload,
        playsvideoEnabled:
          payload.source === 'bilibili'
            ? true
            : (payload.playsvideoEnabled ?? playsvideoEnabled),
      }
      if (canSelect) {
        const created = await addMovieStore(_roomId, content)
        if (canPlay && playNextRef.current && socket?.connected) {
          playNextRef.current = false
          setAddMode('queue')
          await new Promise<void>((resolve, reject) =>
            socket
              .timeout(8000)
              .emit(
                'play-movie',
                { roomId: _roomId, movieId: created.id },
                (
                  timeout: Error | null,
                  response: { success: boolean; message?: string }
                ) => {
                  if (timeout || !response?.success)
                    reject(
                      new Error(
                        'Added to the queue, but playback did not start. Use Play in the queue.'
                      )
                    )
                  else {
                    useRoomStore.getState().requestMoviePlay(created.id)
                    resolve()
                  }
                }
              )
          ).catch(() =>
            message.warning(
              t(
                'Added to the queue. Playback did not start; use Play in the queue.'
              )
            )
          )
        }
        return
      }
      if (!socket?.connected)
        throw new Error('Reconnect before suggesting content.')
      await new Promise<void>((resolve, reject) =>
        socket
          .timeout(10000)
          .emit(
            'room:content:suggest',
            { roomId: _roomId, content },
            (
              timeout: Error | null,
              response: { success: boolean; message?: string }
            ) => {
              if (timeout || !response?.success)
                reject(
                  new Error(
                    timeout
                      ? 'The suggestion timed out. Try again.'
                      : roomErrorMessage(response?.message)
                  )
                )
              else {
                message.success(
                  'Suggestion sent. The host can add it to the queue.'
                )
                resolve()
              }
            }
          )
      )
    },
    [addMovieStore, canSelect, canPlay, playsvideoEnabled, socket]
  )
  const [resolvedMovie, setResolvedMovie] = useState<ResolvedSource | null>(
    null
  )
  // B站 解析进度：在推送面板也展示后台解析过程
  const [resolveProgress, setResolveProgress] = useState<string>('')
  const [mediaDiagnostics, setMediaDiagnostics] =
    useState<ResolvedMedia | null>(null)
  const [mediaResolveError, setMediaResolveError] = useState('')

  // WebDAV / FTP / OpenList 表单状态
  const [webdav, setWebdav] = useState<{
    serverUrl: string
    path: string
  }>({
    serverUrl: '',
    path: '',
  })
  const [webdavDirectLink, setWebdavDirectLink] = useState(false)
  const [openlistDirectLink, setOpenlistDirectLink] = useState(false)
  const [embyDirectLink, setEmbyDirectLink] = useState(false)
  const [jellyfinDirectLink, setJellyfinDirectLink] = useState(false)
  const [ftp, setFtp] = useState<FTPParams>({
    serverUrl: '',
    path: '',
    port: 21,
    username: '',
    password: '',
  })
  const [openlist, setOpenlist] = useState<{
    serverUrl: string
    path: string
  }>({
    serverUrl: '',
    path: '',
  })
  // OpenList 内网地址检测：浏览器无法直连内网 raw_url，必须强制使用服务器转发
  const isOpenlistInternal = isInternalOpenListServer(openlist.serverUrl)
  // WebDAV 内网地址检测：浏览器无法直连内网服务器，必须强制使用服务器转发
  const isWebdavInternal = isInternalOpenListServer(webdav.serverUrl)

  // 已保存挂载
  const [mounts, setMounts] = useState<UnionMount[]>([])
  const [selectedMountId, setSelectedMountId] = useState<string>('')
  const [browsingMount, setBrowsingMount] = useState<UnionMount | null>(null)

  const [bilibiliLoggedIn, setBilibiliLoggedIn] = useState(false)
  const [bilibiliUser, setBilibiliUser] = useState<BilibiliUserInfo | null>(
    null
  )
  const [avatarError, setAvatarError] = useState(false)
  const [animeOpen, setAnimeOpen] = useState(false)
  const [kazumiOpen, setKazumiOpen] = useState(false)
  const [serverFilesBrowserOpen, setServerFilesBrowserOpen] = useState(false)
  const [serverFilePath, setServerFilePath] = useState('')
  const [qrModalOpen, setQrModalOpen] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [qrStatus, setQrStatus] = useState(0)
  const [qrMessage, setQrMessage] = useState('Scan with the Bilibili app.')
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isPollingRef = useRef(false)
  const qrRetryCountRef = useRef(0)
  // 多 P 视频分集选择弹窗
  const [showPageSelector, setShowPageSelector] = useState(false)
  const [pageSelectLoading, setPageSelectLoading] = useState(false)
  const resolveRevisionRef = useRef(0)
  const resolveAbortRef = useRef<AbortController | null>(null)
  const addInFlightRef = useRef(false)

  useEffect(
    () => () => {
      resolveRevisionRef.current += 1
      resolveAbortRef.current?.abort()
    },
    []
  )

  const invalidateResolvedInput = useCallback(() => {
    resolveRevisionRef.current += 1
    resolveAbortRef.current?.abort()
    resolveAbortRef.current = null
    setResolvedMovie(null)
    setMediaDiagnostics(null)
    setMediaResolveError('')
    setShowPageSelector(false)
    if (!addInFlightRef.current) {
      setLoading(false)
      setQualityLoading(false)
      setPageSelectLoading(false)
      setResolveProgress('')
    }
  }, [])

  const changeUrl = (value: string) => {
    if (value !== url) {
      invalidateResolvedInput()
    }
    setUrl(value)
  }

  useEffect(() => {
    void fetchSettings()
  }, [fetchSettings])

  useEffect(() => {
    if (
      !betaFeaturesEnabled &&
      (sourceType === 'anime' || sourceType === 'kazumi')
    ) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- 仅在 betaFeaturesEnabled 切换时回退一次，非每次渲染触发
      setSourceType('bilibili')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [betaFeaturesEnabled])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- sourceType 变化时重置状态
    invalidateResolvedInput()
    setOpenlist({ serverUrl: '', path: '' })
    setSelectedMountId('')
    if (sourceType !== 'bilibili') return
    getBilibiliLoginStatus().then((loggedIn) => {
      setBilibiliLoggedIn(loggedIn)
      if (loggedIn) {
        getBilibiliUserInfo().then((info) => {
          if (info) setBilibiliUser(info)
        })
      } else {
        setBilibiliUser(null)
      }
    })
  }, [sourceType, invalidateResolvedInput])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 头像变化时重置错误状态
    setAvatarError(false)
  }, [bilibiliUser?.avatar])

  const stopQrPolling = useCallback(() => {
    isPollingRef.current = false
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current)
      pollTimerRef.current = null
    }
  }, [])

  const startQrPolling = useCallback(
    (key: string) => {
      if (isPollingRef.current) return
      isPollingRef.current = true
      qrRetryCountRef.current = 0

      const poll = async () => {
        if (!isPollingRef.current) return
        try {
          const result = await pollBilibiliQrCode(key)
          qrRetryCountRef.current = 0
          setQrStatus(result.status)
          if (result.status === 0) {
            setQrMessage(t('Scan with the Bilibili app.'))
          } else if (result.status === 1) {
            setQrMessage(t('Scanned. Confirm in the app.'))
          } else if (result.status === 2) {
            setQrMessage(t('Signed in.'))
            setBilibiliLoggedIn(true)
            const info = await getBilibiliUserInfo()
            if (info) setBilibiliUser(info)
            setQrModalOpen(false)
            message.success(t('Signed in to Bilibili.'))
            stopQrPolling()
            return
          } else if (result.status === 3) {
            setQrMessage(t('This code expired. Generate a new one.'))
            stopQrPolling()
            return
          }
          pollTimerRef.current = setTimeout(poll, 2000)
        } catch (err) {
          console.error('[MoviePushPanel] QR poll error:', err)
          qrRetryCountRef.current += 1
          if (qrRetryCountRef.current <= 2) {
            setQrMessage(t('Could not check the code. Retrying…'))
            pollTimerRef.current = setTimeout(poll, 2000)
          } else {
            setQrMessage(t('Could not check the code. Generate a new one.'))
            stopQrPolling()
          }
        }
      }

      void poll()
    },
    [stopQrPolling]
  )

  const handleOpenQrModal = useCallback(async () => {
    stopQrPolling()
    setQrStatus(0)
    setQrMessage(t('Scan with the Bilibili app.'))
    setQrModalOpen(true)
    try {
      const data = await getBilibiliQrCode()
      setQrDataUrl(data.qrDataUrl)
      startQrPolling(data.qrcodeKey)
    } catch (err) {
      message.error(
        err instanceof Error ? err.message : t('Could not generate a code.')
      )
      setQrModalOpen(false)
    }
  }, [stopQrPolling, startQrPolling])

  const handleCloseQrModal = useCallback(() => {
    stopQrPolling()
    setQrModalOpen(false)
  }, [stopQrPolling])

  const handleLogoutBilibili = useCallback(async () => {
    try {
      await logoutBilibili()
      setBilibiliLoggedIn(false)
      setBilibiliUser(null)
      message.success(t('Signed out of Bilibili.'))
    } catch {
      message.error(t('Could not sign out.'))
    }
  }, [])

  const handleSelectAnimeEpisode = useCallback(
    async (sourceId: string, episode: AniSubsEpisode, title: string) => {
      if (!isHost) {
        message.info(t('You do not have permission to play videos.'))
        return
      }
      if (!roomId) {
        message.error(t('Reconnect to the room first.'))
        return
      }

      setLoading(true)
      try {
        const sourceInput = buildAnimeProviderReference(
          'anisubs',
          sourceId,
          episode
        )
        const resolved = await resolveMediaInput(sourceInput, { roomId })

        // 2. 同时异步加入影片列表（不阻塞预览播放）
        //    ani-subs 的视频地址带 token/signature，短期有效，
        //    因此存储 sourceMeta 元数据而非解析后的 URL。
        //    播放时（含刷新恢复）通过 sourceMeta 重新解析获取最新地址。
        //    url 字段存储 sourceId 作为标识，便于调试和日志追踪。
        await addMovie(roomId, {
          url: sourceInput,
          title,
          source: 'anime',
          sourceInput,
          mediaDescriptor: stripTransientAnimeDescriptor(resolved.descriptor),
          format: resolved.descriptor.container,
          audioUrl: undefined,
          videoCodec: resolved.descriptor.videoCodec,
          audioCodec: resolved.descriptor.audioCodec,
          duration: resolved.descriptor.duration,
        })
        await fetchMovies(roomId)
        message.success(
          canSelect
            ? t('Added your selection.')
            : t('Suggestion sent to the host.')
        )
      } catch (err) {
        console.error('[MoviePushPanel] select anime episode error:', err)
        message.error(
          err instanceof Error ? err.message : t('Could not load the episode.')
        )
      } finally {
        setLoading(false)
      }
    },
    [isHost, roomId, addMovie, fetchMovies, canSelect]
  )

  const handleSelectKazumiEpisode = useCallback(
    async (sourceId: string, episode: KazumiEpisode, title: string) => {
      if (!isHost) {
        message.info(t('You do not have permission to play videos.'))
        return
      }
      if (!roomId) {
        message.error(t('Reconnect to the room first.'))
        return
      }

      setLoading(true)
      try {
        const sourceInput = buildAnimeProviderReference(
          'kazumi',
          sourceId,
          episode
        )
        const resolved = await resolveMediaInput(sourceInput, { roomId })

        await addMovie(roomId, {
          url: sourceInput,
          title,
          source: 'kazumi',
          sourceInput,
          mediaDescriptor: stripTransientAnimeDescriptor(resolved.descriptor),
          format: resolved.descriptor.container,
          audioUrl: undefined,
          videoCodec: resolved.descriptor.videoCodec,
          audioCodec: resolved.descriptor.audioCodec,
          duration: resolved.descriptor.duration,
        })
        await fetchMovies(roomId)
        message.success(
          canSelect
            ? t('Added your selection.')
            : t('Suggestion sent to the host.')
        )
      } catch (err) {
        console.error('[MoviePushPanel] select kazumi episode error:', err)
        message.error(
          err instanceof Error ? err.message : t('Could not load the episode.')
        )
      } finally {
        setLoading(false)
      }
    },
    [isHost, roomId, addMovie, fetchMovies, canSelect]
  )

  useEffect(() => {
    fetchAllMounts()
      .then((data) => setMounts(data))
      .catch((err) => {
        console.error('[MoviePushPanel] fetch mounts error:', err)
      })
  }, [])

  useEffect(() => {
    return () => {
      stopQrPolling()
    }
  }, [stopQrPolling])

  const handleMountSelect = (value: string) => {
    setSelectedMountId(value)
    const id = Number(value)
    if (!id) return
    const mount = mounts.find((m) => m.id === id)
    if (!mount) return
    if (sourceType === 'webdav') {
      setWebdav({
        serverUrl: mount.serverUrl || '',
        path: normalizeMountPath('path' in mount ? mount.path || '' : ''),
      })
      // 内网挂载强制使用服务器转发（后端已保证 directLink=false，前端双重保险）
      const rawDirectLink = 'directLink' in mount ? mount.directLink : false
      setWebdavDirectLink(
        rawDirectLink && !isInternalOpenListServer(mount.serverUrl || '')
          ? true
          : false
      )
    } else if (sourceType === 'ftp') {
      setFtp((prev) => ({
        ...prev,
        serverUrl: mount.serverUrl || '',
        port: 'port' in mount && mount.port ? mount.port : 21,
        path: normalizeMountPath('path' in mount ? mount.path || '' : ''),
        username: mount.username || '',
        // 密码由后端挂载配置内部管理，列表接口不返回密码
        password: '',
      }))
    } else if (sourceType === 'openlist') {
      setOpenlist({
        serverUrl: mount.serverUrl || '',
        path: normalizeMountPath('path' in mount ? mount.path || '' : ''),
      })
      // 内网挂载强制使用服务器转发（后端已保证 directLink=false，前端双重保险）
      const rawDirectLink = 'directLink' in mount ? mount.directLink : false
      setOpenlistDirectLink(
        rawDirectLink && !isInternalOpenListServer(mount.serverUrl || '')
          ? true
          : false
      )
    } else if (sourceType === 'emby') {
      // emby 使用挂载自带的 API Key / 账号配置，无需回填表单字段
      setEmbyDirectLink('directLink' in mount ? mount.directLink : false)
    } else if (sourceType === 'jellyfin') {
      setJellyfinDirectLink('directLink' in mount ? mount.directLink : false)
    }
  }

  // 切换到挂载型来源（或挂载列表加载完成）时，自动预选该类型的第一个挂载；
  // 当前选中项不属于该类型时同样重选，避免下拉框显示空值。
  // 选「手动填写」后不强制回弹（selectedMountId 不在依赖里，仅随类型/列表变化触发）
  useEffect(() => {
    const mountTypes: SourceType[] = [
      'webdav',
      'ftp',
      'openlist',
      'emby',
      'jellyfin',
    ]
    if (!mountTypes.includes(sourceType)) return
    const current = mounts.find((m) => String(m.id) === selectedMountId)
    if (current && current.type === sourceType) return
    const first = mounts.find((m) => m.type === (sourceType as MountType))
    if (first) {
      handleMountSelect(String(first.id))
    } else if (selectedMountId) {
      setSelectedMountId('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceType, mounts])

  const handleSelectFilesFromMount = useCallback(
    async (paths: string[]) => {
      if (!isHost) {
        message.info(t('You do not have permission to add content.'))
        return
      }
      if (!roomId) {
        message.error(t('Reconnect to the room first.'))
        return
      }

      const mountId = Number(selectedMountId)
      if (!mountId) {
        message.warning(t('Choose a saved source.'))
        return
      }

      setLoading(true)
      setResolveProgress(
        t('Resolving  {value1}  files…', { value1: paths.length })
      )
      try {
        let added = 0
        for (const path of paths) {
          const normalizedPath = normalizeMountPath(path)
          if (sourceType === 'webdav' || sourceType === 'openlist') {
            const sourceInput = buildStorageReference({
              provider: sourceType,
              mountId,
              path: normalizedPath,
            })
            const resolved = await resolveMediaInput(sourceInput, { roomId })
            const media = resolved.descriptor
            const mount = mounts.find((item) => item.id === mountId)
            await addMovie(roomId, {
              url: media.finalUrl,
              title: media.title || extractTitleFromUrl(normalizedPath),
              source: sourceType,
              sourceInput,
              mediaDescriptor: stripTransientMediaDescriptor(media),
              format: media.container,
              duration: media.duration,
              serverUrl: mount?.serverUrl,
              path: normalizedPath,
              directLink: resolved.plan.candidateMode === 'DIRECT',
            })
            added++
          } else if (sourceType === 'ftp') {
            const sourceInput = buildStorageReference({
              provider: 'ftp',
              mountId,
              path: normalizedPath,
            })
            const resolved = await resolveMediaInput(sourceInput, { roomId })
            const media = resolved.descriptor
            const mount = mounts.find((item) => item.id === mountId)
            await addMovie(roomId, {
              url: media.finalUrl,
              title: media.title || extractTitleFromUrl(normalizedPath),
              source: 'ftp',
              sourceInput,
              mediaDescriptor: stripTransientMediaDescriptor(media),
              format: media.container,
              duration: media.duration,
              serverUrl: mount?.serverUrl,
              path: normalizedPath,
            })
            added++
          } else if (sourceType === 'emby') {
            const sourceInput = buildMediaServerReference({
              provider: 'emby',
              mountId,
              itemId: normalizedPath,
            })
            const resolved = await resolveMediaInput(sourceInput, { roomId })
            await addMovie(
              roomId,
              mediaServerMoviePayload('emby', mountId, normalizedPath, resolved)
            )
            added++
          } else if (sourceType === 'jellyfin') {
            const sourceInput = buildMediaServerReference({
              provider: 'jellyfin',
              mountId,
              itemId: normalizedPath,
            })
            const resolved = await resolveMediaInput(sourceInput, { roomId })
            await addMovie(
              roomId,
              mediaServerMoviePayload(
                'jellyfin',
                mountId,
                normalizedPath,
                resolved
              )
            )
            added++
          }
        }
        message.success(t('Added  {value1} videos', { value1: added }))
      } catch (err) {
        console.error('[MoviePushPanel] batch add error:', err)
        message.error(
          err instanceof Error
            ? err.message
            : t('Could not add the selected files.')
        )
      } finally {
        setLoading(false)
        setResolveProgress('')
      }
    },
    [isHost, roomId, selectedMountId, sourceType, mounts, addMovie]
  )

  // 本地服务器文件批量添加：与挂载浏览（handleSelectFilesFromMount）行为对齐，
  // 浏览选中后直接逐个 resolve + addMovie，不再回填路径输入框
  const handleSelectFilesFromServer = useCallback(
    async (paths: string[]) => {
      if (!isHost) {
        message.info(t('You do not have permission to add content.'))
        return
      }
      if (!roomId) {
        message.error(t('Reconnect to the room first.'))
        return
      }

      setLoading(true)
      setResolveProgress(
        t('Resolving  {value1}  files…', { value1: paths.length })
      )
      try {
        let added = 0
        for (const path of paths) {
          const normalizedPath = path.trim()
          const sourceInput = buildServerFileStorageReference(normalizedPath)
          const resolved = await resolveMediaInput(sourceInput, { roomId })
          const media = resolved.descriptor
          await addMovie(roomId, {
            url: media.finalUrl,
            title: media.title || extractTitleFromUrl(normalizedPath),
            source: 'server-files',
            sourceInput,
            mediaDescriptor: stripTransientMediaDescriptor(media),
            format: media.container,
            path: normalizedPath,
            duration: media.duration ?? undefined,
            audioCodec: media.audioCodec ?? undefined,
          })
          added++
        }
        message.success(t('Added  {value1} videos', { value1: added }))
      } catch (err) {
        console.error('[MoviePushPanel] batch add server files error:', err)
        message.error(
          err instanceof Error
            ? err.message
            : t('Could not add the selected files.')
        )
      } finally {
        setLoading(false)
        setResolveProgress('')
      }
    },
    [isHost, roomId, addMovie]
  )

  const resetForm = () => {
    invalidateResolvedInput()
    setUrl('')
    setSelectedMountId('')
    setWebdav({ serverUrl: '', path: '' })
    setWebdavDirectLink(false)
    setOpenlistDirectLink(false)
    setEmbyDirectLink(false)
    setJellyfinDirectLink(false)
    setFtp({ serverUrl: '', path: '', port: 21, username: '', password: '' })
    setOpenlist({ serverUrl: '', path: '' })
    setServerFilePath('')
  }

  // 链接入口先识别并预览，再确认加入；媒体库沿用现有选择流程。
  const handleResolve = async () => {
    if (!isHost) {
      message.info(t('You do not have permission to add content.'))
      return
    }
    if (!roomId) {
      message.error(t('Reconnect to the room first.'))
      return
    }
    if (sourceType !== 'bilibili' && sourceType !== 'mp4') return
    if (!url.trim()) {
      message.warning(t('Paste a video URL.'))
      return
    }
    if (/^magnet:/i.test(url.trim())) {
      setMediaResolveError(
        t('Magnet links are not supported yet. Use a video URL or webpage.')
      )
      return
    }

    if (addInFlightRef.current) return
    if (resolveAbortRef.current && !resolveAbortRef.current.signal.aborted)
      return
    const revision = ++resolveRevisionRef.current
    const controller = new AbortController()
    resolveAbortRef.current = controller
    const input = url.trim()
    setMediaResolveError('')
    setLoading(true)
    setResolveProgress(t('Preparing the source…'))
    try {
      const bvid = extractBvid(input)

      let resolved: ResolvedSource | undefined
      // CLI 已连接时优先使用本地 CLI 代理解析（使用用户自己的 B站 Cookie，可获取高画质）
      const cliProxyUrl = getActiveCliProxyUrl()
      if (cliProxyUrl && bvid) {
        try {
          setResolveProgress(t('Resolving through your CLI…'))
          resolved = await resolveBilibiliViaCli(
            cliProxyUrl,
            bvid,
            undefined,
            undefined,
            false,
            true
          )
        } catch (cliErr) {
          if (revision !== resolveRevisionRef.current) return
          // CLI 代理解析失败：连接失败或后端返回错误，自动回退到服务器端解析
          if (cliErr instanceof CliConnectionError) {
            console.warn(
              '[MoviePushPanel] CLI 代理Connection failed，回退到服务器端Resolve'
            )
          } else if (cliErr instanceof CliResolveError) {
            message.warning(
              t('{value1}. Using the server resolver.', {
                value1: t(cliErr.message),
              })
            )
          }
          // resolved 保持 undefined，下方走服务器端解析
        }
      }

      if (revision !== resolveRevisionRef.current) return
      if (!resolved) {
        setResolveProgress(t('Resolving through the server…'))
        const mediaResolved = await resolveMediaInput(input, {
          roomId,
          browserSniff: true,
          signal: controller.signal,
          requestedQn: undefined,
          preferMp4: false,
        })
        if (revision !== resolveRevisionRef.current) return
        if (mediaResolved.descriptor.resolver !== 'bilibili') {
          setResolvedMovie(null)
          if (sourceType === 'bilibili') {
            setMediaResolveError(
              t('This is not a Bilibili video. Choose Link or webpage.')
            )
            return
          }
          setMediaDiagnostics(mediaResolved)
          return
        }
        setMediaDiagnostics(mediaResolved)
        resolved = toBilibiliResolvedSource(mediaResolved)
      } else {
        // CLI path remains client-local and deliberately does not create a
        // server media handle.
        if (revision !== resolveRevisionRef.current) return
        setMediaDiagnostics(null)
      }

      if (revision !== resolveRevisionRef.current) return
      setResolvedMovie(resolved)
      // 自动检测多 P 视频：若有多 P，弹出分集选择界面
      if (resolved.pages && resolved.pages.length > 1) {
        setShowPageSelector(true)
      }
    } catch (err) {
      if (revision !== resolveRevisionRef.current) return
      const safeMessage = mediaResolveMessage(err)
      setMediaResolveError(safeMessage)
      console.error('[MoviePushPanel] resolve error:', safeMessage)
      message.error(safeMessage)
    } finally {
      if (revision === resolveRevisionRef.current) {
        resolveAbortRef.current = null
        setLoading(false)
        setResolveProgress('')
      }
    }
  }

  const handleQualityChange = async (selectedQn: string) => {
    if (!resolvedMovie || !url.trim()) return
    const qn = Number(selectedQn)
    if (!Number.isFinite(qn)) return

    const revision = ++resolveRevisionRef.current
    const input = url.trim()
    setQualityLoading(true)
    setResolveProgress(t('Changing quality…'))
    try {
      const bvid = extractBvid(input)

      let resolved: ResolvedSource | undefined
      // CLI 已连接时通过本地 CLI 代理切换清晰度（使用用户自己的 B站 Cookie）
      const cliProxyUrl = getActiveCliProxyUrl()
      if (cliProxyUrl && bvid) {
        try {
          setResolveProgress(t('Changing quality through the CLI…'))
          resolved = await resolveBilibiliViaCli(
            cliProxyUrl,
            bvid,
            resolvedMovie.cid,
            qn,
            false,
            true
          )
        } catch (cliErr) {
          if (revision !== resolveRevisionRef.current) return
          if (cliErr instanceof CliConnectionError) {
            console.warn(
              '[MoviePushPanel] CLI 代理Connection failed，回退到服务器端Resolve'
            )
          } else if (cliErr instanceof CliResolveError) {
            message.warning(
              t('{value1}. Using the server resolver.', {
                value1: t(cliErr.message),
              })
            )
          }
        }
      }

      if (revision !== resolveRevisionRef.current) return
      if (!resolved) {
        setResolveProgress(t('Changing quality through the server…'))
        const mediaResolved = await resolveMediaInput(input, {
          roomId,
          requestedQn: qn,
          preferMp4: false,
          cid: resolvedMovie.cid,
        })
        if (revision !== resolveRevisionRef.current) return
        setMediaDiagnostics(mediaResolved)
        resolved = toBilibiliResolvedSource(mediaResolved)
      } else {
        if (revision !== resolveRevisionRef.current) return
        setMediaDiagnostics(null)
      }
      if (revision !== resolveRevisionRef.current) return
      setResolvedMovie(resolved)
    } catch (err) {
      if (revision !== resolveRevisionRef.current) return
      console.error('[MoviePushPanel] switch quality error:', err)
      message.error(
        err instanceof Error ? err.message : t('Could not change quality.')
      )
    } finally {
      if (revision === resolveRevisionRef.current) {
        setQualityLoading(false)
        setResolveProgress('')
      }
    }
  }

  // 选择分 P：用目标 page 的 cid 重新解析视频流
  const handlePageSelect = async (page: number) => {
    if (!url.trim() || !resolvedMovie) return
    const targetPage = resolvedMovie.pages?.find((p) => p.page === page)
    if (!targetPage) return

    const revision = ++resolveRevisionRef.current
    const input = url.trim()
    setShowPageSelector(false)
    setPageSelectLoading(true)
    setResolveProgress(
      t('Resolving episode {value1} {value2}...', {
        value1: page,
        value2: targetPage.part,
      })
    )
    try {
      const bvid = extractBvid(input)

      let resolved: ResolvedSource | undefined
      // CLI 已连接时通过本地 CLI 代理切换分P（使用用户自己的 B站 Cookie）
      const cliProxyUrl = getActiveCliProxyUrl()
      if (cliProxyUrl && bvid) {
        try {
          setResolveProgress(
            t('Resolving through your CLI: episode {value1}...', {
              value1: page,
            })
          )
          resolved = await resolveBilibiliViaCli(
            cliProxyUrl,
            bvid,
            targetPage.cid,
            resolvedMovie.currentQn,
            false,
            true
          )
        } catch (cliErr) {
          if (revision !== resolveRevisionRef.current) return
          if (cliErr instanceof CliConnectionError) {
            console.warn(
              '[MoviePushPanel] CLI 代理Connection failed，回退到服务器端Resolve'
            )
          } else if (cliErr instanceof CliResolveError) {
            message.warning(
              t('{value1}. Using the server resolver.', {
                value1: t(cliErr.message),
              })
            )
          }
        }
      }

      if (revision !== resolveRevisionRef.current) return
      if (!resolved) {
        setResolveProgress(
          t('Resolving through the server: episode {value1}...', {
            value1: page,
          })
        )
        const mediaResolved = await resolveMediaInput(input, {
          roomId,
          requestedQn: resolvedMovie.currentQn,
          preferMp4: false,
          page,
        })
        if (revision !== resolveRevisionRef.current) return
        setMediaDiagnostics(mediaResolved)
        resolved = toBilibiliResolvedSource(mediaResolved)
      } else {
        if (revision !== resolveRevisionRef.current) return
        setMediaDiagnostics(null)
      }
      if (revision !== resolveRevisionRef.current) return
      setResolvedMovie(resolved)
    } catch (err) {
      if (revision !== resolveRevisionRef.current) return
      console.error('[MoviePushPanel] page select error:', err)
      message.error(
        err instanceof Error ? err.message : t('Could not change episode.')
      )
    } finally {
      if (revision === resolveRevisionRef.current) {
        setPageSelectLoading(false)
        setResolveProgress('')
      }
    }
  }

  // 链接只确认当前预览，不在添加时再次解析另一份结果。
  const handleAddMovie = async () => {
    if (addInFlightRef.current || qualityLoading || pageSelectLoading) return
    if (!isHost) {
      message.info(t('You do not have permission to add content.'))
      return
    }
    if (!roomId) {
      message.error(t('Reconnect to the room first.'))
      return
    }
    addInFlightRef.current = true
    const inputRevision = resolveRevisionRef.current
    setLoading(true)
    setResolveProgress(t('Adding content…'))
    try {
      if (
        (sourceType === 'bilibili' || sourceType === 'mp4') &&
        resolvedMovie
      ) {
        const title = resolvedMovie.title || url.trim()
        const serverMedia =
          mediaDiagnostics?.descriptor.resolver === 'bilibili'
            ? mediaDiagnostics
            : null
        // 存展开后的完整地址：短链（b23.tv 等）由后端解析时 302 展开，
        // 下游 BV 号提取 / 分 P 解析 / 弹幕匹配不再依赖短链可达性
        const movieUrl =
          serverMedia?.descriptor.finalUrl ||
          resolvedMovie.resolvedUrl ||
          url.trim()
        await addMovie(roomId, {
          url: movieUrl,
          title,
          source: 'bilibili',
          sourceInput: serverMedia ? url.trim() : undefined,
          mediaDescriptor: serverMedia
            ? stripTransientMediaDescriptor(serverMedia.descriptor)
            : undefined,
          audioUrl: serverMedia?.descriptor.audioUrl || resolvedMovie.audioUrl,
          format: resolvedMovie.format,
          videoCodec: resolvedMovie.videoCodec,
          audioCodec: resolvedMovie.audioCodec,
          duration: resolvedMovie.duration,
          cid: resolvedMovie.cid,
          currentQn: resolvedMovie.currentQn,
          acceptQuality: resolvedMovie.acceptQuality,
          pages: resolvedMovie.pages,
          currentPage: resolvedMovie.currentPage ?? 1,
        })
        if (inputRevision === resolveRevisionRef.current) resetForm()
        message.success(t('Added to the queue.'))
      } else if (sourceType === 'mp4') {
        if (!url.trim() || !mediaDiagnostics) {
          message.warning(t('Resolve this link first.'))
          return
        }
        const resolved = mediaDiagnostics
        if (resolved.plan.engine === 'blocked') {
          message.warning(
            t(
              'This browser cannot play the source. Try another browser or source.'
            )
          )
          return
        }
        const media = resolved.descriptor
        const movieUrl = media.finalUrl
        const title = media.title || extractTitleFromUrl(media.originalUrl)
        await addMovie(roomId, {
          url: movieUrl,
          title,
          source: media.sourceType,
          sourceInput: url.trim(),
          mediaDescriptor: stripTransientMediaDescriptor(media),
          format: media.container,
          audioUrl: media.audioUrl,
          videoCodec: media.videoCodec,
          audioCodec: media.audioCodec,
          duration: media.duration,
          playsvideoEnabled:
            resolved.plan.engine === 'playsvideo' || playsvideoEnabled,
        })
        if (inputRevision === resolveRevisionRef.current) {
          resetForm()
        }
        message.success(t('Added to the queue.'))
      } else if (sourceType === 'webdav' || sourceType === 'openlist') {
        const mountPath = (
          sourceType === 'webdav' ? webdav.path : openlist.path
        ).trim()
        const label = sourceType === 'webdav' ? 'WebDAV' : 'OpenList'

        if (!mountPath) {
          message.warning(t('Enter a file path.'))
          return
        }
        const mountId = Number(selectedMountId)
        if (!mountId) {
          message.warning(
            t('Choose your saved {value1} source', { value1: label })
          )
          return
        }
        setResolveProgress(t('Resolving  {value1}  file…', { value1: label }))
        const sourceInput = buildStorageReference({
          provider: sourceType,
          mountId,
          path: mountPath,
        })
        const resolved = await resolveMediaInput(sourceInput, { roomId })
        const media = resolved.descriptor
        const mount = mounts.find((item) => item.id === mountId)
        await addMovie(roomId, {
          url: media.finalUrl,
          title: media.title || extractTitleFromUrl(mountPath),
          source: sourceType,
          sourceInput,
          mediaDescriptor: stripTransientMediaDescriptor(media),
          format: media.container,
          duration: media.duration,
          serverUrl: mount?.serverUrl,
          path: mountPath,
          directLink: resolved.plan.candidateMode === 'DIRECT',
        })
        if (inputRevision === resolveRevisionRef.current) resetForm()
        message.success(t('Added to the queue.'))
      } else if (sourceType === 'ftp') {
        if (!ftp.serverUrl.trim() || !ftp.path.trim()) {
          message.warning(t('Enter the server URL and file path.'))
          return
        }
        setResolveProgress(t('Resolving the FTP file…'))
        const mountId = Number(selectedMountId)
        if (!mountId) {
          message.warning(t('Choose your saved FTP source'))
          return
        }
        const sourceInput = buildStorageReference({
          provider: 'ftp',
          mountId,
          path: ftp.path.trim(),
        })
        const resolved = await resolveMediaInput(sourceInput, { roomId })
        const media = resolved.descriptor
        const mount = mounts.find((item) => item.id === mountId)
        await addMovie(roomId, {
          url: media.finalUrl,
          title: media.title || extractTitleFromUrl(ftp.path.trim()),
          source: 'ftp',
          sourceInput,
          mediaDescriptor: stripTransientMediaDescriptor(media),
          format: media.container,
          duration: media.duration,
          serverUrl: mount?.serverUrl,
          path: ftp.path.trim(),
        })
        if (inputRevision === resolveRevisionRef.current) resetForm()
        message.success(t('Added to the queue.'))
      } else if (sourceType === 'emby') {
        const mountId = Number(selectedMountId)
        if (!mountId) {
          message.warning(t('Choose your saved Emby source'))
          return
        }
        // Emby 是媒体库型，需通过浏览选择条目（itemId）
        // 手动输入场景仅支持已复制的 itemId 直加
        const itemId = url.trim()
        if (!itemId) {
          message.warning(
            t('Browse Emby to select an item, or enter its item ID.')
          )
          return
        }
        setResolveProgress(t('Resolving the Emby item…'))
        const sourceInput = buildMediaServerReference({
          provider: 'emby',
          mountId,
          itemId,
        })
        const resolved = await resolveMediaInput(sourceInput, { roomId })
        await addMovie(
          roomId,
          mediaServerMoviePayload('emby', mountId, itemId, resolved)
        )
        if (inputRevision === resolveRevisionRef.current) resetForm()
        message.success(t('Added to the queue.'))
      } else if (sourceType === 'jellyfin') {
        const mountId = Number(selectedMountId)
        if (!mountId) {
          message.warning(t('Choose your saved Jellyfin source'))
          return
        }
        const itemId = url.trim()
        if (!itemId) {
          message.warning(
            t('Browse Jellyfin to select an item, or enter its item ID.')
          )
          return
        }
        setResolveProgress(t('Resolving the Jellyfin item…'))
        const sourceInput = buildMediaServerReference({
          provider: 'jellyfin',
          mountId,
          itemId,
        })
        const resolved = await resolveMediaInput(sourceInput, { roomId })
        await addMovie(
          roomId,
          mediaServerMoviePayload('jellyfin', mountId, itemId, resolved)
        )
        if (inputRevision === resolveRevisionRef.current) resetForm()
        message.success(t('Added to the queue.'))
      } else if (sourceType === 'server-files') {
        if (!serverFilePath.trim()) {
          message.warning(t('Choose a server file.'))
          return
        }
        setResolveProgress(t('Resolving Server files...'))
        const sourceInput = buildServerFileStorageReference(
          serverFilePath.trim()
        )
        const resolved = await resolveMediaInput(sourceInput, { roomId })
        const media = resolved.descriptor
        await addMovie(roomId, {
          url: media.finalUrl,
          title: media.title || extractTitleFromUrl(serverFilePath.trim()),
          source: 'server-files',
          sourceInput,
          mediaDescriptor: stripTransientMediaDescriptor(media),
          format: media.container,
          path: serverFilePath.trim(),
          duration: media.duration ?? undefined,
          audioCodec: media.audioCodec ?? undefined,
        })
        if (inputRevision === resolveRevisionRef.current) resetForm()
        message.success(t('Added to the queue.'))
      }
    } catch (err) {
      if (inputRevision !== resolveRevisionRef.current) return
      const errorMessage =
        err instanceof MovieSubmissionError
          ? err.message
          : sourceType === 'mp4'
            ? mediaResolveMessage(err)
            : err instanceof Error
              ? err.message
              : 'Could not add content.'
      console.error(
        '[MoviePushPanel] add movie error:',
        sourceType === 'mp4' ? errorMessage : err
      )
      if (sourceType === 'mp4') setMediaResolveError(errorMessage)
      message.error(errorMessage)
    } finally {
      addInFlightRef.current = false
      setLoading(false)
      setResolveProgress('')
    }
  }

  // URL 入口共用解析/确认状态；媒体库和番剧选择沿用各自操作。
  const renderActionButton = () => {
    if (sourceType === 'anime') {
      return (
        <Button
          variant="primary"
          size="md"
          block
          loading={loading}
          icon={<Search className="h-4 w-4" />}
          onClick={() => setAnimeOpen(true)}
          disabled={!isHost}
        >
          {t('Find anime')}
        </Button>
      )
    }

    if (sourceType === 'kazumi') {
      return (
        <Button
          variant="primary"
          size="md"
          block
          loading={loading}
          icon={<Search className="h-4 w-4" />}
          onClick={() => setKazumiOpen(true)}
          disabled={!isHost}
        >
          {t('Find anime')}
        </Button>
      )
    }

    if (sourceType === 'bilibili' || sourceType === 'mp4') {
      if (resolvedMovie || mediaDiagnostics) {
        return (
          <Button
            variant="primary"
            size="md"
            block
            loading={loading}
            icon={<Plus className="h-4 w-4" />}
            onClick={handleAddMovie}
            disabled={
              !isHost ||
              qualityLoading ||
              pageSelectLoading ||
              mediaDiagnostics?.plan.engine === 'blocked'
            }
          >
            {t('Add')}
          </Button>
        )
      }
      return (
        <Button
          variant="primary"
          size="md"
          block
          loading={loading}
          icon={<Link2 className="h-4 w-4" />}
          onClick={() => void handleResolve()}
          disabled={!isHost}
        >
          {t('Resolve')}
        </Button>
      )
    }

    // 已配置媒体库：单步添加。
    return (
      <Button
        variant="primary"
        size="md"
        block
        loading={loading}
        icon={<Plus className="h-4 w-4" />}
        onClick={() => void handleAddMovie()}
        disabled={!isHost}
      >
        {t('Add')}
      </Button>
    )
  }

  const renderSourceForm = () => {
    const getMountOptions = (type: MountType) => [
      { value: '', label: t('Enter manually') },
      ...mounts
        .filter((m) => m.type === type)
        .map((m) => ({ value: String(m.id), label: m.name })),
    ]

    if (sourceType === 'bilibili' || sourceType === 'mp4') {
      return (
        <Input
          size="sm"
          value={url}
          onChange={(e) => changeUrl(e.target.value)}
          placeholder={
            sourceType === 'bilibili'
              ? t('Bilibili URL or BV ID')
              : t('Paste a video, playlist or webpage URL')
          }
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void (resolvedMovie || mediaDiagnostics
                ? handleAddMovie()
                : handleResolve())
            }
          }}
        />
      )
    }

    if (sourceType === 'webdav') {
      return (
        <Space direction="vertical" className="w-full" size="sm">
          <Dropdown
            label={t('Your WebDAV sources')}
            value={selectedMountId}
            options={getMountOptions('webdav')}
            onChange={handleMountSelect}
          />
          {selectedMountId && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const mount = mounts.find(
                  (m) => m.id === Number(selectedMountId)
                )
                if (mount) setBrowsingMount(mount)
              }}
            >
              {t('Browse files')}
            </Button>
          )}
          {!selectedMountId && (
            <Input
              size="sm"
              value={webdav.serverUrl}
              onChange={(e) =>
                setWebdav((prev) => ({ ...prev, serverUrl: e.target.value }))
              }
              placeholder={t(
                'WebDAV server URL, such as https://example.com/dav'
              )}
            />
          )}
          <Input
            size="sm"
            value={webdav.path}
            onChange={(e) =>
              setWebdav((prev) => ({
                ...prev,
                path: normalizeMountPath(e.target.value),
              }))
            }
            placeholder={
              selectedMountId
                ? t('File path (or browse your source)')
                : 'File path, such as /movies/video.mp4'
            }
          />
          <Dropdown
            value={
              isWebdavInternal ? 'proxy' : webdavDirectLink ? 'direct' : 'proxy'
            }
            options={[
              { value: 'proxy', label: t('Server relay') },
              {
                value: 'direct',
                label: t('Direct connection'),
                disabled: isWebdavInternal,
              },
            ]}
            onChange={(value) => setWebdavDirectLink(value === 'direct')}
          />
          {isWebdavInternal && (
            <div className="rounded border border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface-container-high)] px-3 py-2 text-xs text-[var(--md-sys-color-on-surface-variant)]">
              {t('This source uses a private address. Using server relay.')}
            </div>
          )}
        </Space>
      )
    }

    if (sourceType === 'ftp') {
      return (
        <Space direction="vertical" className="w-full" size="sm">
          <Dropdown
            label={t('Your FTP sources')}
            value={selectedMountId}
            options={getMountOptions('ftp')}
            onChange={handleMountSelect}
          />
          {selectedMountId && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const mount = mounts.find(
                  (m) => m.id === Number(selectedMountId)
                )
                if (mount) setBrowsingMount(mount)
              }}
            >
              {t('Browse files')}
            </Button>
          )}
          {!selectedMountId && (
            <>
              <Input
                size="sm"
                value={ftp.serverUrl}
                onChange={(e) =>
                  setFtp((prev) => ({ ...prev, serverUrl: e.target.value }))
                }
                placeholder={t('FTP server, such as ftp.example.com')}
              />
              <Input
                size="sm"
                type="number"
                value={String(ftp.port)}
                onChange={(e) =>
                  setFtp((prev) => ({
                    ...prev,
                    port: Number(e.target.value) || 21,
                  }))
                }
                placeholder={t('Port (default: 21)')}
              />
              <Input
                size="sm"
                value={ftp.username}
                onChange={(e) =>
                  setFtp((prev) => ({ ...prev, username: e.target.value }))
                }
                placeholder={t('Username (optional)')}
              />
              <Input
                size="sm"
                type="password"
                value={ftp.password}
                onChange={(e) =>
                  setFtp((prev) => ({ ...prev, password: e.target.value }))
                }
                placeholder={t('Password (optional)')}
              />
            </>
          )}
          <Input
            size="sm"
            value={ftp.path}
            onChange={(e) =>
              setFtp((prev) => ({
                ...prev,
                path: normalizeMountPath(e.target.value),
              }))
            }
            placeholder={
              selectedMountId
                ? t('File path (or browse your source)')
                : 'File path, such as /movies/video.mp4'
            }
          />
        </Space>
      )
    }

    if (sourceType === 'anime') {
      return (
        <div className="rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] bg-[var(--glass-bg)] p-3">
          <Text className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
            {t('Find an episode from your ani-subs subscriptions.')}
          </Text>
        </div>
      )
    }

    if (sourceType === 'kazumi') {
      return (
        <div className="rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] bg-[var(--glass-bg)] p-3">
          <Text className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
            {t('Find an episode using your Kazumi sources.')}
          </Text>
        </div>
      )
    }

    if (sourceType === 'openlist') {
      return (
        <Space direction="vertical" className="w-full" size="sm">
          <Dropdown
            label={t('Your OpenList sources')}
            value={selectedMountId}
            options={getMountOptions('openlist')}
            onChange={handleMountSelect}
          />
          {selectedMountId && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                const mount = mounts.find(
                  (m) => m.id === Number(selectedMountId)
                )
                if (mount) setBrowsingMount(mount)
              }}
            >
              {t('Browse files')}
            </Button>
          )}
          {!selectedMountId && (
            <Input
              size="sm"
              value={openlist.serverUrl}
              onChange={(e) =>
                setOpenlist((prev) => ({ ...prev, serverUrl: e.target.value }))
              }
              placeholder={t('OpenList server URL')}
            />
          )}
          <Input
            size="sm"
            value={openlist.path}
            onChange={(e) =>
              setOpenlist((prev) => ({
                ...prev,
                path: normalizeMountPath(e.target.value),
              }))
            }
            placeholder={
              selectedMountId
                ? t('File path (or browse your source)')
                : 'File path, such as /movies/video.mp4'
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleAddMovie()
              }
            }}
          />
          <Dropdown
            value={
              isOpenlistInternal
                ? 'proxy'
                : openlistDirectLink
                  ? 'direct'
                  : 'proxy'
            }
            options={[
              { value: 'proxy', label: t('Server relay') },
              {
                value: 'direct',
                label: t('Direct connection'),
                disabled: isOpenlistInternal,
              },
            ]}
            onChange={(value) => setOpenlistDirectLink(value === 'direct')}
          />
          {isOpenlistInternal && (
            <div className="rounded border border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface-container-high)] px-3 py-2 text-xs text-[var(--md-sys-color-on-surface-variant)]">
              {t('This source uses a private address. Using server relay.')}
            </div>
          )}
        </Space>
      )
    }

    if (sourceType === 'emby') {
      return (
        <Space direction="vertical" className="w-full" size="sm">
          <Dropdown
            label={t('Your Emby sources')}
            value={selectedMountId}
            options={getMountOptions('emby')}
            onChange={handleMountSelect}
          />
          {selectedMountId && (
            <Button
              variant="secondary"
              size="sm"
              icon={<Clapperboard className="h-4 w-4" />}
              onClick={() => {
                const mount = mounts.find(
                  (m) => m.id === Number(selectedMountId)
                )
                if (mount) setBrowsingMount(mount)
              }}
            >
              {t('Browse Emby')}
            </Button>
          )}
          {!selectedMountId && (
            <Input
              size="sm"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t('Emby item ID (or browse the library)')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void handleAddMovie()
                }
              }}
            />
          )}
          <Dropdown
            label={t('Connection')}
            value={embyDirectLink ? 'direct' : 'proxy'}
            options={[
              { value: 'proxy', label: t('Server relay') },
              { value: 'direct', label: t('Direct connection') },
            ]}
            onChange={(value) => setEmbyDirectLink(value === 'direct')}
          />
          <Text className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
            {selectedMountId
              ? t(
                  'Browse your Emby movies and series. Select multiple items to add them to the queue.'
                )
              : t(
                  'Choose a source, then browse Emby movies and series. Direct connection plays from Emby; server relay is available when needed.'
                )}
          </Text>
        </Space>
      )
    }

    if (sourceType === 'jellyfin') {
      return (
        <Space direction="vertical" className="w-full" size="sm">
          <Dropdown
            label={t('Your Jellyfin sources')}
            value={selectedMountId}
            options={getMountOptions('jellyfin')}
            onChange={handleMountSelect}
          />
          {selectedMountId && (
            <Button
              variant="secondary"
              size="sm"
              icon={<Clapperboard className="h-4 w-4" />}
              onClick={() => {
                const mount = mounts.find(
                  (m) => m.id === Number(selectedMountId)
                )
                if (mount) setBrowsingMount(mount)
              }}
            >
              {t('Browse Jellyfin')}
            </Button>
          )}
          {!selectedMountId && (
            <Input
              size="sm"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t('Jellyfin item ID (or browse the library)')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void handleAddMovie()
                }
              }}
            />
          )}
          <Dropdown
            label={t('Connection')}
            value={jellyfinDirectLink ? 'direct' : 'proxy'}
            options={[
              { value: 'proxy', label: t('Server relay') },
              { value: 'direct', label: t('Direct connection') },
            ]}
            onChange={(value) => setJellyfinDirectLink(value === 'direct')}
          />
          <Text className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
            {selectedMountId
              ? t(
                  'Browse your Jellyfin movies and series. Select multiple items to add them to the queue.'
                )
              : t(
                  'Choose a source, then browse Jellyfin movies and series. Direct connection plays from Jellyfin; server relay is available when needed.'
                )}
          </Text>
        </Space>
      )
    }

    if (sourceType === 'server-files') {
      return (
        <Space direction="vertical" className="w-full" size="sm">
          <Button
            variant="secondary"
            size="sm"
            icon={<FolderOpen className="h-4 w-4" />}
            onClick={() => setServerFilesBrowserOpen(true)}
          >
            {t('Browse server files')}
          </Button>
          <Input
            size="sm"
            value={serverFilePath}
            onChange={(e) => setServerFilePath(e.target.value)}
            placeholder={t('File path, or browse and select files')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void handleAddMovie()
              }
            }}
          />
        </Space>
      )
    }

    return null
  }

  return (
    <>
      <div className="glass-card zen-card flex h-full min-w-0 flex-col overflow-hidden rounded-[var(--md-sys-shape-corner)]">
        {/* 卡片头部：图标 + 标题 */}
        <div className="flex items-center gap-2.5 border-b border-[var(--glass-border)] px-4 py-3">
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
            style={{
              backgroundColor: 'var(--md-sys-color-secondary-container)',
            }}
          >
            <Plus
              className="h-4 w-4"
              style={{ color: 'var(--md-sys-color-on-secondary-container)' }}
            />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
            <Text className="text-sm font-semibold leading-tight">
              {t('Add content')}
            </Text>
            <Text
              type="secondary"
              className="text-[10px] uppercase tracking-wide"
            >
              {t('Select only the content you want to share.')}
            </Text>
          </div>
        </div>

        {/* 卡片内容 */}
        <div className="zen-scroll flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-4 py-3">
          <div
            className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5"
            role="group"
            aria-label={t('Content sources')}
          >
            {ALL_SOURCE_OPTIONS.filter(
              (opt) =>
                (!opt.rootOnly || userRole === 'root') &&
                (betaFeaturesEnabled ||
                  (opt.value !== 'anime' && opt.value !== 'kazumi'))
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={sourceType === option.value}
                onClick={() => {
                  invalidateResolvedInput()
                  setSourceType(option.value as SourceType)
                }}
                className={cn(
                  'rounded-xl border px-3 py-3 text-left text-xs font-medium transition-colors',
                  sourceType === option.value
                    ? 'border-[var(--md-sys-color-primary)] bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                    : 'border-[var(--glass-border)] hover:bg-[var(--md-sys-color-surface-container-high)]'
                )}
              >
                {t(option.label)}
              </button>
            ))}
          </div>

          {(
            ['webdav', 'ftp', 'openlist', 'emby', 'jellyfin'] as const
          ).includes(sourceType as MountType) &&
            !mounts.some((mount) => mount.type === sourceType) && (
              <div className="rounded-xl border border-[var(--md-sys-color-outline-variant)] px-3 py-2 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                {t('You have no saved sources of this type.')}{' '}
                {['webdav', 'ftp', 'openlist'].includes(sourceType) &&
                  t('Enter the connection below, or ')}
                <a
                  className="text-[var(--md-sys-color-primary)] underline"
                  href="/profile"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('Connect a source in your account')}
                </a>
                . {t('Only the selected items are shared with the room.')}
              </div>
            )}

          {renderSourceForm()}

          {canSelect && canPlay && (
            <fieldset className="tm-content-disposition">
              <legend>{t('After selecting content')}</legend>
              <label>
                <input
                  type="radio"
                  name="content-disposition"
                  checked={addMode === 'queue'}
                  onChange={() => {
                    setAddMode('queue')
                    playNextRef.current = false
                  }}
                />
                {t('Keep in the queue')}
              </label>
              <label>
                <input
                  type="radio"
                  name="content-disposition"
                  checked={addMode === 'play'}
                  onChange={() => {
                    setAddMode('play')
                    playNextRef.current = true
                  }}
                />
                {t('Play the first selection now')}
              </label>
            </fieldset>
          )}

          {renderActionButton()}

          {/* Optional browser compatibility engine开关：仅挂载/文件类源显示。B站 源Resolve出的
              MP4/DASH Browse器必定原生可播，无转码需求，隐藏开关避免困惑。 */}
          {sourceType !== 'bilibili' && (
            <div className="flex items-center justify-between gap-3 px-3 py-2 rounded-[var(--md-sys-shape-corner)] bg-[var(--md-sys-color-surface-container-high)]">
              <div className="min-w-0">
                <Text className="block text-xs font-medium">
                  {t('Optional browser compatibility engine')}
                </Text>
                <Text
                  type="secondary"
                  className="block text-[11px] leading-snug mt-0.5"
                >
                  {t(
                    'Enable for formats such as MKV/DTS. This may remux media or convert unsupported audio in this browser. Original video quality stays unchanged. Off by default.'
                  )}
                </Text>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={playsvideoEnabled}
                disabled={!isHost}
                onClick={() => setPlaysvideoEnabled((prev) => !prev)}
                className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                style={{
                  backgroundColor: playsvideoEnabled
                    ? 'var(--md-sys-color-primary)'
                    : 'var(--md-sys-color-outline)',
                }}
              >
                <span
                  className="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform"
                  style={{
                    transform: playsvideoEnabled
                      ? 'translateX(18px)'
                      : 'translateX(2px)',
                  }}
                />
              </button>
            </div>
          )}

          {resolveProgress && (
            <div
              className="flex items-center gap-2 rounded-[var(--md-sys-shape-corner)] px-3 py-2 text-xs"
              style={{
                backgroundColor: 'var(--md-sys-color-primary-container)',
                color: 'var(--md-sys-color-on-primary-container)',
              }}
            >
              <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              <Text className="text-xs">{t(resolveProgress)}</Text>
              {!addInFlightRef.current && resolveAbortRef.current && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={invalidateResolvedInput}
                >
                  {t('Cancel resolving')}
                </Button>
              )}
            </div>
          )}

          {sourceType === 'mp4' && mediaDiagnostics && !resolvedMovie && (
            <div className="rounded-[var(--md-sys-shape-corner)] bg-[var(--md-sys-color-surface-container-high)] px-3 py-2 text-[11px] leading-relaxed">
              <Text className="block text-xs font-medium">
                {mediaDiagnostics.descriptor.title || extractTitleFromUrl(url)}{' '}
                {t('· Detected')}{' '}
                {mediaDiagnostics.descriptor.container.toUpperCase()} ·{' '}
                {mediaDiagnostics.plan.engine === 'blocked'
                  ? t('This browser cannot play this media.')
                  : t('Ready for this browser')}
              </Text>
              <details>
                <summary className="cursor-pointer">
                  {t('Technical details')}
                </summary>
                <Text type="secondary" className="block">
                  {t('Private media addresses are hidden.')}
                </Text>
                <Text type="secondary" className="block break-all">
                  {t('Resolver:')} {mediaDiagnostics.descriptor.resolver}{' '}
                  {t('· Source:')} {mediaDiagnostics.descriptor.sourceType}{' '}
                  {t('· Detected:')}{' '}
                  {mediaDiagnostics.descriptor.container.toUpperCase()}
                </Text>
                <Text type="secondary" className="block">
                  {t('Range:')}{' '}
                  {mediaDiagnostics.descriptor.rangeSupported
                    ? t('Supported')
                    : t('Not supported')}{' '}
                  {t('· Engine:')} {mediaDiagnostics.plan.engine} {t('· Mode:')}{' '}
                  {mediaDiagnostics.plan.mode} {t('· Proxy:')}{' '}
                  {mediaDiagnostics.plan.proxy
                    ? t('signed handle')
                    : t('Not used')}
                </Text>
                <Text type="secondary" className="block">
                  {t('Resolution:')}{' '}
                  {mediaDiagnostics.descriptor.width &&
                  mediaDiagnostics.descriptor.height
                    ? `${mediaDiagnostics.descriptor.width}×${mediaDiagnostics.descriptor.height}`
                    : t('unknown')}{' '}
                  {t('· Duration:')}{' '}
                  {mediaDiagnostics.descriptor.duration
                    ? `${Math.round(mediaDiagnostics.descriptor.duration)}s`
                    : t('unknown')}
                </Text>
              </details>
            </div>
          )}

          {(sourceType === 'mp4' || sourceType === 'bilibili') &&
            mediaResolveError && (
              <div className="rounded-[var(--md-sys-shape-corner)] bg-[var(--md-sys-color-error-container)] px-3 py-2 text-[11px] leading-relaxed text-[var(--md-sys-color-on-error-container)]">
                <Text className="block text-xs font-medium">
                  {t('Could not resolve this source')}
                </Text>
                <Text className="block break-all">{t(mediaResolveError)}</Text>
              </div>
            )}

          {(sourceType === 'bilibili' || sourceType === 'mp4') &&
            resolvedMovie && <BilibiliLinkPreview movie={resolvedMovie} />}

          {(sourceType === 'bilibili' || sourceType === 'mp4') &&
            resolvedMovie?.acceptQuality &&
            resolvedMovie.acceptQuality.length > 0 && (
              <>
                <Dropdown
                  value={String(
                    resolvedMovie.currentQn ??
                      resolvedMovie.acceptQuality[0]?.id
                  )}
                  options={filterQualitiesByVip(
                    resolvedMovie.acceptQuality,
                    bilibiliUser?.vipStatus === 1 ||
                      resolvedMovie.vipStatus === 1
                  ).map((q) => ({
                    label: q.resolution
                      ? `${q.label} · ${q.resolution}`
                      : q.label,
                    value: String(q.id),
                  }))}
                  onChange={(value) => void handleQualityChange(value)}
                  disabled={qualityLoading || !isHost}
                />
              </>
            )}

          {(sourceType === 'bilibili' || sourceType === 'mp4') &&
            resolvedMovie?.pages &&
            resolvedMovie.pages.length > 1 && (
              <Button
                variant="secondary"
                size="sm"
                block
                icon={<ListVideo className="h-4 w-4" />}
                onClick={() => setShowPageSelector(true)}
                disabled={pageSelectLoading || !isHost}
              >
                {resolvedMovie.currentPage
                  ? t('P{value1} {value2} · Change', {
                      value1: resolvedMovie.currentPage,
                      value2:
                        resolvedMovie.pages.find(
                          (p) => p.page === resolvedMovie.currentPage
                        )?.part ?? '',
                    })
                  : t('Total: {value1} P · Choose', {
                      value1: resolvedMovie.pages.length,
                    })}
              </Button>
            )}

          {sourceType === 'bilibili' && (
            <div
              className="rounded-[var(--md-sys-shape-corner)] p-2.5"
              style={{
                backgroundColor: 'var(--glass-bg)',
              }}
            >
              <div className="flex items-center gap-2">
                <FileVideo
                  className="h-3.5 w-3.5"
                  style={{ color: 'var(--md-sys-color-primary)' }}
                />
                <Text
                  type="secondary"
                  className="text-[10px] uppercase tracking-wide"
                >
                  {t('Bilibili account')}
                </Text>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-[var(--md-sys-shape-corner)] p-1">
                {bilibiliLoggedIn && bilibiliUser ? (
                  <>
                    {avatarError || !bilibiliUser.avatar ? (
                      <div
                        className="flex h-6 w-6 items-center justify-center rounded-full"
                        style={{
                          backgroundColor: 'var(--glass-bg)',
                          border:
                            '1px solid var(--md-sys-color-outline-variant)',
                        }}
                      >
                        <User className="h-3.5 w-3.5" />
                      </div>
                    ) : (
                      <img
                        src={buildBilibiliImageProxyUrl(bilibiliUser.avatar)}
                        alt={bilibiliUser.name}
                        className="h-6 w-6 rounded-full object-cover"
                        onError={() => setAvatarError(true)}
                      />
                    )}
                    <Text className="text-xs">{bilibiliUser.name}</Text>
                    {bilibiliUser.vipStatus === 1 ? (
                      <Tag
                        color="warning"
                        className="shrink-0 px-1.5 py-0 text-[10px]"
                      >
                        <Crown className="mr-0.5 h-3 w-3" />
                        {t('Premium')}
                      </Tag>
                    ) : (
                      <Tag
                        color="default"
                        className="shrink-0 px-1.5 py-0 text-[10px]"
                      >
                        {t('Standard account')}
                      </Tag>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      icon={<LogOut className="h-3 w-3" />}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleLogoutBilibili()
                      }}
                    >
                      {t('Disconnect')}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    icon={<QrCode className="h-3 w-3" />}
                    onClick={(e) => {
                      e.stopPropagation()
                      handleOpenQrModal()
                    }}
                  >
                    {t('Connect with QR code')}
                  </Button>
                )}
              </div>
              <Paragraph type="secondary" className="m-0 mt-1.5 text-[11px]">
                {bilibiliLoggedIn
                  ? bilibiliUser?.vipStatus === 1
                    ? t(
                        'Premium quality, including eligible 4K and high-bitrate video, is available.'
                      )
                    : t('Connected. Eligible higher quality is available.')
                  : t(
                      'Connect Bilibili for the quality available to your account.'
                    )}
              </Paragraph>
            </div>
          )}
        </div>
      </div>

      {sourceType === 'anime' && (
        <AniSubsSelector
          open={animeOpen}
          onOpenChange={setAnimeOpen}
          onSelectEpisode={handleSelectAnimeEpisode}
          disabled={!isHost}
        />
      )}

      {sourceType === 'kazumi' && (
        <KazumiSelector
          open={kazumiOpen}
          onOpenChange={setKazumiOpen}
          onSelectEpisode={handleSelectKazumiEpisode}
          disabled={!isHost}
        />
      )}

      <Modal
        open={qrModalOpen}
        onClose={handleCloseQrModal}
        title={t('Connect Bilibili')}
        footer={
          <Button variant="secondary" size="sm" onClick={handleCloseQrModal}>
            {t('Close')}
          </Button>
        }
      >
        <div className="flex flex-col items-center gap-4">
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt={t('Bilibili sign-in code')}
              className="rounded-lg border"
              style={{
                width: 200,
                height: 200,
                borderColor: 'var(--md-sys-color-outline-variant)',
              }}
            />
          ) : (
            <div
              className="glass flex items-center justify-center rounded-lg"
              style={{
                width: 200,
                height: 200,
              }}
            >
              <Text>{t('Generating a code…')}</Text>
            </div>
          )}
          <Paragraph
            type={
              qrStatus === 2
                ? 'success'
                : qrStatus === 3
                  ? 'danger'
                  : 'secondary'
            }
            className="m-0 text-sm"
          >
            {t(qrMessage)}
          </Paragraph>
          {qrStatus === 3 && (
            <Button variant="primary" size="sm" onClick={handleOpenQrModal}>
              {t('Generate a new code')}
            </Button>
          )}
        </div>
      </Modal>

      {browsingMount?.type === 'webdav' ? (
        <WebDAVBrowser
          mountId={browsingMount.id}
          open={!!browsingMount}
          onClose={() => setBrowsingMount(null)}
          onSelectFiles={handleSelectFilesFromMount}
          selectable
        />
      ) : browsingMount?.type === 'openlist' ? (
        <OpenListBrowser
          mountId={browsingMount.id}
          open={!!browsingMount}
          onClose={() => setBrowsingMount(null)}
          onSelectFiles={handleSelectFilesFromMount}
          selectable
        />
      ) : (
        <MountBrowser
          mount={browsingMount}
          open={!!browsingMount}
          onClose={() => setBrowsingMount(null)}
          onSelectFiles={handleSelectFilesFromMount}
          selectable
        />
      )}

      <ServerFilesBrowser
        open={serverFilesBrowserOpen}
        onClose={() => setServerFilesBrowserOpen(false)}
        onConfirm={handleSelectFilesFromServer}
      />

      {(sourceType === 'bilibili' || sourceType === 'mp4') &&
        resolvedMovie?.pages && (
          <Modal
            open={showPageSelector}
            onClose={() => setShowPageSelector(false)}
            title={
              <div className="flex items-center gap-2.5">
                <div
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                  style={{
                    backgroundColor: 'var(--md-sys-color-primary-container)',
                  }}
                >
                  <ListVideo
                    className="h-4 w-4"
                    style={{
                      color: 'var(--md-sys-color-on-primary-container)',
                    }}
                  />
                </div>
                <div className="flex min-w-0 flex-1 flex-col">
                  <Text className="text-sm font-semibold leading-tight">
                    {t('Choose an episode')}
                  </Text>
                  <Text
                    type="secondary"
                    className="text-[10px] uppercase tracking-wide"
                  >
                    {resolvedMovie.pages.length}{' '}
                    {t('episodes · Choose what to add')}
                  </Text>
                </div>
              </div>
            }
            footer={
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowPageSelector(false)}
              >
                {t('Cancel (keep the current episode)')}
              </Button>
            }
          >
            <div className="flex max-h-[400px] flex-col gap-1.5 overflow-y-auto">
              {resolvedMovie.pages.map((page) => {
                const isSelected =
                  page.page === (resolvedMovie.currentPage ?? 1)
                return (
                  <button
                    key={page.page}
                    type="button"
                    aria-pressed={isSelected}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-[var(--md-sys-shape-corner)] border p-3 transition-all hover:-translate-y-0.5 hover:shadow-md',
                      isSelected
                        ? 'border-[var(--md-sys-color-primary)] bg-[var(--md-sys-color-primary-container)]'
                        : 'glass border-transparent hover:border-[var(--md-sys-color-outline-variant)]'
                    )}
                    onClick={() => void handlePageSelect(page.page)}
                  >
                    <div
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)] text-xs font-medium"
                      style={{
                        backgroundColor: isSelected
                          ? 'var(--md-sys-color-primary)'
                          : 'color-mix(in srgb, var(--md-sys-color-primary) 12%, transparent)',
                        color: isSelected
                          ? 'var(--md-sys-color-on-primary)'
                          : 'var(--md-sys-color-primary)',
                      }}
                    >
                      {page.page}
                    </div>
                    <div className="min-w-0 flex-1">
                      <Paragraph
                        className={cn(
                          'm-0 truncate text-sm font-medium',
                          isSelected &&
                            'text-[var(--md-sys-color-on-primary-container)]'
                        )}
                        title={page.part}
                      >
                        {page.part}
                      </Paragraph>
                      {page.duration > 0 && (
                        <Text
                          type="secondary"
                          className={cn(
                            'text-[10px] uppercase tracking-wide',
                            isSelected &&
                              'text-[var(--md-sys-color-on-primary-container)]'
                          )}
                        >
                          {formatDuration(page.duration)}
                        </Text>
                      )}
                    </div>
                  </button>
                )
              })}
            </div>
          </Modal>
        )}
    </>
  )
}
