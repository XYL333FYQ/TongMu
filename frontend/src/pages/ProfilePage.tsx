import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  QrCode,
  LogOut,
  Tv,
  RefreshCw,
  Pencil,
  Crown,
  Download,
  Cookie,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Avatar } from '@/components/ui/Avatar'
import { Modal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { Tag } from '@/components/ui/Tag'
import { Paragraph } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { useAuthStore } from '@/store/authStore'
import { useSystemSettingsStore } from '@/store/systemSettingsStore'
import {
  getBilibiliQrCode,
  pollBilibiliQrCode,
  getBilibiliUserInfo,
  logoutBilibili,
  loginBilibiliWithCookie,
  buildBilibiliImageProxyUrl,
  type BilibiliUserInfo,
} from '@/modules/room/watch-together/resolveSource'
import MountManager from '@/modules/mounts/MountManager'
import ServerFileManager from '@/modules/server-files/ServerFileManager'
import { BilibiliDownloadModal } from '@/modules/server-files/BilibiliDownloadModal'
import { AccountEditor } from '@/pages/profile/AccountEditor'
import { buildAvatarUrl } from '@/pages/profile/avatarUrl'

export default function ProfilePage() {
  const navigate = useNavigate()
  const location = useLocation()
  const user = useAuthStore((state) => state.user)
  const { betaFeaturesEnabled } = useSystemSettingsStore()

  useEffect(() => {
    if (user?.role === 'guest') {
      navigate('/', { replace: true })
    }
  }, [user, navigate])

  useEffect(() => {
    if (location.hash !== '#preferences') return

    // Legacy bookmarks open the single appearance menu in the global header.
    const timer = window.setTimeout(() => {
      window.dispatchEvent(new Event('tongmu:open-appearance'))
    }, 0)
    return () => window.clearTimeout(timer)
  }, [location.hash])

  const [bilibiliUser, setBilibiliUser] = useState<BilibiliUserInfo | null>(
    null
  )
  const [bilibiliLoading, setBilibiliLoading] = useState(true)
  const [qrModalOpen, setQrModalOpen] = useState(false)
  const [qrDataUrl, setQrDataUrl] = useState('')
  const [qrStatus, setQrStatus] = useState(0)
  const [qrMessage, setQrMessage] = useState('请使用哔哩哔哩 App 扫码登录')
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isPollingRef = useRef(false)
  const qrRetryCountRef = useRef(0)

  // Cookie 登录
  const [cookieModalOpen, setCookieModalOpen] = useState(false)
  const [cookieInput, setCookieInput] = useState('')
  const [cookieLoading, setCookieLoading] = useState(false)

  // B站视频下载 Popup（root 限定，位于「刷新绑定状态」旁）
  const [biliDownloadOpen, setBiliDownloadOpen] = useState(false)

  const [editInfoModalOpen, setEditInfoModalOpen] = useState(false)

  const loadBilibiliUser = useCallback(async () => {
    const info = await getBilibiliUserInfo()
    setBilibiliUser(info)
  }, [])

  useEffect(() => {
    let mounted = true
    const load = async () => {
      const info = await getBilibiliUserInfo()
      if (!mounted) return
      setBilibiliUser(info)
      setBilibiliLoading(false)
    }
    void load()
    return () => {
      mounted = false
    }
  }, [])

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
            setQrMessage('请使用哔哩哔哩 App 扫码登录')
          } else if (result.status === 1) {
            setQrMessage('已扫码，请在 App 中确认登录')
          } else if (result.status === 2) {
            setQrMessage('登录成功')
            setQrModalOpen(false)
            await loadBilibiliUser()
            message.success('B站 登录成功')
            stopQrPolling()
            return
          } else if (result.status === 3) {
            setQrMessage('二维码已过期，请重新获取')
            stopQrPolling()
            return
          }
          pollTimerRef.current = setTimeout(poll, 2000)
        } catch (err) {
          console.error('[ProfilePage] QR poll error:', err)
          qrRetryCountRef.current += 1
          if (qrRetryCountRef.current <= 2) {
            setQrMessage('轮询状态失败，正在重试…')
            pollTimerRef.current = setTimeout(poll, 2000)
          } else {
            setQrMessage('轮询状态失败，请重新获取')
            stopQrPolling()
          }
        }
      }

      void poll()
    },
    [loadBilibiliUser, stopQrPolling]
  )

  const handleOpenQrModal = useCallback(async () => {
    stopQrPolling()
    setQrStatus(0)
    setQrMessage('请使用哔哩哔哩 App 扫码登录')
    setQrDataUrl('')
    setQrModalOpen(true)
    try {
      const data = await getBilibiliQrCode()
      setQrDataUrl(data.qrDataUrl)
      void startQrPolling(data.qrcodeKey)
    } catch (err) {
      message.error(err instanceof Error ? err.message : '获取二维码失败')
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
      setBilibiliUser(null)
      message.success('已退出 B站 登录')
    } catch {
      message.error('退出 B站 登录失败')
    }
  }, [])

  const handleCookieLogin = useCallback(async () => {
    const trimmed = cookieInput.trim()
    if (!trimmed) {
      message.warning('请输入 Cookie')
      return
    }
    setCookieLoading(true)
    try {
      await loginBilibiliWithCookie(trimmed)
      message.success('B站 Cookie 登录成功')
      setCookieModalOpen(false)
      setCookieInput('')
      await loadBilibiliUser()
    } catch (err) {
      message.error(err instanceof Error ? err.message : 'Cookie 登录失败')
    } finally {
      setCookieLoading(false)
    }
  }, [cookieInput, loadBilibiliUser])

  const handleCloseCookieModal = useCallback(() => {
    setCookieModalOpen(false)
    setCookieInput('')
  }, [])

  useEffect(() => {
    return () => {
      stopQrPolling()
    }
  }, [stopQrPolling])

  if (!user) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <Spinner tip="加载用户信息..." />
      </div>
    )
  }

  const isAdmin = user.role === 'admin' || user.role === 'root'

  return (
    <div className="tongmu-profile-page hide-scrollbar overflow-y-auto p-4 sm:p-6">
      <div className="tongmu-profile-page__content tongmu-space mx-auto w-full">
        <header className="tongmu-space__intro">
          <div className="tongmu-space__identity">
            <Avatar
              size="lg"
              alt={user.username}
              src={buildAvatarUrl(user.avatar, user.role)}
              className="h-16 w-16 shrink-0"
            />
            <div className="min-w-0">
              <h1>我的空间</h1>
              <p className="tongmu-space__identity-meta">
                <strong>{user.username}</strong>
                <span aria-hidden="true"> · </span>
                用户 ID: {user.id} · {isAdmin ? '管理员' : '普通用户'}
              </p>
            </div>
          </div>
          <div className="tongmu-space__actions">
            <Button
              variant="secondary"
              size="sm"
              icon={<Pencil className="h-4 w-4" />}
              onClick={() => setEditInfoModalOpen(true)}
            >
              编辑资料与安全
            </Button>
          </div>
        </header>

        <section
          className="tongmu-space__section"
          aria-labelledby="media-title"
        >
          <div className="tongmu-space__heading">
            <h2 id="media-title">媒体资源</h2>
            <p>连接你的 B站账号和私人媒体来源。</p>
          </div>
          <div className="tongmu-space__surface tongmu-space__bilibili">
            <div className="tongmu-space__surface-title">
              <Tv className="h-4 w-4" />
              <h3>B站账号</h3>
            </div>
            {bilibiliLoading ? (
              <div className="py-4">
                <Spinner tip="加载中..." size={28} />
              </div>
            ) : bilibiliUser ? (
              <div className="space-y-3">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <Avatar
                      size="md"
                      src={buildBilibiliImageProxyUrl(bilibiliUser.avatar)}
                      alt={bilibiliUser.name}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <p className="min-w-0 truncate text-base font-medium text-[var(--md-sys-color-on-surface)]">
                          {bilibiliUser.name}
                        </p>
                        {bilibiliUser.vipStatus === 1 ? (
                          <Tag
                            color="warning"
                            className="shrink-0 px-1.5 py-0 text-[10px]"
                          >
                            <Crown className="mr-0.5 h-3 w-3" />
                            大会员
                          </Tag>
                        ) : (
                          <Tag
                            color="default"
                            className="shrink-0 px-1.5 py-0 text-[10px]"
                          >
                            普通账号
                          </Tag>
                        )}
                      </div>
                      <p className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
                        已绑定 B站 账号
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="hidden text-xs text-[var(--md-sys-color-on-surface-variant)] sm:inline">
                      凭据已安全保存，不支持导出 Cookie
                    </span>
                    <Button
                      variant="danger"
                      size="sm"
                      className="w-8 justify-center px-0"
                      icon={<LogOut className="h-4 w-4" />}
                      onClick={handleLogoutBilibili}
                      title="退出 B站 登录"
                      aria-label="退登"
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <Paragraph type="secondary" className="m-0 text-sm">
                  未绑定 B站 账号
                </Paragraph>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<QrCode className="h-4 w-4" />}
                    onClick={handleOpenQrModal}
                  >
                    扫码登录 B站
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Cookie className="h-4 w-4" />}
                    onClick={() => setCookieModalOpen(true)}
                  >
                    Cookie 登录
                  </Button>
                </div>
              </div>
            )}
            {!bilibiliLoading && bilibiliUser && (
              <div className="tongmu-space__bilibili-actions">
                {user.role === 'root' && betaFeaturesEnabled && (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Download className="h-4 w-4" />}
                    onClick={() => setBiliDownloadOpen(true)}
                  >
                    下载 B站视频
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<RefreshCw className="h-4 w-4" />}
                  onClick={() => void loadBilibiliUser()}
                >
                  刷新绑定状态
                </Button>
              </div>
            )}
          </div>
          <MountManager />
        </section>

        {user.role === 'root' && (
          <section
            className="tongmu-space__section"
            aria-labelledby="server-files-title"
          >
            <div className="tongmu-space__heading">
              <h2 id="server-files-title">服务器文件管理</h2>
              <p>仅 root 账号可访问。</p>
            </div>
            <ServerFileManager />
          </section>
        )}
      </div>

      {/* B站视频下载 Popup（root 限定，Beta 功能） */}
      {user?.role === 'root' && betaFeaturesEnabled && (
        <BilibiliDownloadModal
          open={biliDownloadOpen}
          onClose={() => setBiliDownloadOpen(false)}
        />
      )}

      <Modal
        open={qrModalOpen}
        onClose={handleCloseQrModal}
        title="扫码登录哔哩哔哩"
        footer={
          <Button variant="secondary" size="sm" onClick={handleCloseQrModal}>
            关闭
          </Button>
        }
      >
        <div className="flex flex-col items-center gap-4">
          {qrDataUrl ? (
            <img
              src={qrDataUrl}
              alt="哔哩哔哩登录二维码"
              className="rounded-lg border"
              style={{
                width: 200,
                height: 200,
                borderColor: 'var(--md-sys-color-outline-variant)',
              }}
            />
          ) : (
            <div
              className="glass rounded-lg flex items-center justify-center"
              style={{
                width: 200,
                height: 200,
              }}
            >
              <Spinner tip="正在生成二维码…" size={28} />
            </div>
          )}
          <Paragraph
            className={`m-0 text-sm ${
              qrStatus === 2
                ? 'text-[var(--md-sys-color-secondary)]'
                : qrStatus === 3
                  ? 'text-[var(--md-sys-color-error)]'
                  : ''
            }`}
          >
            {qrMessage}
          </Paragraph>
          {qrStatus === 3 && (
            <Button variant="primary" size="sm" onClick={handleOpenQrModal}>
              重新获取二维码
            </Button>
          )}
        </div>
      </Modal>

      {/* Cookie 登录 Modal */}
      <Modal
        open={cookieModalOpen}
        onClose={handleCloseCookieModal}
        title="Cookie 登录哔哩哔哩"
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleCloseCookieModal}
              disabled={cookieLoading}
            >
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleCookieLogin}
              disabled={cookieLoading || !cookieInput.trim()}
            >
              {cookieLoading ? '验证中...' : '登录'}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <Paragraph type="secondary" className="m-0 text-xs leading-relaxed">
            1. 在浏览器中登录 bilibili.com
            <br />
            2. 按 F12 打开开发者工具 → Application → Cookies
            <br />
            3. 复制全部 Cookie（至少需包含 SESSDATA）
          </Paragraph>
          <textarea
            value={cookieInput}
            onChange={(e) => setCookieInput(e.target.value)}
            placeholder="粘贴 B站 Cookie，如：SESSDATA=xxx; bili_jct=xxx; DedeUserID=xxx"
            rows={5}
            className="w-full resize-none rounded-[var(--md-sys-shape-corner)] border bg-[var(--md-sys-color-surface-container)] px-3 py-2 text-sm text-[var(--md-sys-color-on-surface)] placeholder:text-[var(--md-sys-color-on-surface-variant)] focus:outline-none focus:ring-1 focus:ring-[var(--md-sys-color-primary)]"
            style={{
              borderColor: 'var(--md-sys-color-outline-variant)',
            }}
            disabled={cookieLoading}
          />
        </div>
      </Modal>

      {editInfoModalOpen && (
        <AccountEditor
          user={user}
          onClose={() => setEditInfoModalOpen(false)}
        />
      )}
    </div>
  )
}
