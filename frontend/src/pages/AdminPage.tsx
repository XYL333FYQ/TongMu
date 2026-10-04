import { getLocale, t, useTranslation } from '@/i18n'
import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Users,
  Shield,
  Trash2,
  Power,
  RefreshCw,
  Lock,
  LayoutDashboard,
  LayoutGrid,
  List,
  Settings,
  Download,
  UserCheck,
  Upload,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Space } from '@/components/ui/Space'
import { Title, Text, Paragraph } from '@/components/ui/Typography'
import { Tag } from '@/components/ui/Tag'
import { Spinner } from '@/components/ui/Spinner'
import { ConfirmModal } from '@/components/ui/Modal'
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/Switch'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { AniSubsGithubBrowser } from '@/modules/admin/components/AniSubsGithubBrowser'
import { canCloseAdminRoom } from '@/modules/admin/adminPermissions'
import { message } from '@/components/ui/message'
import { englishErrorMessage } from '@/lib/errorMessage'
import { useHideBodyScrollbar } from '@/hooks/useHideBodyScrollbar'
import { formatRecentTime } from '@/lib/formatTime'
import { useAuthStore } from '@/store/authStore'
import { useSystemSettingsStore } from '@/store/systemSettingsStore'
import { apiFetch, getApiUrl } from '@/lib/api'

interface AdminUser {
  id: number
  username: string
  role: 'root' | 'admin' | 'user' | 'guest'
  status: 'active' | 'pending'
  createdAt: string
}

interface AdminRoom {
  id: number
  roomId: string
  name: string | null
  status: 'active' | 'closed'
  requireApproval: boolean
  maxViewers: number
  hasPassword: boolean
  viewerCount: number
  sharerOnline: boolean
  createdAt: string
  lastAccessedAt: string
  ownerUserId: number | null
}

interface UpdateInfo {
  currentVersion: string
  remoteVersion: string
  hasUpdate: boolean
  releaseNotes: string
  releaseUrl: string
  publishedAt: string
  downloadUrl: string
  isPrerelease: boolean
  assetName: string
  assetSize: number
}

/** 更新进度状态：由 SSE 流式接口推送 */
interface UpdateProgress {
  /** Current阶段 */
  stage: 'downloading' | 'extracting' | 'starting' | 'done' | 'error'
  /** Download已接收字节数（仅 downloading 阶段） */
  received: number
  /** Download总字节数（仅 downloading 阶段，可能为 0） */
  total: number
  /** 完成或错误消息 */
  message: string
}

/** SSE 事件结构，与后端 UpdateStageEvent 对齐 */
interface UpdateStageEventPayload {
  stage: 'downloading' | 'extracting' | 'starting' | 'done' | 'error'
  received?: number
  total?: number
  message?: string
}

/** 将字节数格式化为人类可读的文件大小 */
function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

type RegistrationMode = 'open' | 'approval' | 'closed'
type RoomCreationMode = 'admin-only' | 'all-users'

interface AdminSettings {
  autoDeleteInactiveRooms: boolean
  autoDeleteAfterHours: number
  registrationMode: RegistrationMode
  roomCreationMode: RoomCreationMode
  betaFeaturesEnabled: boolean
  dashDisabled: boolean
  playsvideoEnabled: boolean
  cdnAccelerate: boolean
  cdnProxyUrl: string
  dataSourceConfig?: {
    aniSubsSubscriptions?: string[]
    kazumiRules?: string[]
    rssSources?: Array<{ id: string; name?: string; url: string }>
    thirdPartySources?: Array<{
      id: string
      name?: string
      baseUrl?: string
      endpoints?: Record<string, unknown>
    }>
  }
}

