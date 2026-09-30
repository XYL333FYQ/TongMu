import { useState, useRef, useEffect, useCallback } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { createPortal } from 'react-dom'
import {
  LogOut,
  LogIn,
  ShieldAlert,
  Info,
  ChevronDown,
  Download,
  Server,
  Search,
  Shield,
  UserRound,
} from 'lucide-react'
// lucide-react 没有导出 Github，使用自定义 SVG
const GithubIcon = ({ className }: { className?: string }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="24"
    height="24"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
  >
    <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
    <path d="M9 18c-4.51 2-5-2-7-2" />
  </svg>
)
import { useAuthStore } from '@/store/authStore'
import {
  apiFetch,
  getCustomApiUrl,
  setCustomApiUrl,
  getCustomSocketUrl,
  setCustomSocketUrl,
  getCustomFlvBaseUrl,
  setCustomFlvBaseUrl,
  getCustomRtmpPort,
  setCustomRtmpPort,
  getApiUrl,
  getSocketUrl,
  getFlvBaseUrl,
  getRtmpPort,
  clearAuthTokens,
  resetSessionExpired,
} from '@/lib/api'
import { resetSocket, reconnectSocket } from '@/hooks/useSocket'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { message } from '@/components/ui/message'
import { Avatar } from '@/components/ui/Avatar'
import { ReturnToRoomButton } from '@/components/ReturnToRoomButton'
import { cn } from '@/lib/utils'
import { useRoomExitGuard } from '@/hooks/useRoomExitGuard'
import { AppNavigation } from './AppNavigation'
import { AppearanceMenu } from './AppearanceMenu'
import { JoinRoomDialog } from './JoinRoomDialog'

