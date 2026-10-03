import { t, useTranslation } from '@/i18n'
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
import { englishErrorMessage } from '@/lib/errorMessage'
import { buildAvatarUrl } from '@/pages/profile/avatarUrl'

export default function ProfilePage() {
  useTranslation()
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
  const [qrMessage, setQrMessage] = useState('Scan with the Bilibili app.')
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
            setQrMessage('Scan with the Bilibili app.')
          } else if (result.status === 1) {
            setQrMessage('Scanned. Confirm in the app.')
          } else if (result.status === 2) {
            setQrMessage('Signed in.')
            setQrModalOpen(false)
            await loadBilibiliUser()
            message.success(t('Signed in to Bilibili.'))
            stopQrPolling()
            return
          } else if (result.status === 3) {
            setQrMessage('This code expired. Generate a new one.')
            stopQrPolling()
            return
          }
          pollTimerRef.current = setTimeout(poll, 2000)
        } catch (err) {
          console.error('[ProfilePage] QR poll error:', err)
          qrRetryCountRef.current += 1
          if (qrRetryCountRef.current <= 2) {
            setQrMessage('Could not check the code. Retrying…')
            pollTimerRef.current = setTimeout(poll, 2000)
          } else {
            setQrMessage('Could not check the code. Generate a new one.')
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
    setQrMessage('Scan with the Bilibili app.')
    setQrDataUrl('')
    setQrModalOpen(true)
    try {
      const data = await getBilibiliQrCode()
      setQrDataUrl(data.qrDataUrl)
      void startQrPolling(data.qrcodeKey)
    } catch (err) {
      message.error(englishErrorMessage(err, 'Could not generate a code.'))
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
      message.success(t('Signed out of Bilibili.'))
    } catch {
      message.error(t('Could not sign out of Bilibili.'))
    }
  }, [])

  const handleCookieLogin = useCallback(async () => {
    const trimmed = cookieInput.trim()
    if (!trimmed) {
      message.warning(t('Paste your cookie.'))
      return
    }
    setCookieLoading(true)
    try {
      await loginBilibiliWithCookie(trimmed)
      message.success(t('Signed in to Bilibili.'))
      setCookieModalOpen(false)
      setCookieInput('')
      await loadBilibiliUser()
    } catch (err) {
      message.error(englishErrorMessage(err, 'Cookie sign-in failed.'))
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
        <Spinner tip={t('Loading your account…')} />
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
              src={buildAvatarUrl(user.avatar)}
              className="h-16 w-16 shrink-0"
            />
            <div className="min-w-0">
              <h1>{t('Your account')}</h1>
              <p className="tongmu-space__identity-meta">
                <strong>{user.username}</strong>
                <span aria-hidden="true"> · </span>
                {t('User ID:')}
                {user.id} · {isAdmin ? t('Administrator') : t('Member')}
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
              {t('Edit profile & security')}
            </Button>
          </div>
        </header>

        <section
          className="tongmu-space__section"
          aria-labelledby="media-title"
        >
          <div className="tongmu-space__heading">
            <h2 id="media-title">{t('Your sources')}</h2>
            <p>
              {t(
                'Connect Bilibili and your personal media sources. Only content you select is shared with a room.'
              )}
            </p>
          </div>
          <div className="tongmu-space__surface tongmu-space__bilibili">
            <div className="tongmu-space__surface-title">
              <Tv className="h-4 w-4" />
              <h3>{t('Bilibili account')}</h3>
            </div>
            {bilibiliLoading ? (
              <div className="py-4">
                <Spinner tip={t('Loading…')} size={28} />
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
                      </div>
                      <p className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
                        {t('Bilibili connected')}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="hidden text-xs text-[var(--md-sys-color-on-surface-variant)] sm:inline">
                      {t(
                        'Credentials stay on the server and cannot be exported.'
                      )}
                    </span>
                    <Button
                      variant="danger"
                      size="sm"
                      className="w-8 justify-center px-0"
                      icon={<LogOut className="h-4 w-4" />}
                      onClick={handleLogoutBilibili}
                      title={t('Disconnect Bilibili')}
                      aria-label={t('Disconnect')}
                    />
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <Paragraph type="secondary" className="m-0 text-sm">
                  {t('Bilibili is not connected')}
                </Paragraph>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<QrCode className="h-4 w-4" />}
                    onClick={handleOpenQrModal}
                  >
                    {t('Connect with QR code')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<Cookie className="h-4 w-4" />}
                    onClick={() => setCookieModalOpen(true)}
                  >
                    {t('Sign in with cookie')}
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
                    {t('Download a Bilibili video')}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<RefreshCw className="h-4 w-4" />}
                  onClick={() => void loadBilibiliUser()}
                >
                  {t('Refresh account')}
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
              <h2 id="server-files-title">{t('Server files')}</h2>
              <p>{t('Available to the root administrator.')}</p>
            </div>
            <ServerFileManager showHeading={false} />
          </section>
        )}
      </div>

      {/* Bilibili videoDownload Popup（root 限定，Optional features） */}
      {user?.role === 'root' && betaFeaturesEnabled && (
        <BilibiliDownloadModal
          open={biliDownloadOpen}
          onClose={() => setBiliDownloadOpen(false)}
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
              className="glass rounded-lg flex items-center justify-center"
              style={{
                width: 200,
                height: 200,
              }}
            >
              <Spinner tip={t('Generating a code…')} size={28} />
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
            {t(qrMessage)}
          </Paragraph>
          {qrStatus === 3 && (
            <Button variant="primary" size="sm" onClick={handleOpenQrModal}>
              {t('Generate a new code')}
            </Button>
          )}
        </div>
      </Modal>

      {/* Sign in with cookie Modal */}
      <Modal
        open={cookieModalOpen}
        onClose={handleCloseCookieModal}
        title={t('Connect Bilibili with a cookie')}
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={handleCloseCookieModal}
              disabled={cookieLoading}
            >
              {t('Cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={handleCookieLogin}
              disabled={cookieLoading || !cookieInput.trim()}
            >
              {cookieLoading ? t('Checking…') : t('Sign in')}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <Paragraph type="secondary" className="m-0 text-xs leading-relaxed">
            {t('1. Sign in to bilibili.com in your browser.')}
            <br />
            {t('2. Open developer tools → Application → Cookies.')}
            <br />
            {t('3. Copy the cookies, including SESSDATA.')}
          </Paragraph>
          <textarea
            value={cookieInput}
            onChange={(e) => setCookieInput(e.target.value)}
            placeholder="SESSDATA=…; bili_jct=…; DedeUserID=…"
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