export default function AdminPage() {
  useTranslation()
  useHideBodyScrollbar()
  const navigate = useNavigate()
  const { isAuthenticated, authResolved, user } = useAuthStore()
  const isRoot = user?.role === 'root'
  const { invalidate: invalidateSystemSettings } = useSystemSettingsStore()
  const [activeTab, setActiveTab] = useState<'users' | 'rooms' | 'settings'>(
    'users'
  )
  const [users, setUsers] = useState<AdminUser[]>([])
  const [rooms, setRooms] = useState<AdminRoom[]>([])
  const [settings, setSettings] = useState<AdminSettings>({
    autoDeleteInactiveRooms: true,
    autoDeleteAfterHours: 24,
    registrationMode: 'approval',
    roomCreationMode: 'admin-only',
    betaFeaturesEnabled: false,
    dashDisabled: false,
    playsvideoEnabled: true,
    cdnAccelerate: false,
    cdnProxyUrl: 'https://gh-proxy.com',
  })
  const [loading, setLoading] = useState(false)
  const [settingsLoading, setSettingsLoading] = useState(false)
  const [savingSettings, setSavingSettings] = useState(false)
  const [cleanupLoading, setCleanupLoading] = useState(false)
  const [userDelete, setUserDelete] = useState<AdminUser | null>(null)
  const [userApprove, setUserApprove] = useState<AdminUser | null>(null)
  const [roomClose, setRoomClose] = useState<AdminRoom | null>(null)
  const [cleanupConfirm, setCleanupConfirm] = useState(false)
  const [selectedRoomIds, setSelectedRoomIds] = useState<Set<string>>(new Set())
  const [batchDeleteLoading, setBatchDeleteLoading] = useState(false)
  const [deleteAllLoading, setDeleteAllLoading] = useState(false)
  const [batchDeleteConfirm, setBatchDeleteConfirm] = useState(false)
  const [deleteAllConfirm, setDeleteAllConfirm] = useState(false)
  const [roomViewMode, setRoomViewMode] = useState<'list' | 'tile'>(() => {
    const saved = localStorage.getItem('admin-rooms-view-mode')
    return saved === 'tile' ? 'tile' : 'list'
  })
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null)
  const [updateError, setUpdateError] = useState('')
  const [updateLoading, setUpdateLoading] = useState(false)
  const [applyLoading, setApplyLoading] = useState(false)
  const [uploadLoading, setUploadLoading] = useState(false)
  // 更新进度：应用更新时由 SSE 流式接口实时推送
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(
    null
  )
  const [includePrerelease, setIncludePrerelease] = useState(
    () => localStorage.getItem('update-include-prerelease') === 'true'
  )
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const authHeaders = {
    'Content-Type': 'application/json',
  }

  const fetchUsers = async () => {
    const res = await apiFetch('/api/admin/users', {
      headers: authHeaders,
    })
    const data = (await res.json()) as {
      success: boolean
      users?: AdminUser[]
      message?: string
    }
    if (data.success && data.users) {
      setUsers(data.users)
    } else {
      message.error(englishErrorMessage(data.message, 'Could not load users.'))
    }
  }

  const fetchRooms = async () => {
    const res = await apiFetch('/api/admin/rooms', {
      headers: authHeaders,
    })
    const data = (await res.json()) as {
      success: boolean
      rooms?: AdminRoom[]
      message?: string
    }
    if (data.success && data.rooms) {
      setRooms(data.rooms)
      setSelectedRoomIds(new Set())
    } else {
      message.error(englishErrorMessage(data.message, 'Could not load rooms.'))
    }
  }

  const fetchSettings = async () => {
    const res = await apiFetch('/api/admin/settings', {
      headers: authHeaders,
    })
    const data = (await res.json()) as {
      success: boolean
      settings?: AdminSettings
      message?: string
    }
    if (data.success && data.settings) {
      setSettings(data.settings)
      // 同步更新 systemSettingsStore，避免 HomePage 等公开页面拿到过期值
      invalidateSystemSettings()
    } else {
      message.error(
        englishErrorMessage(data.message, 'Could not load settings.')
      )
    }
  }

  const loadData = async () => {
    setLoading(true)
    try {
      if (activeTab === 'users') {
        await fetchUsers()
      } else if (activeTab === 'rooms') {
        await fetchRooms()
      }
    } catch (err) {
      console.error('[AdminPage] load data error:', err)
      message.error(t('Could not load data.'))
    } finally {
      setLoading(false)
    }
  }

  const loadSettings = async () => {
    setSettingsLoading(true)
    try {
      await fetchSettings()
    } catch (err) {
      console.error('[AdminPage] load settings error:', err)
      message.error(t('Could not load settings.'))
    } finally {
      setSettingsLoading(false)
    }
  }

  const checkUpdate = async () => {
    setUpdateLoading(true)
    try {
      const res = await apiFetch(
        `/api/system/update/check?includePrerelease=${includePrerelease}`,
        {
          headers: authHeaders,
        }
      )
      const data = (await res.json()) as {
        success: boolean
        info?: UpdateInfo
        code?: string
        message?: string
      }
      if (data.success && data.info) {
        setUpdateError('')
        setUpdateInfo(data.info)
        if (data.info.hasUpdate) {
          message.info(
            data.info.isPrerelease
              ? t('A new prerelease is available')
              : t('An update is available')
          )
        } else {
          message.success(t('You are up to date.'))
        }
      } else {
        const reason =
          data.code === 'UPDATE_NOT_CONFIGURED'
            ? 'Online updates are disabled because no trusted update repository is configured.'
            : data.message || 'Could not check for updates.'
        setUpdateInfo(null)
        setUpdateError(reason)
        message.error(
          englishErrorMessage(reason, t('Could not check for updates.'))
        )
      }
    } catch (err) {
      setUpdateInfo(null)
      setUpdateError('Could not check for updates.')
      console.error('[AdminPage] check update error:', err)
      message.error(t('Could not check for updates.'))
    } finally {
      setUpdateLoading(false)
    }
  }

  const handleApplyUpdate = async () => {
    setApplyLoading(true)
    setUpdateProgress({
      stage: 'downloading',
      received: 0,
      total: 0,
      message: '',
    })
    try {
      // 使用 SSE 流式接口，实时推送下载/解压/启动进度
      const res = await apiFetch(
        `/api/system/update/apply-stream?includePrerelease=${includePrerelease}`,
        {
          method: 'POST',
          headers: authHeaders,
        }
      )

      if (!res.ok || !res.body) {
        // 非流式错误响应（如 401/403/500）
        const errData = (await res.json().catch(() => ({}))) as {
          message?: string
        }
        message.error(englishErrorMessage(errData.message, 'Update failed.'))
        setUpdateProgress(null)
        return
      }

      // 读取 SSE 流：按 `\n\n` 分割事件，每条事件 `data: <json>`
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let lastStage: UpdateProgress['stage'] | null = null
      let doneMessage = ''
      let errorMessage = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const events = buffer.split('\n\n')
        buffer = events.pop() ?? ''
        for (const evt of events) {
          const line = evt.trim()
          if (!line.startsWith('data: ')) continue
          const jsonStr = line.slice(6).trim()
          if (!jsonStr) continue
          try {
            const data = JSON.parse(jsonStr) as UpdateStageEventPayload
            if (data.stage === 'downloading') {
              setUpdateProgress({
                stage: 'downloading',
                received: data.received ?? 0,
                total: data.total ?? 0,
                message: '',
              })
            } else if (data.stage === 'extracting') {
              setUpdateProgress({
                stage: 'extracting',
                received: 0,
                total: 0,
                message: 'Extracting the update…',
              })
            } else if (data.stage === 'starting') {
              setUpdateProgress({
                stage: 'starting',
                received: 0,
                total: 0,
                message: 'Starting the update…',
              })
            } else if (data.stage === 'done') {
              doneMessage = data.message ?? 'Update started.'
              setUpdateProgress({
                stage: 'done',
                received: 0,
                total: 0,
                message: doneMessage,
              })
            } else if (data.stage === 'error') {
              errorMessage = data.message ?? 'Update failed.'
              setUpdateProgress({
                stage: 'error',
                received: 0,
                total: 0,
                message: errorMessage,
              })
            }
            lastStage = data.stage
          } catch {
            // 忽略解析错误
          }
        }
      }

      if (lastStage === 'done') {
        message.success(englishErrorMessage(doneMessage, 'Update started.'))
      } else if (lastStage === 'error') {
        message.error(englishErrorMessage(errorMessage, 'Update failed.'))
      } else {
        // 流意外中断，未收到 done/error
        message.error(t('Update interrupted. Try again.'))
      }
    } catch (err) {
      console.error('[AdminPage] apply update error:', err)
      message.error(t('Update failed.'))
    } finally {
      setApplyLoading(false)
      // 保留进度状态显示最终结果，3 秒后清除
      setTimeout(() => setUpdateProgress(null), 3000)
    }
  }

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    // 验证文件类型
    const lowerName = file.name.toLowerCase()
    if (!lowerName.endsWith('.zip') && !lowerName.endsWith('.tar.gz')) {
      message.error(t('Choose a .zip or .tar.gz archive.'))
      event.target.value = ''
      return
    }

    setUploadLoading(true)
    setUpdateProgress({
      stage: 'downloading',
      received: 0,
      total: file.size,
      message: 'Uploading the update…',
    })

    try {
      // 使用 XHR 上传：可跟踪上传进度，响应体为 SSE 流
      const apiUrl = getApiUrl()
      const uploadUrl = `${apiUrl}/api/system/update/upload-stream?filename=${encodeURIComponent(file.name)}`

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('POST', uploadUrl)
        xhr.withCredentials = true
        xhr.responseType = 'text'
        xhr.setRequestHeader(
          'Content-Type',
          lowerName.endsWith('.tar.gz') ? 'application/gzip' : 'application/zip'
        )

        // 上传进度跟踪
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            setUpdateProgress({
              stage: 'downloading',
              received: e.loaded,
              total: e.total,
              message: 'Uploading the update…',
            })
          }
        }

        // 上传完成 → 开始接收 SSE 响应流
        // xhr.onprogress 在响应数据到达时触发，可读取增量 responseText
        let lastProcessedLen = 0
        let buffer = ''
        let lastStage: UpdateProgress['stage'] | null = null
        let doneMessage = ''
        let errorMessage = ''

        const processSSEChunk = () => {
          const fullText = xhr.responseText || ''
          const chunk = fullText.slice(lastProcessedLen)
          lastProcessedLen = fullText.length
          buffer += chunk
          const events = buffer.split('\n\n')
          buffer = events.pop() ?? ''
          for (const evt of events) {
            const line = evt.trim()
            if (!line.startsWith('data: ')) continue
            const jsonStr = line.slice(6).trim()
            if (!jsonStr) continue
            try {
              const data = JSON.parse(jsonStr) as UpdateStageEventPayload
              if (data.stage === 'extracting') {
                setUpdateProgress({
                  stage: 'extracting',
                  received: 0,
                  total: 0,
                  message: 'Extracting the update…',
                })
              } else if (data.stage === 'starting') {
                setUpdateProgress({
                  stage: 'starting',
                  received: 0,
                  total: 0,
                  message: 'Starting the update…',
                })
              } else if (data.stage === 'done') {
                doneMessage = data.message ?? 'Update started.'
                setUpdateProgress({
                  stage: 'done',
                  received: 0,
                  total: 0,
                  message: doneMessage,
                })
              } else if (data.stage === 'error') {
                errorMessage = data.message ?? 'Update failed.'
                setUpdateProgress({
                  stage: 'error',
                  received: 0,
                  total: 0,
                  message: errorMessage,
                })
              }
              lastStage = data.stage
            } catch {
              // 忽略解析错误
            }
          }
        }

        xhr.onprogress = processSSEChunk

        xhr.onload = () => {
          // 处理流中剩余数据
          processSSEChunk()
          if (xhr.status >= 200 && xhr.status < 300) {
            if (lastStage === 'done') {
              message.success(
                englishErrorMessage(doneMessage, 'Update started.')
              )
            } else if (lastStage === 'error') {
              message.error(
                englishErrorMessage(
                  errorMessage,
                  'Could not upload the update.'
                )
              )
            } else if (lastStage === null) {
              // 未收到 SSE 事件，可能是普通 JSON 响应（错误场景）
              try {
                const data = JSON.parse(xhr.responseText) as {
                  success?: boolean
                  message?: string
                }
                if (data.success) {
                  message.success(
                    englishErrorMessage(data.message, 'Update started.')
                  )
                } else {
                  message.error(
                    englishErrorMessage(
                      data.message,
                      'Could not upload the update.'
                    )
                  )
                }
              } catch {
                message.error(t('Could not upload the update.'))
              }
            }
            resolve()
          } else if (xhr.status === 401 || xhr.status === 403) {
            message.error(t('Your session expired. Sign in and try again.'))
            reject(new Error('auth expired'))
          } else {
            // 非 SSE 错误响应
            try {
              const data = JSON.parse(xhr.responseText) as {
                message?: string
              }
              message.error(
                englishErrorMessage(
                  data.message,
                  'Could not upload the update.'
                )
              )
            } catch {
              message.error(t('Could not upload the update.'))
            }
            reject(new Error(`HTTP ${xhr.status}`))
          }
        }

        xhr.onerror = () => {
          message.error(t('A network error interrupted the upload.'))
          reject(new Error('network error'))
        }

        xhr.send(file)
      })
    } catch (err) {
      console.error('[AdminPage] upload update error:', err)
      if (
        err instanceof Error &&
        err.message !== 'network error' &&
        err.message !== 'auth expired' &&
        !err.message.startsWith('HTTP')
      ) {
        message.error(t('Could not upload the update.'))
      }
    } finally {
      setUploadLoading(false)
      event.target.value = ''
      // 保留进度状态显示最终结果，3 秒后清除
      setTimeout(() => setUpdateProgress(null), 3000)
    }
  }

  useEffect(() => {
    if (!isAuthenticated || !authResolved) return
    /* eslint-disable react-hooks/set-state-in-effect -- tab 切换时加载对应数据 */
    if (activeTab === 'settings') {
      void loadSettings()
      if (isRoot) void checkUpdate()
    } else if (activeTab === 'users') {
      void loadData()
      void loadSettings()
    } else {
      void loadData()
    }
    /* eslint-enable react-hooks/set-state-in-effect */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, isAuthenticated, authResolved, isRoot])

  const handleChangeRole = async (
    targetUser: AdminUser,
    nextRole: AdminUser['role']
  ) => {
    if (targetUser.role === nextRole) return
    try {
      const res = await apiFetch(`/api/admin/users/${targetUser.id}/role`, {
        method: 'PATCH',
        headers: authHeaders,
        body: JSON.stringify({ role: nextRole }),
      })
      const data = (await res.json()) as { success: boolean; message?: string }
      if (data.success) {
        const roleLabelMap: Record<AdminUser['role'], string> = {
          root: t('Root administrator'),
          admin: t('Administrator'),
          user: t('Member'),
          guest: t('Guest'),
        }
        message.success(
          t('Changed  {value1}  to  {value2}', {
            value1: targetUser.username,
            value2: roleLabelMap[nextRole],
          })
        )
        await fetchUsers()
      } else {
        message.error(englishErrorMessage(data.message, 'Action failed.'))
      }
    } catch (err) {
      console.error('[AdminPage] change role error:', err)
      message.error(t('Could not change the role.'))
    }
  }

  const handleApproveUser = async () => {
    if (!userApprove) return
    try {
      const res = await apiFetch(`/api/admin/users/${userApprove.id}/approve`, {
        method: 'POST',
        headers: authHeaders,
      })
      const data = (await res.json()) as { success: boolean; message?: string }
      if (data.success) {
        message.success(t('User approved.'))
        setUserApprove(null)
        await fetchUsers()
      } else {
        message.error(englishErrorMessage(data.message, 'Approval failed.'))
      }
    } catch (err) {
      console.error('[AdminPage] approve user error:', err)
      message.error(t('Could not approve the user.'))
    }
  }

  const handleDeleteUser = async () => {
    if (!userDelete) return
    try {
      const res = await apiFetch(`/api/admin/users/${userDelete.id}`, {
        method: 'DELETE',
        headers: authHeaders,
      })
      const data = (await res.json()) as { success: boolean; message?: string }
      if (data.success) {
        message.success(t('User removed.'))
        setUserDelete(null)
        await fetchUsers()
      } else {
        message.error(
          englishErrorMessage(data.message, 'Could not remove this item.')
        )
      }
    } catch (err) {
      console.error('[AdminPage] delete user error:', err)
      message.error(t('Could not remove the user.'))
    }
  }

  const handleCloseRoom = async () => {
    if (!roomClose) return
    try {
      const res = await apiFetch(`/api/admin/rooms/${roomClose.roomId}`, {
        method: 'DELETE',
        headers: authHeaders,
      })
      const data = (await res.json()) as { success: boolean; message?: string }
      if (data.success) {
        message.success(t('Room closed.'))
        setRoomClose(null)
        await fetchRooms()
      } else {
        message.error(
          englishErrorMessage(data.message, 'Could not close this item.')
        )
      }
    } catch (err) {
      console.error('[AdminPage] close room error:', err)
      message.error(t('Could not close the room.'))
    }
  }

  const handleBatchDeleteRooms = async () => {
    if (selectedRoomIds.size === 0) return
    setBatchDeleteLoading(true)
    try {
      const res = await apiFetch('/api/admin/rooms/batch-delete', {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ roomIds: Array.from(selectedRoomIds) }),
      })
      const data = (await res.json()) as {
        success: boolean
        count?: number
        message?: string
      }
      if (data.success) {
        message.success(
          t('Removed  {value1}  rooms', {
            value1: data.count ?? selectedRoomIds.size,
          })
        )
        setSelectedRoomIds(new Set())
        setBatchDeleteConfirm(false)
        await fetchRooms()
      } else {
        message.error(
          englishErrorMessage(
            data.message,
            'Could not remove the selected items.'
          )
        )
      }
    } catch (err) {
      console.error('[AdminPage] batch delete rooms error:', err)
      message.error(t('Could not remove the selected rooms.'))
    } finally {
      setBatchDeleteLoading(false)
    }
  }

  const handleDeleteAllRooms = async () => {
    setDeleteAllLoading(true)
    try {
      const res = await apiFetch('/api/admin/rooms/delete-all', {
        method: 'POST',
        headers: authHeaders,
      })
      const data = (await res.json()) as {
        success: boolean
        count?: number
        message?: string
      }
      if (data.success) {
        message.success(
          t('Removed  {value1}  rooms', { value1: data.count ?? 0 })
        )
        setSelectedRoomIds(new Set())
        setDeleteAllConfirm(false)
        await fetchRooms()
      } else {
        message.error(
          englishErrorMessage(data.message, 'Could not remove all rooms.')
        )
      }
    } catch (err) {
      console.error('[AdminPage] delete all rooms error:', err)
      message.error(t('Could not remove all rooms.'))
    } finally {
      setDeleteAllLoading(false)
    }
  }

  const handleSaveSettings = async () => {
    setSavingSettings(true)
    try {
      // 仅在 dataSourceConfig 有值时传递，避免 null 覆盖已有配置；
      // dataSourceConfig 的编辑入口在"数据源设置"卡片，不在权限管理页面。
      const payload: Record<string, unknown> = {
        autoDeleteInactiveRooms: settings.autoDeleteInactiveRooms,
        autoDeleteAfterHours: settings.autoDeleteAfterHours,
        registrationMode: settings.registrationMode,
        roomCreationMode: settings.roomCreationMode,
        betaFeaturesEnabled: settings.betaFeaturesEnabled,
        dashDisabled: settings.dashDisabled,
        playsvideoEnabled: settings.playsvideoEnabled,
        cdnAccelerate: settings.cdnAccelerate,
        cdnProxyUrl: settings.cdnProxyUrl,
      }
      if (settings.dataSourceConfig) {
        payload.dataSourceConfig = settings.dataSourceConfig
      }
      const res = await apiFetch('/api/admin/settings', {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify(payload),
      })
      const data = (await res.json()) as {
        success: boolean
        settings?: AdminSettings
        message?: string
      }
      if (data.success) {
        message.success(t('Settings saved.'))
        if (data.settings) {
          setSettings(data.settings)
        }
        invalidateSystemSettings()
      } else {
        message.error(
          englishErrorMessage(data.message, 'Could not save changes.')
        )
      }
    } catch (err) {
      console.error('[AdminPage] save settings error:', err)
      message.error(t('Could not save settings.'))
    } finally {
      setSavingSettings(false)
    }
  }

  const handleCleanupUnusedRooms = async () => {
    setCleanupLoading(true)
    try {
      const res = await apiFetch('/api/admin/rooms/cleanup-unused', {
        method: 'POST',
        headers: authHeaders,
      })
      const data = (await res.json()) as {
        success: boolean
        count?: number
        message?: string
      }
      if (data.success) {
        if (data.count && data.count > 0) {
          message.success(
            t('Cleaned up  {value1}  empty rooms', { value1: data.count })
          )
        } else {
          message.info(t('No rooms need cleaning up.'))
        }
        setCleanupConfirm(false)
        await fetchRooms()
      } else {
        message.error(englishErrorMessage(data.message, 'Cleanup failed.'))
      }
    } catch (err) {
      console.error('[AdminPage] cleanup unused rooms error:', err)
      message.error(t('Could not clean up rooms.'))
    } finally {
      setCleanupLoading(false)
    }
  }

  const isSelf = (targetUser: AdminUser) => user?.id === String(targetUser.id)

  /** 用户List/Last visited ：精确时间（Manage审计需要） */
  const formatDate = (iso: string) =>
    new Date(iso).toLocaleString(getLocale() === 'zh' ? 'zh-CN' : 'en-US')
  /** 房间Create时间：<24h 相对时间，≥24h 精确时间 */
  const formatRoomCreatedAt = formatRecentTime

  if (!authResolved) return null

  return (
    <div className="tongmu-admin-page flex-1 p-4 sm:p-6">
      <div className="tongmu-admin-page__content relative mx-auto w-full">
        <div className="tongmu-admin-page__intro">
          <div>
            <h1>{t('Administration')}</h1>
            <p>{t('Manage users, rooms and platform settings.')}</p>
          </div>
          <span className="tongmu-admin-page__role">
            <Shield className="h-4 w-4" />
            {isRoot ? t('Root administrator') : t('Administrator')}
          </span>
        </div>

        <div
          className="tongmu-admin-page__tabs"
          role="tablist"
          aria-label={t('Administration sections')}
        >
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'users'}
            onClick={() => setActiveTab('users')}
            className="tongmu-admin-page__tab"
          >
            <Users className="h-4 w-4" />
            <span>{t('Users')}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'rooms'}
            onClick={() => setActiveTab('rooms')}
            className="tongmu-admin-page__tab"
          >
            <LayoutDashboard className="h-4 w-4" />
            <span>{t('Rooms')}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'settings'}
            onClick={() => setActiveTab('settings')}
            className="tongmu-admin-page__tab"
          >
            <Settings className="h-4 w-4" />
            <span>{t('Settings')}</span>
          </button>
        </div>

        <div className="tongmu-admin-page__toolbar">
          <Text type="secondary" className="shrink-0">
            {activeTab === 'users'
              ? t('Total: {value1}  users', { value1: users.length })
              : activeTab === 'rooms'
                ? t('Total: {value1}  rooms', { value1: rooms.length })
                : t('Save your changes at the bottom of this page.')}
          </Text>
          {activeTab !== 'settings' && (
            <div className="tongmu-admin-page__actions">
              {activeTab === 'rooms' && (
                <>
                  <div className="tongmu-admin-page__view-toggle">
                    <button
                      type="button"
                      onClick={() => {
                        setRoomViewMode('list')
                        localStorage.setItem('admin-rooms-view-mode', 'list')
                      }}
                      className="tongmu-admin-page__view-option"
                      aria-pressed={roomViewMode === 'list'}
                      aria-label={t('List view')}
                      title={t('List view')}
                    >
                      <List className="h-4 w-4" />
                      <span className="hidden sm:inline">{t('List')}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRoomViewMode('tile')
                        localStorage.setItem('admin-rooms-view-mode', 'tile')
                      }}
                      className="tongmu-admin-page__view-option"
                      aria-pressed={roomViewMode === 'tile'}
                      aria-label={t('Grid view')}
                      title={t('Grid view')}
                    >
                      <LayoutGrid className="h-4 w-4" />
                      <span className="hidden sm:inline">{t('Grid')}</span>
                    </button>
                  </div>
                  {isRoot && selectedRoomIds.size > 0 && (
                    <Button
                      variant="danger"
                      size="sm"
                      icon={<Trash2 className="h-4 w-4" />}
                      onClick={() => setBatchDeleteConfirm(true)}
                      disabled={batchDeleteLoading}
                      title={t('Remove selected  {value1}  rooms', {
                        value1: selectedRoomIds.size,
                      })}
                    >
                      <span className="sm:hidden">
                        {t('Selected {count}', { count: selectedRoomIds.size })}
                      </span>
                      <span className="hidden sm:inline">
                        {t('Remove selected ({count})', {
                          count: selectedRoomIds.size,
                        })}
                      </span>
                    </Button>
                  )}
                  {isRoot && (
                    <Button
                      variant="danger"
                      size="sm"
                      icon={<Trash2 className="h-4 w-4" />}
                      onClick={() => setDeleteAllConfirm(true)}
                      disabled={deleteAllLoading}
                      title={t('Remove all rooms')}
                    >
                      {t('Remove all rooms')}
                    </Button>
                  )}
                  <Button
                    variant="danger"
                    size="sm"
                    icon={<Trash2 className="h-4 w-4" />}
                    onClick={() => setCleanupConfirm(true)}
                    disabled={cleanupLoading}
                    title={
                      isRoot
                        ? t('Remove empty rooms')
                        : t('Clean up your own empty rooms')
                    }
                  >
                    {isRoot
                      ? t('Clean up empty rooms')
                      : t('Clean up my empty rooms')}
                  </Button>
                </>
              )}
              <Button
                variant="secondary"
                size="sm"
                icon={<RefreshCw className="h-4 w-4" />}
                onClick={loadData}
                disabled={loading}
                title={t('Refresh')}
              >
                <span className="sm:hidden">{t('Refresh')}</span>
                <span className="hidden sm:inline">{t('Refresh')}</span>
              </Button>
            </div>
          )}
        </div>

        {loading ? (
          <div className="py-12">
            <Spinner tip={t('Loading…')} size={32} />
          </div>
        ) : activeTab === 'users' ? (
          <div className="grid gap-3">
            <section className="tongmu-admin-page__section">
              <Title level={5} className="mb-3">
                {t('Registration')}
              </Title>
              <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
                <div className="max-w-xs flex-1">
                  <Select
                    label={t('Registration mode')}
                    value={settings.registrationMode}
                    options={[
                      { label: t('Open registration'), value: 'open' },
                      { label: t('Approval required'), value: 'approval' },
                      { label: t('Registration closed'), value: 'closed' },
                    ]}
                    onChange={(value) =>
                      setSettings((prev) => ({
                        ...prev,
                        registrationMode: value as RegistrationMode,
                      }))
                    }
                  />
                  <p className="mt-1.5 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                    {t(
                      'Open registration lets new users sign in immediately. Approval requires a root administrator to approve each account. Closed registration prevents new accounts.'
                    )}
                  </p>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSaveSettings}
                  loading={savingSettings}
                  disabled={savingSettings}
                >
                  {t('Save')}
                </Button>
              </div>
            </section>
            {users.length === 0 ? (
              <div className="py-12 text-center">
                <Text type="secondary">{t('No users yet.')}</Text>
              </div>
            ) : (
              users.map((u) => {
                const isRootUser = u.role === 'root' || u.username === 'root'
                const roleLabelMap: Record<AdminUser['role'], string> = {
                  root: t('Root administrator'),
                  admin: t('Administrator'),
                  user: t('Member'),
                  guest: t('Guest'),
                }
                const roleColorMap: Record<
                  AdminUser['role'],
                  | 'default'
                  | 'primary'
                  | 'success'
                  | 'warning'
                  | 'danger'
                  | 'cyan'
                  | 'purple'
                > = {
                  root: 'primary',
                  admin: 'cyan',
                  user: 'default',
                  guest: 'default',
                }
                return (
                  <div
                    key={u.id}
                    className="tongmu-admin-page__item flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium text-[var(--tm-text-primary)]">
                          {u.username}
                        </span>
                        <Tag color={roleColorMap[u.role]}>
                          {u.role === 'root' || u.role === 'admin' ? (
                            <Shield className="mr-1 inline h-3 w-3" />
                          ) : null}
                          {roleLabelMap[u.role]}
                        </Tag>
                        {u.status === 'pending' ? (
                          <Tag color="warning">{t('Awaiting approval')}</Tag>
                        ) : (
                          <Tag color="success">{t('Active')}</Tag>
                        )}
                      </div>
                      <Text type="secondary" className="text-xs">
                        {t('Created')}
                        {formatDate(u.createdAt)}
                      </Text>
                    </div>
                    {isRoot && (
                      <Space className="shrink-0 flex-wrap">
                        {u.status === 'pending' && (
                          <Button
                            variant="primary"
                            size="sm"
                            icon={<UserCheck className="h-4 w-4" />}
                            onClick={() => setUserApprove(u)}
                            disabled={isRootUser}
                          >
                            {t('Approve')}
                          </Button>
                        )}
                        {isRootUser ? (
                          <div className="flex w-32 items-center justify-center rounded-[var(--tm-radius)] border border-[var(--tm-border)] px-3 py-2 text-sm text-[var(--tm-text-secondary)]">
                            {t('Root administrator')}
                          </div>
                        ) : (
                          <Select
                            className="w-32"
                            value={u.role}
                            disabled={isSelf(u)}
                            options={[
                              { label: t('Administrator'), value: 'admin' },
                              { label: t('Member'), value: 'user' },
                            ]}
                            onChange={(value) =>
                              handleChangeRole(u, value as AdminUser['role'])
                            }
                          />
                        )}
                        {!isRootUser && !isSelf(u) && (
                          <Button
                            variant="danger"
                            size="sm"
                            icon={<Trash2 className="h-4 w-4" />}
                            onClick={() => setUserDelete(u)}
                          >
                            {t('Remove')}
                          </Button>
                        )}
                      </Space>
                    )}
                  </div>
                )
              })
            )}
          </div>
        ) : activeTab === 'rooms' ? (
          <div
            className={
              roomViewMode === 'tile'
                ? 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3'
                : 'grid gap-3'
            }
          >
            {rooms.length === 0 ? (
              <div className="col-span-full py-12 text-center">
                <Text type="secondary">{t('No rooms yet.')}</Text>
              </div>
            ) : (
              <>
                {isRoot && (
                  <label className="tongmu-admin-page__select-all col-span-full min-h-[44px] cursor-pointer">
                    <input
                      type="checkbox"
                      aria-label={t('Select all rooms')}
                      className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--md-sys-color-primary)]"
                      checked={
                        rooms.length > 0 &&
                        rooms.every((r) => selectedRoomIds.has(r.roomId))
                      }
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelectedRoomIds(
                            new Set(rooms.map((r) => r.roomId))
                          )
                        } else {
                          setSelectedRoomIds(new Set())
                        }
                      }}
                    />
                    <Text type="secondary" className="text-sm">
                      {t('Select all ({selected} / {total})', {
                        selected: selectedRoomIds.size,
                        total: rooms.length,
                      })}
                    </Text>
                  </label>
                )}
                {rooms.map((room) => (
                  <div
                    key={room.id}
                    className={cn(
                      roomViewMode === 'tile'
                        ? 'tongmu-admin-page__item flex flex-col gap-3 p-4'
                        : 'tongmu-admin-page__item flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between',
                      isRoot && selectedRoomIds.has(room.roomId)
                        ? 'tongmu-admin-page__item--selected'
                        : ''
                    )}
                  >
                    <div className="flex min-w-0 flex-1 items-start gap-3">
                      {isRoot && (
                        <label className="tongmu-admin-room-select">
                          <input
                            type="checkbox"
                            aria-label={t('Select room {name}', {
                              name: room.name || room.roomId,
                            })}
                            className="h-4 w-4 shrink-0 cursor-pointer accent-[var(--md-sys-color-primary)]"
                            checked={selectedRoomIds.has(room.roomId)}
                            onChange={(e) => {
                              setSelectedRoomIds((prev) => {
                                const next = new Set(prev)
                                if (e.target.checked) {
                                  next.add(room.roomId)
                                } else {
                                  next.delete(room.roomId)
                                }
                                return next
                              })
                            }}
                          />
                        </label>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className="truncate font-medium text-[var(--tm-text-primary)]"
                            title={room.name || room.roomId}
                          >
                            {room.name || room.roomId}
                          </span>
                          <Text
                            type="secondary"
                            className="text-xs sm:hidden"
                            title={room.roomId}
                          >
                            {room.roomId.length > 8
                              ? `${room.roomId.slice(0, 8)}…`
                              : room.roomId}
                          </Text>
                          <Text
                            type="secondary"
                            className="hidden text-xs sm:inline"
                          >
                            {room.roomId}
                          </Text>
                          {room.status === 'active' ? (
                            <Tag color="success">{t('Active')}</Tag>
                          ) : (
                            <Tag color="default">{t('Closed')}</Tag>
                          )}
                          {room.requireApproval ? (
                            <Tag color="warning">{t('Approval required')}</Tag>
                          ) : (
                            <Tag color="cyan">{t('Join immediately')}</Tag>
                          )}
                          {room.hasPassword && (
                            <Tag color="purple">
                              <Lock className="mr-1 inline h-3 w-3" />
                              {t('Password protected')}
                            </Tag>
                          )}
                        </div>
                        <Text
                          type="secondary"
                          className="mt-1 text-xs leading-relaxed sm:mt-0"
                        >
                          {t('Members')}
                          {room.viewerCount} / {room.maxViewers}
                          {roomViewMode === 'tile' ? <br /> : ' · '}
                          {t('Host')}
                          {room.sharerOnline ? t('Online') : t('Offline')}
                          {roomViewMode === 'tile' ? <br /> : ' · '}
                          {t('Created')}
                          {formatRoomCreatedAt(room.createdAt)}
                          {roomViewMode === 'tile' ? <br /> : ' · '}
                          {t('Last visited')}
                          {formatDate(room.lastAccessedAt)}
                        </Text>
                      </div>
                    </div>
                    <div className="tongmu-admin-page__room-actions">
                      {room.status === 'active' && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() =>
                            navigate(`/room/${room.roomId}?role=host`)
                          }
                        >
                          {t('Open room')}
                        </Button>
                      )}
                      {room.status === 'active' &&
                        (canCloseAdminRoom(
                          user?.role,
                          user?.id,
                          room.ownerUserId
                        ) ? (
                          <Button
                            variant="danger"
                            size="sm"
                            className={
                              roomViewMode === 'tile'
                                ? 'mt-auto w-full'
                                : 'w-full sm:w-auto'
                            }
                            icon={<Power className="h-4 w-4" />}
                            onClick={() => setRoomClose(room)}
                          >
                            {t('Close room')}
                          </Button>
                        ) : (
                          <Text type="secondary" className="text-xs">
                            {t('Only the owner can close this room.')}
                          </Text>
                        ))}
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
        ) : (
          <div className="tongmu-admin-page__settings">
            {settingsLoading ? (
              <div className="py-12">
                <Spinner tip={t('Loading…')} size={32} />
              </div>
            ) : (
              <>
                <Title level={5} className="mb-4">
                  {t('Room retention')}
                </Title>
                <div className="mb-4">
                  <Paragraph type="secondary">
                    {t(
                      'Temporary rooms are removed after 24 continuous hours with no members. Returning resets the deadline. Fixed rooms retain their settings, queues and playback position while releasing idle activity resources.'
                    )}
                  </Paragraph>
                </div>

                <Title level={5} className="mb-4 mt-6">
                  {t('Room creation')}
                </Title>
                <div className="mb-6 max-w-md">
                  <Select
                    label={t('Who can create rooms')}
                    value={settings.roomCreationMode}
                    options={[
                      {
                        label: t('Administrators only (root / admin)'),
                        value: 'admin-only',
                      },
                      {
                        label: t('All signed-in users'),
                        value: 'all-users',
                      },
                    ]}
                    onChange={(value) =>
                      setSettings((prev) => ({
                        ...prev,
                        roomCreationMode: value as RoomCreationMode,
                      }))
                    }
                  />
                  <p className="mt-1.5 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                    {t(
                      'All signed-in users can create rooms when enabled. Guests cannot create rooms.'
                    )}
                  </p>
                </div>

                <Title level={5} className="mb-4 mt-6">
                  {t('Optional features')}
                </Title>
                <div className="mb-6">
                  <Switch
                    label={t('Enable Kazumi, AniSubs and Bilibili downloads')}
                    checked={settings.betaFeaturesEnabled}
                    onChange={(e) =>
                      setSettings((prev) => ({
                        ...prev,
                        betaFeaturesEnabled: e.target.checked,
                      }))
                    }
                  />
                  <p className="mt-1.5 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                    {t(
                      'When disabled, Kazumi and AniSubs in rooms and the Bilibili download controls in your profile are hidden.'
                    )}
                  </p>
                </div>

                {settings.betaFeaturesEnabled && (
                  <>
                    <Title level={5} className="mb-4 mt-6">
                      {t('Kazumi sources')}
                    </Title>
                    <div className="mb-4">
                      <label className="mb-1.5 block text-sm font-medium text-[var(--md-sys-color-on-surface-variant)]">
                        {t('Rule URLs (one per line; blank uses defaults)')}
                      </label>
                      <textarea
                        rows={4}
                        className="w-full rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-high)] px-3 py-2 text-sm text-[var(--md-sys-color-on-surface)] placeholder:text-[var(--md-sys-color-on-surface-variant)] focus:border-[var(--md-sys-color-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--md-sys-color-primary)]"
                        placeholder="https://raw.githubusercontent.com/Predidit/Kazumi/main/assets/plugins/DM84.json"
                        value={(
                          settings.dataSourceConfig?.kazumiRules || []
                        ).join('\n')}
                        onChange={(e) =>
                          setSettings((prev) => ({
                            ...prev,
                            dataSourceConfig: {
                              ...prev.dataSourceConfig,
                              kazumiRules: e.target.value
                                .split('\n')
                                .map((s) => s.trim())
                                .filter(Boolean),
                            },
                          }))
                        }
                      />
                      <p className="mt-1 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                        {t(
                          'Save to load these Kazumi XPath rules. Sources that require useWebview may need browser resolution.'
                        )}
                      </p>
                    </div>

                    <div className="mb-6">
                      <AniSubsGithubBrowser
                        repoUrl="https://github.com/Predidit/Kazumi"
                        defaultPath="assets/plugins"
                        existingUrls={
                          settings.dataSourceConfig?.kazumiRules || []
                        }
                        onAddUrls={(urls) =>
                          setSettings((prev) => ({
                            ...prev,
                            dataSourceConfig: {
                              ...prev.dataSourceConfig,
                              kazumiRules: [
                                ...(prev.dataSourceConfig?.kazumiRules || []),
                                ...urls,
                              ],
                            },
                          }))
                        }
                      />
                    </div>
                  </>
                )}

                <Title level={5} className="mb-4 mt-6">
                  {t('Server DASH')}
                  <span className="ml-2 text-xs font-normal text-[var(--md-sys-color-on-surface-variant)]">
                    {t('(legacy option)')}
                  </span>
                </Title>
                <div className="mb-6">
                  <Switch
                    label={t('Disable server DASH')}
                    checked={settings.dashDisabled}
                    onChange={(e) =>
                      setSettings((prev) => ({
                        ...prev,
                        dashDisabled: e.target.checked,
                      }))
                    }
                  />
                  <p className="mt-1.5 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                    {t(
                      'Forces the server Bilibili resolver to use MP4 instead of DASH. The CLI resolver can still use DASH.'
                    )}
                  </p>
                </div>

                <Title level={5} className="mb-4 mt-6">
                  {t('Playback engine')}
                </Title>
                <div className="mb-6">
                  <Switch
                    label={t('Enable the browser compatibility engine')}
                    checked={settings.playsvideoEnabled}
                    onChange={(e) =>
                      setSettings((prev) => ({
                        ...prev,
                        playsvideoEnabled: e.target.checked,
                      }))
                    }
                  />
                  <p className="mt-1.5 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                    {t(
                      'Enables local browser conversion for containers such as MKV, AVI and TS or audio such as DTS, AC3 and FLAC when required for playback. When disabled, unsupported codecs may not play or may have no audio. The per-video compatibility setting must also be enabled.'
                    )}
                  </p>
                </div>

                {isRoot && (
                  <>
                    <Title level={5} className="mb-4 mt-6">
                      {t('Software updates')}
                    </Title>
                    <div className="tongmu-admin-page__section mb-6">
                      <div className="flex items-center justify-between pb-3 mb-3 border-b border-[var(--md-sys-color-outline-variant)]">
                        <div className="flex-1 min-w-0 pr-3">
                          <Text className="text-sm font-medium">
                            {t('Include prerelease updates')}
                          </Text>
                          <Text
                            type="secondary"
                            className="block text-xs mt-0.5"
                          >
                            {t(
                              'Enable prereleases, or keep updates limited to stable releases.'
                            )}
                          </Text>
                        </div>
                        <Switch
                          checked={includePrerelease}
                          onChange={(e) => {
                            setIncludePrerelease(e.target.checked)
                            localStorage.setItem(
                              'update-include-prerelease',
                              String(e.target.checked)
                            )
                          }}
                        />
                      </div>
                      {/* CDN 加速配置 */}
                      <div className="pb-3 mb-3 border-b border-[var(--md-sys-color-outline-variant)]">
                        <div className="flex items-center justify-between pb-3">
                          <div className="flex-1 min-w-0 pr-3">
                            <Text className="text-sm font-medium">
                              {t('Update download proxy')}
                            </Text>
                            <Text
                              type="secondary"
                              className="block text-xs mt-0.5"
                            >
                              {t(
                                'Use a CDN proxy for update checks and release downloads.'
                              )}
                            </Text>
                          </div>
                          <Switch
                            checked={settings.cdnAccelerate}
                            onChange={(e) =>
                              setSettings((prev) => ({
                                ...prev,
                                cdnAccelerate: e.target.checked,
                              }))
                            }
                          />
                        </div>
                        {settings.cdnAccelerate && (
                          <div className="space-y-3">
                            <div>
                              <Text className="mb-1.5 block text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                                {t('CDN proxy URL')}
                              </Text>
                              <Input
                                value={settings.cdnProxyUrl}
                                onChange={(e) =>
                                  setSettings((prev) => ({
                                    ...prev,
                                    cdnProxyUrl: e.target.value.trim(),
                                  }))
                                }
                                placeholder="https://gh-proxy.com"
                              />
                              <Text
                                type="secondary"
                                className="block text-xs mt-1.5"
                              >
                                {t(
                                  'GitHub proxy prefix. Default: https://gh-proxy.com. You can use your own proxy.'
                                )}
                              </Text>
                            </div>
                          </div>
                        )}
                      </div>
                      {/* 更新进度 comments：Download/Upload/解压/启动各阶段实时显示 */}
                      {updateProgress && (
                        <div className="mb-3 rounded-[var(--md-sys-radius-small)] bg-[var(--md-sys-color-surface-container-high)] p-3">
                          <div className="flex items-center justify-between gap-2">
                            <Text className="text-xs font-medium text-[var(--md-sys-color-on-surface-variant)]">
                              {updateProgress.stage === 'downloading' &&
                                t(
                                  updateProgress.message ||
                                    'Downloading the update…'
                                )}
                              {updateProgress.stage === 'extracting' &&
                                t('Extracting the update…')}
                              {updateProgress.stage === 'starting' &&
                                t('Starting the update…')}
                              {updateProgress.stage === 'done' &&
                                englishErrorMessage(
                                  updateProgress.message,
                                  'Update started.'
                                )}
                              {updateProgress.stage === 'error' &&
                                englishErrorMessage(
                                  updateProgress.message,
                                  'Update failed.'
                                )}
                            </Text>
                            {updateProgress.stage === 'downloading' &&
                              updateProgress.total > 0 && (
                                <Text className="shrink-0 text-[10px] font-mono text-[var(--md-sys-color-on-surface-variant)]">
                                  {formatBytes(updateProgress.received)} /{' '}
                                  {formatBytes(updateProgress.total)}
                                </Text>
                              )}
                          </div>
                          {/* 进度 comments */}
                          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--md-sys-color-surface-container-lowest)]">
                            {updateProgress.stage === 'downloading' ? (
                              updateProgress.total > 0 ? (
                                <div
                                  className="h-full rounded-full bg-[var(--md-sys-color-primary)] transition-all duration-150"
                                  style={{
                                    width: `${Math.min(
                                      100,
                                      (updateProgress.received /
                                        updateProgress.total) *
                                        100
                                    )}%`,
                                  }}
                                />
                              ) : (
                                // 总大小未知时显示不确定进度动画
                                <div className="zen-indeterminate-bar h-full w-1/3 rounded-full bg-[var(--md-sys-color-primary)]" />
                              )
                            ) : (
                              <div
                                className={cn(
                                  'h-full rounded-full transition-all duration-300',
                                  updateProgress.stage === 'done' &&
                                    'w-full bg-[var(--md-sys-color-primary)]',
                                  updateProgress.stage === 'error' &&
                                    'w-full bg-[var(--md-sys-color-error)]',
                                  (updateProgress.stage === 'extracting' ||
                                    updateProgress.stage === 'starting') &&
                                    'w-1/2 bg-[var(--md-sys-color-primary)] zen-indeterminate-bar'
                                )}
                              />
                            )}
                          </div>
                        </div>
                      )}
                      {updateLoading ? (
                        <div className="py-4">
                          <Spinner tip={t('Checking for updates…')} size={24} />
                        </div>
                      ) : updateInfo ? (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between">
                            <Text className="text-sm">
                              {t('Installed version:')}
                              <span className="font-mono text-[var(--md-sys-color-on-surface-variant)]">
                                {updateInfo.currentVersion}
                              </span>
                            </Text>
                            <Text className="text-sm">
                              {t('Available version:')}
                              <span className="font-mono text-[var(--md-sys-color-on-surface-variant)]">
                                {updateInfo.remoteVersion}
                              </span>
                            </Text>
                          </div>
                          {updateInfo.isPrerelease && (
                            <div className="inline-flex rounded-full bg-[var(--md-sys-color-tertiary-container)] px-2 py-0.5">
                              <span className="text-[10px] font-medium uppercase tracking-wide text-[var(--md-sys-color-on-tertiary-container)]">
                                {t('Prerelease')}
                              </span>
                            </div>
                          )}
                          {updateInfo.publishedAt && (
                            <Text type="secondary" className="text-xs">
                              {t('Published:')}
                              {new Date(updateInfo.publishedAt).toLocaleString(
                                getLocale() === 'zh' ? 'zh-CN' : 'en-US'
                              )}
                            </Text>
                          )}
                          {updateInfo.assetSize > 0 && (
                            <Text type="secondary" className="text-xs">
                              {t('Package:')}
                              {updateInfo.assetName} (
                              {(updateInfo.assetSize / (1024 * 1024)).toFixed(
                                1
                              )}
                              MB)
                            </Text>
                          )}
                          {updateInfo.releaseNotes && (
                            <div className="max-h-32 overflow-y-auto rounded-[var(--md-sys-radius-small)] bg-[var(--md-sys-color-surface-container-high)] p-2">
                              <Text className="whitespace-pre-wrap text-xs leading-relaxed">
                                {updateInfo.releaseNotes
                                  .split('\n')
                                  .slice(0, 10)
                                  .join('\n')}
                              </Text>
                            </div>
                          )}
                          <div className="flex flex-wrap items-center gap-2 pt-1">
                            <Button
                              variant="primary"
                              size="sm"
                              icon={<Download className="h-4 w-4" />}
                              onClick={handleApplyUpdate}
                              loading={applyLoading}
                              disabled={applyLoading || !updateInfo.hasUpdate}
                            >
                              {updateInfo.hasUpdate
                                ? t('Install update')
                                : t('Up to date')}
                            </Button>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={checkUpdate}
                              disabled={updateLoading}
                            >
                              {t('Check again')}
                            </Button>
                            {updateInfo.releaseUrl && (
                              <a
                                href={updateInfo.releaseUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="text-xs text-[var(--md-sys-color-primary)] hover:underline"
                              >
                                {t('View release')}
                              </a>
                            )}
                          </div>
                          {/* 分割线 */}
                          <div className="my-2 border-t border-[var(--md-sys-color-outline-variant)]" />
                          {/* 手动导入压缩包 */}
                          <div className="space-y-2">
                            <Text className="text-xs font-medium text-[var(--md-sys-color-on-surface-variant)]">
                              {t('Import update package')}
                            </Text>
                            <div className="flex items-center gap-2">
                              <input
                                ref={fileInputRef}
                                type="file"
                                accept=".zip,.tar.gz"
                                onChange={handleFileUpload}
                                className="hidden"
                              />
                              <Button
                                variant="secondary"
                                size="sm"
                                icon={<Upload className="h-4 w-4" />}
                                onClick={() => fileInputRef.current?.click()}
                                loading={uploadLoading}
                                disabled={uploadLoading}
                              >
                                {t('Choose archive')}
                              </Button>
                              <Text type="secondary" className="text-xs">
                                {t('.zip or .tar.gz archives')}
                              </Text>
                            </div>
                          </div>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          <div className="flex items-center justify-between py-2">
                            <Text type="secondary" className="text-sm">
                              {updateError
                                ? englishErrorMessage(
                                    updateError,
                                    t('Could not check for updates.')
                                  )
                                : t('Version information is unavailable.')}
                            </Text>
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={checkUpdate}
                              disabled={updateLoading}
                            >
                              {t('Check for updates')}
                            </Button>
                          </div>
                          <div className="my-2 border-t border-[var(--md-sys-color-outline-variant)]" />
                          <div className="space-y-2">
                            <Text className="text-xs font-medium text-[var(--md-sys-color-on-surface-variant)]">
                              {t('Import update package')}
                            </Text>
                            <div className="flex items-center gap-2">
                              <input
                                ref={fileInputRef}
                                type="file"
                                accept=".zip,.tar.gz"
                                onChange={handleFileUpload}
                                className="hidden"
                              />
                              <Button
                                variant="secondary"
                                size="sm"
                                icon={<Upload className="h-4 w-4" />}
                                onClick={() => fileInputRef.current?.click()}
                                loading={uploadLoading}
                                disabled={uploadLoading}
                              >
                                {t('Choose archive')}
                              </Button>
                              <Text type="secondary" className="text-xs">
                                {t('.zip or .tar.gz archives')}
                              </Text>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </>
                )}

                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleSaveSettings}
                  loading={savingSettings}
                  disabled={savingSettings}
                >
                  {t('Save')}
                </Button>
              </>
            )}
          </div>
        )}
      </div>

      <ConfirmModal
        open={!!userDelete}
        onClose={() => setUserDelete(null)}
        title={t('Remove user')}
        onOk={handleDeleteUser}
        onCancel={() => setUserDelete(null)}
        okText={t('Remove')}
        cancelText={t('Cancel')}
      >
        {t('Remove user {name}? This cannot be undone.', {
          name: userDelete?.username ?? '',
        })}
      </ConfirmModal>

      <ConfirmModal
        open={!!userApprove}
        onClose={() => setUserApprove(null)}
        title={t('Approve user')}
        onOk={handleApproveUser}
        onCancel={() => setUserApprove(null)}
        okText={t('Approve')}
        cancelText={t('Cancel')}
      >
        {t('Approve {name} as a member? They will be able to sign in.', {
          name: userApprove?.username ?? '',
        })}
      </ConfirmModal>

      <ConfirmModal
        open={!!roomClose}
        onClose={() => setRoomClose(null)}
        title={t('Close room')}
        onOk={handleCloseRoom}
        onCancel={() => setRoomClose(null)}
        okText={t('Close')}
        cancelText={t('Cancel')}
      >
        {t('Close room {id}? All members will be disconnected.', {
          id: roomClose?.roomId ?? '',
        })}
      </ConfirmModal>

      <ConfirmModal
        open={cleanupConfirm}
        onClose={() => {
          if (!cleanupLoading) setCleanupConfirm(false)
        }}
        title={t('Remove empty rooms')}
        onOk={handleCleanupUnusedRooms}
        onCancel={() => setCleanupConfirm(false)}
        okText={t('Confirm')}
        cancelText={t('Cancel')}
        confirmLoading={cleanupLoading}
      >
        {t(
          isRoot
            ? 'Remove all empty rooms? This cannot be undone.'
            : 'Remove your empty rooms? This cannot be undone.'
        )}
      </ConfirmModal>

      <ConfirmModal
        open={batchDeleteConfirm}
        onClose={() => setBatchDeleteConfirm(false)}
        title={t('Remove selected rooms')}
        onOk={handleBatchDeleteRooms}
        onCancel={() => setBatchDeleteConfirm(false)}
        okText={t('Remove')}
        cancelText={t('Cancel')}
        confirmLoading={batchDeleteLoading}
      >
        {t('Remove the selected {count} rooms? This cannot be undone.', {
          count: selectedRoomIds.size,
        })}
      </ConfirmModal>

      <ConfirmModal
        open={deleteAllConfirm}
        onClose={() => setDeleteAllConfirm(false)}
        title={t('Remove all rooms')}
        onOk={handleDeleteAllRooms}
        onCancel={() => setDeleteAllConfirm(false)}
        okText={t('Remove all')}
        cancelText={t('Cancel')}
        confirmLoading={deleteAllLoading}
      >
        {t('Remove all rooms and their saved state? This cannot be undone.')}
      </ConfirmModal>
    </div>
  )
}