export function Header() {
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const { guardNavigate, confirmModal: exitGuardModal } = useRoomExitGuard()
  const { user, logout, isAuthenticated } = useAuthStore()
  const [searchDraft, setSearchDraft] = useState<{
    locationKey: string
    value: string
  }>({ locationKey: '', value: '' })
  const useRouteSearch = location.pathname === '/rooms'
  const searchValue = useRouteSearch
    ? (searchParams.get('q') ?? '')
    : searchDraft.locationKey === location.key
      ? searchDraft.value
      : ''
  const [userOpen, setUserOpen] = useState(false)
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false)
  const [joinOpen, setJoinOpen] = useState(false)
  const [userClosing, setUserClosing] = useState(false)
  const [serverModalOpen, setServerModalOpen] = useState(false)
  const [customApiUrl, setCustomApiUrlState] = useState(getCustomApiUrl())
  const [customSocketUrl, setCustomSocketUrlState] =
    useState(getCustomSocketUrl())
  const [customFlvBaseUrl, setCustomFlvBaseUrlState] = useState(
    getCustomFlvBaseUrl()
  )
  const [customRtmpPort, setCustomRtmpPortState] = useState(getCustomRtmpPort())

  // 打开「自定义后端地址」弹窗时从 localStorage 重新同步，
  // 避免同一页面会话中保存后再次打开仍显示旧值。
  const openServerModal = useCallback(() => {
    setCustomApiUrlState(getCustomApiUrl())
    setCustomSocketUrlState(getCustomSocketUrl())
    setCustomFlvBaseUrlState(getCustomFlvBaseUrl())
    setCustomRtmpPortState(getCustomRtmpPort())
    setServerModalOpen(true)
  }, [])

  // 混合内容检测：HTTPS 页面 → HTTP 后端（浏览器会阻止此类请求）
  const isApiHttp = customApiUrl.startsWith('http://')
  const isSocketHttp = customSocketUrl.startsWith('http://')
  const isHttpsPage =
    typeof window !== 'undefined' && window.location.protocol === 'https:'
  const hasMixedContent = isHttpsPage && (isApiHttp || isSocketHttp)

  // 按钮与菜单分别 ref：菜单通过 createPortal 渲染到 document.body，
  // 脱离 Header(fixed + backdrop-filter) 的合成层，使二级菜单的 backdrop-filter 能看到真实页面内容。
  const userBtnRef = useRef<HTMLButtonElement>(null)
  const userMenuRef = useRef<HTMLDivElement>(null)
  const [userMenuPos, setUserMenuPos] = useState<{
    top: number
    right: number
  } | null>(null)

  const closeUser = () => {
    setUserClosing(true)
    const timer = setTimeout(() => {
      setUserOpen(false)
      setUserClosing(false)
      setUserMenuPos(null)
    }, 200)
    return () => clearTimeout(timer)
  }

  const computeUserPos = useCallback(() => {
    if (!userBtnRef.current) return
    const rect = userBtnRef.current.getBoundingClientRect()
    setUserMenuPos({
      top: rect.bottom + 8,
      right: window.innerWidth - rect.right,
    })
  }, [])

  // 菜单打开时计算位置，并监听 resize/scroll 保持对齐
  useEffect(() => {
    if (!userOpen) return
    computeUserPos()
    const handler = () => computeUserPos()
    window.addEventListener('resize', handler)
    window.addEventListener('scroll', handler, true)
    return () => {
      window.removeEventListener('resize', handler)
      window.removeEventListener('scroll', handler, true)
    }
  }, [userOpen, computeUserPos])

  // 外部点击检测：按钮和菜单（portal 渲染）都不算外部
  useEffect(() => {
    if (!userOpen) return
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        userBtnRef.current?.contains(target) ||
        userMenuRef.current?.contains(target)
      ) {
        return
      }
      closeUser()
    }
    window.addEventListener('mousedown', handleClick)
    return () => window.removeEventListener('mousedown', handleClick)
  }, [userOpen])

  const handleLogout = async () => {
    setUserOpen(false)
    try {
      // 调用后端清除 httpOnly cookie（access_token / refresh_token）
      await apiFetch('/api/auth/logout', {
        method: 'POST',
      })
    } catch (err) {
      // 后端调用失败也继续登出前端状态，避免用户卡在已登录状态
      console.warn('[Header] logout API failed:', err)
      message.error('退出登录请求失败，已强制清除本地状态')
    } finally {
      // 清除本地 Bearer token（跨站 HTTP fallback）
      clearAuthTokens()
      // 重置 session 过期标志，允许后续 onConnectError 中的 refresh 尝试
      resetSessionExpired()
      logout()
      // 登出后必须重连 socket：旧连接仍持有已失效的 root 凭据，
      // 重连后 buildSocketAuth() 返回空载荷 → 服务端拒绝 →
      // onConnectError 处理器自动降级为 guest token
      reconnectSocket()
    }
  }

  const handleDownloadCli = useCallback(() => {
    const ua = navigator.userAgent.toLowerCase()
    const isWindows = /windows nt|win32|win64/.test(ua)
    const isMac = /macintosh|mac os x/.test(ua)
    const isLinux = /linux/.test(ua)
    if (isWindows) {
      const a = document.createElement('a')
      a.href = '/zviewer-cli-windows-amd64.exe'
      a.download = 'zviewer-cli-windows-amd64.exe'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } else if (isMac || isLinux) {
      window.open(
        'https://github.com/Zero-wyc/ZViewerCLI',
        '_blank',
        'noopener,noreferrer'
      )
    } else {
      message.info(
        '请前往 https://github.com/Zero-wyc/ZViewerCLI 下载对应版本 CLI'
      )
    }
  }, [])

  const menuItems: {
    icon: React.ReactNode
    label: string
    to?: string
    onClick?: () => void
  }[] = [
    ...(user && user.role !== 'guest'
      ? [
          {
            icon: <UserRound className="w-4 h-4" />,
            label: '我的空间',
            to: '/profile',
          },
        ]
      : []),
    ...(user?.role === 'root' || user?.role === 'admin'
      ? [
          {
            icon: <Shield className="w-4 h-4" />,
            label: '管理后台',
            to: '/admin',
          },
        ]
      : []),
    {
      icon: <Server className="w-4 h-4" />,
      label: '服务器连接',
      onClick: openServerModal,
    },
    {
      icon: <Download className="w-4 h-4" />,
      label: '下载 CLI 高画质代理',
      onClick: handleDownloadCli,
    },
    {
      icon: <GithubIcon className="w-4 h-4" />,
      label: '开源项目',
      onClick: () =>
        window.open(
          'https://github.com/XYL333FYQ/TongMu',
          '_blank',
          'noopener,noreferrer'
        ),
    },
  ]

  return (
    <>
      <header className="glass app-header tongmu-header fixed top-0 left-0 right-0 z-50 px-4 sm:px-8 xl:px-10">
        <div className="tongmu-header__inner">
          <div className="flex min-w-0 items-center gap-2">
            <button
              aria-label="返回大厅"
              onClick={() => guardNavigate('/')}
              className="relative z-50 flex w-fit min-w-0 items-center gap-2 cursor-pointer"
            >
              <img
                src="/favicon.jpg"
                alt="TongMu"
                className="w-8 h-8 shrink-0 rounded-[var(--md-sys-shape-corner)] object-cover"
              />
              <span className="hidden md:inline font-semibold text-base text-[var(--md-sys-color-on-surface)]">
                TongMu
              </span>
            </button>
            <AppNavigation
              key={location.pathname}
              onNavigate={guardNavigate}
              onJoin={() => setJoinOpen(true)}
            />
          </div>

          <form
            role="search"
            className="tongmu-header__search relative hidden w-full md:block"
            onSubmit={(event) => {
              event.preventDefault()
              const query = searchValue.trim()
              const target = `/rooms${query ? `?q=${encodeURIComponent(query)}` : ''}`
              if (target !== location.pathname + location.search) {
                guardNavigate(target)
              }
            }}
          >
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--md-sys-color-on-surface-variant)]"
            />
            <Input
              aria-label="搜索房间"
              placeholder="搜索房间名称或房间号"
              value={searchValue}
              onChange={(event) => {
                const value = event.target.value
                setSearchDraft({ locationKey: location.key, value })
                if (useRouteSearch) {
                  const next = new URLSearchParams(searchParams)
                  if (value) next.set('q', value)
                  else next.delete('q')
                  setSearchParams(next, { replace: true })
                }
              }}
              className="tongmu-header__search-input h-10 text-sm"
            />
          </form>

          <div className="tongmu-header__actions flex items-center justify-self-end gap-2">
            <ReturnToRoomButton />
            <button
              type="button"
              aria-label="搜索房间"
              className="tongmu-header__mobile-search md:hidden"
              onClick={() => setMobileSearchOpen(true)}
            >
              <Search className="h-5 w-5" aria-hidden="true" />
            </button>
            <AppearanceMenu />
            {isAuthenticated && user && (
              <div className="relative">
                <button
                  ref={userBtnRef}
                  onClick={() => {
                    if (userOpen) {
                      closeUser()
                    } else {
                      setUserOpen(true)
                      setUserClosing(false)
                    }
                  }}
                  className={cn(
                    'flex items-center gap-2 pl-2 pr-2.5 py-1.5 rounded-[var(--md-sys-shape-corner)] transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]',
                    userOpen
                      ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                      : 'bg-[var(--glass-bg)] text-[var(--md-sys-color-on-surface)]'
                  )}
                  style={{
                    border: '1px solid var(--md-sys-color-outline)',
                  }}
                  title="账户菜单"
                >
                  <Avatar
                    size="sm"
                    alt={user.username}
                    src={
                      user.avatar
                        ? user.avatar
                        : user.role === 'root'
                          ? '/root-avatar.jpg'
                          : undefined
                    }
                  />
                  <span className="hidden xl:inline text-xs font-medium max-w-[4rem] truncate">
                    {user.username}
                  </span>
                  <ChevronDown
                    className={cn(
                      'hidden sm:block w-3.5 h-3.5 transition-transform duration-200',
                      userOpen && 'rotate-180'
                    )}
                  />
                </button>

                {userOpen &&
                  userMenuPos &&
                  createPortal(
                    <div
                      ref={userMenuRef}
                      className={cn(
                        'glass-strong fixed w-52 rounded-[var(--md-sys-shape-corner)] p-1.5 shadow-lg',
                        userClosing ? 'zen-dropdown-exit' : 'zen-dropdown-enter'
                      )}
                      style={{
                        top: `${userMenuPos.top}px`,
                        right: `${userMenuPos.right}px`,
                        zIndex: 50,
                        boxShadow:
                          '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-primary) 25%, transparent)',
                      }}
                    >
                      <div
                        className="zen-dropdown-item flex items-center gap-2 px-2.5 py-2 rounded-[var(--md-sys-shape-corner)]"
                        style={
                          {
                            backgroundColor: 'var(--glass-bg)',
                            '--item-delay': '0ms',
                          } as React.CSSProperties
                        }
                      >
                        <Avatar
                          size="md"
                          alt={user.username}
                          src={
                            user.avatar
                              ? user.avatar
                              : user.role === 'root'
                                ? '/root-avatar.jpg'
                                : undefined
                          }
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-[var(--md-sys-color-on-surface)] truncate">
                            {user.username}
                          </p>
                          <p className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
                            {user.role === 'root'
                              ? '超级管理员'
                              : user.role === 'admin'
                                ? '管理员'
                                : user.role === 'guest'
                                  ? '访客'
                                  : '普通用户'}
                          </p>
                        </div>
                      </div>

                      <div
                        className="h-px mx-1 my-1.5"
                        style={{
                          backgroundColor:
                            'color-mix(in srgb, var(--md-sys-color-outline) 40%, transparent)',
                        }}
                      />

                      {menuItems.map((item, idx) => {
                        const content = (
                          <>
                            <span className="text-[var(--md-sys-color-on-surface-variant)]">
                              {item.icon}
                            </span>
                            {item.label}
                          </>
                        )
                        const className =
                          'zen-dropdown-item flex items-center gap-2.5 w-full px-2.5 py-2 rounded-[var(--md-sys-shape-corner)] text-sm text-[var(--md-sys-color-on-surface)] transition-all hover:bg-[var(--md-sys-color-surface-container-highest)] hover:translate-x-0.5'
                        const itemStyle = {
                          '--item-delay': `${(idx + 1) * 50}ms`,
                        } as React.CSSProperties
                        return (
                          <button
                            key={item.label}
                            onClick={() => {
                              setUserOpen(false)
                              if (item.to) {
                                guardNavigate(item.to)
                              } else {
                                item.onClick?.()
                              }
                            }}
                            className={className}
                            style={itemStyle}
                          >
                            {content}
                          </button>
                        )
                      })}

                      <div
                        className="h-px mx-1 my-1.5"
                        style={{
                          backgroundColor:
                            'color-mix(in srgb, var(--md-sys-color-outline) 40%, transparent)',
                        }}
                      />

                      {user.role === 'guest' ? (
                        <button
                          onClick={() => {
                            setUserOpen(false)
                            guardNavigate('/login')
                          }}
                          className="zen-dropdown-item flex items-center gap-2.5 w-full px-2.5 py-2 rounded-[var(--md-sys-shape-corner)] text-sm text-[var(--md-sys-color-primary)] transition-all hover:bg-[var(--md-sys-color-primary-container)] hover:translate-x-0.5"
                          style={
                            {
                              '--item-delay': `${(menuItems.length + 1) * 50}ms`,
                            } as React.CSSProperties
                          }
                        >
                          <LogIn className="w-4 h-4" />
                          登录
                        </button>
                      ) : (
                        <button
                          onClick={handleLogout}
                          className="zen-dropdown-item flex items-center gap-2.5 w-full px-2.5 py-2 rounded-[var(--md-sys-shape-corner)] text-sm text-[var(--md-sys-color-error)] transition-all hover:bg-[var(--md-sys-color-error-container)] hover:translate-x-0.5"
                          style={
                            {
                              '--item-delay': `${(menuItems.length + 1) * 50}ms`,
                            } as React.CSSProperties
                          }
                        >
                          <LogOut className="w-4 h-4" />
                          退出登录
                        </button>
                      )}
                    </div>,
                    document.body
                  )}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* 顶部占位，避免内容被 fixed header 遮挡 */}
      <div className="tongmu-header__spacer" />

      <JoinRoomDialog
        open={joinOpen}
        onClose={() => setJoinOpen(false)}
        onJoin={guardNavigate}
      />

      <Modal
        open={mobileSearchOpen}
        onClose={() => setMobileSearchOpen(false)}
        title="搜索房间"
        footer={null}
      >
        <form
          className="tongmu-header__mobile-search-form"
          onSubmit={(event) => {
            event.preventDefault()
            const query = searchValue.trim()
            setMobileSearchOpen(false)
            const target = `/rooms${query ? `?q=${encodeURIComponent(query)}` : ''}`
            if (target !== location.pathname + location.search) {
              guardNavigate(target)
            }
          }}
        >
          <Input
            autoFocus
            aria-label="搜索房间名称或房间号"
            placeholder="搜索房间名称或房间号"
            value={searchValue}
            onChange={(event) => {
              const value = event.target.value
              setSearchDraft({ locationKey: location.key, value })
              if (useRouteSearch) {
                const next = new URLSearchParams(searchParams)
                if (value) next.set('q', value)
                else next.delete('q')
                setSearchParams(next, { replace: true })
              }
            }}
          />
          <Button type="submit" variant="primary">
            搜索
          </Button>
        </form>
      </Modal>

      <Modal
        open={serverModalOpen}
        onClose={() => setServerModalOpen(false)}
        title="自定义后端地址"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setServerModalOpen(false)}
            >
              取消
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setCustomApiUrl(customApiUrl)
                setCustomSocketUrl(customSocketUrl)
                setCustomFlvBaseUrl(customFlvBaseUrl)
                setCustomRtmpPort(customRtmpPort)
                // 地址变化后，旧的 socket 实例仍指向原 SOCKET_URL，强制重建。
                resetSocket()
                if (hasMixedContent) {
                  message.warning(
                    '已保存，但 HTTPS 页面无法访问 HTTP 后端。请配置反向代理或后端 HTTPS。'
                  )
                } else {
                  message.success('后端地址已保存，即将刷新页面生效')
                }
                setServerModalOpen(false)
                // 刷新页面确保所有模块级 API_URL 缓存重新计算
                setTimeout(() => window.location.reload(), 600)
              }}
            >
              保存
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div
            className="rounded-lg p-3"
            style={{
              backgroundColor: 'var(--md-sys-color-surface-container-high)',
            }}
          >
            <div className="flex items-start gap-2">
              <Info className="mt-0.5 h-4 w-4 shrink-0 text-[var(--md-sys-color-primary)]" />
              <div className="space-y-1.5 text-xs leading-relaxed text-[var(--md-sys-color-on-surface-variant)]">
                <p className="font-medium text-[var(--md-sys-color-on-surface)]">
                  只需填写一个域名即可
                </p>
                <p>
                  填写你的服务器域名（例如{' '}
                  <code className="rounded bg-[var(--md-sys-color-surface-container)] px-1 py-0.5">
                    example.com
                  </code>
                  ），其余三项留空将自动跟随。请确保已在服务器上配置反向代理（Nginx
                  / Caddy），将以下路径统一转发到后端服务：
                </p>
                <ul className="ml-1 list-inside list-disc space-y-0.5">
                  <li>
                    <code className="rounded bg-[var(--md-sys-color-surface-container)] px-1 py-0.5">
                      /api/*
                    </code>{' '}
                    → REST API（端口 3333）
                  </li>
                  <li>
                    <code className="rounded bg-[var(--md-sys-color-surface-container)] px-1 py-0.5">
                      /socket.io/*
                    </code>{' '}
                    → WebSocket 信令（端口 3333）
                  </li>
                  <li>
                    <code className="rounded bg-[var(--md-sys-color-surface-container)] px-1 py-0.5">
                      /live/*
                    </code>{' '}
                    → HTTP-FLV 拉流（端口 3335）
                  </li>
                </ul>
                <p>
                  反向代理需启用 HTTPS（SSL 证书），否则 HTTPS
                  页面下的连接会被浏览器阻止。
                </p>
              </div>
            </div>
          </div>

          <Input
            label="服务器域名"
            value={customApiUrl}
            onChange={(e) => setCustomApiUrlState(e.target.value)}
            placeholder="例如: example.com"
            size="md"
          />
          <details className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
            <summary className="cursor-pointer select-none font-medium">
              高级设置（通常无需修改）
            </summary>
            <div className="mt-3 space-y-3">
              <Input
                label="WebSocket / 信令地址（留空则跟随上方域名）"
                value={customSocketUrl}
                onChange={(e) => setCustomSocketUrlState(e.target.value)}
                placeholder="留空即可"
                size="md"
              />
              <Input
                label="HTTP-FLV 拉流基础地址（留空则自动推断）"
                value={customFlvBaseUrl}
                onChange={(e) => setCustomFlvBaseUrlState(e.target.value)}
                placeholder="留空即可"
                size="md"
              />
              <Input
                label="RTMP 推流端口（留空则使用默认 3334）"
                value={customRtmpPort}
                onChange={(e) => setCustomRtmpPortState(e.target.value)}
                placeholder="留空即可"
                size="md"
              />
            </div>
          </details>
          <div className="space-y-1 text-xs text-[var(--md-sys-color-on-surface-variant)]">
            <p>
              当前 API 地址:{' '}
              <code className="bg-[var(--md-sys-color-surface-container)] px-1 py-0.5 rounded">
                {getApiUrl()}
              </code>
            </p>
            <p>
              当前 WebSocket 地址:{' '}
              <code className="bg-[var(--md-sys-color-surface-container)] px-1 py-0.5 rounded">
                {getSocketUrl()}
              </code>
            </p>
            <p>
              当前 FLV 基础地址:{' '}
              <code className="bg-[var(--md-sys-color-surface-container)] px-1 py-0.5 rounded">
                {getFlvBaseUrl() || '(相对路径 /live)'}
              </code>
            </p>
            <p>
              当前 RTMP 端口:{' '}
              <code className="bg-[var(--md-sys-color-surface-container)] px-1 py-0.5 rounded">
                {getRtmpPort()}
              </code>
            </p>
          </div>

          {hasMixedContent && (
            <div
              className="rounded-lg border p-3"
              style={{
                borderColor: 'var(--md-sys-color-error)',
                backgroundColor:
                  'rgba(var(--md-sys-color-error-container-rgb, 249, 233, 232), 0.95)',
                color: 'var(--md-sys-color-on-error-container)',
              }}
            >
              <div className="flex items-center gap-2 text-sm font-medium">
                <ShieldAlert className="h-4 w-4 shrink-0" />
                <span>检测到混合内容（HTTPS → HTTP）</span>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed">
                当前页面为 HTTPS，但后端地址为 HTTP。浏览器会阻止 HTTPS
                页面发起的 HTTP 请求，API 和 WebSocket 连接均无法正常工作。
              </p>
              <p className="mt-2 text-xs font-medium">推荐方案：</p>
              <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs">
                <li>
                  使用反向代理（Nginx / Caddy）统一提供
                  HTTPS，后端通过反向代理访问
                </li>
                <li>或为后端 Express 服务直接配置 HTTPS 证书</li>
                <li>
                  或使用 Docker 部署，前端 Nginx 自动代理 /api 和 /socket.io
                  到后端
                </li>
              </ul>
            </div>
          )}

          <div className="text-xs text-[var(--md-sys-color-on-surface-variant)]">
            提示：留空将使用环境变量或页面默认值，保存后会自动刷新页面使配置生效。
          </div>
        </div>
      </Modal>

      {/* 离开房间确认对话框 */}
      {exitGuardModal}
    </>
  )
}
