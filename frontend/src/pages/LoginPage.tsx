import { t, useTranslation } from '@/i18n'
import { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { Shield, UserPlus, LogIn } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Input } from '@/components/ui/Input'
import { InputPassword } from '@/components/ui/InputPassword'
import { Space } from '@/components/ui/Space'
import { Title, Paragraph } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { useAuthStore } from '@/store/authStore'
import { apiFetch, resetSessionExpired, saveAuthTokens } from '@/lib/api'
import { reconnectSocket } from '@/hooks/useSocket'
import { englishErrorMessage } from '@/lib/errorMessage'
import { cn } from '@/lib/utils'

const Fade = ({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode
  delay?: number
  className?: string
}) => (
  <div
    className={cn('zen-stagger-fade-up', className)}
    style={{ '--stagger-delay': `${delay}ms` } as React.CSSProperties}
  >
    {children}
  </div>
)

interface AuthForm {
  username: string
  password: string
}

type AuthMode = 'login' | 'register'

export default function LoginPage() {
  useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const { login } = useAuthStore()
  const [mode, setMode] = useState<AuthMode>('login')
  const [form, setForm] = useState<AuthForm>({ username: '', password: '' })
  const [loading, setLoading] = useState(false)
  const [registrationMode, setRegistrationMode] = useState<
    'open' | 'approval' | 'closed'
  >('approval')

  const from = (location.state as { from?: { pathname?: string } } | null)?.from
    ?.pathname

  const isLogin = mode === 'login'

  useEffect(() => {
    const fetchMode = async () => {
      try {
        const res = await apiFetch('/api/auth/registration-mode')
        const data = (await res.json()) as {
          success: boolean
          mode?: 'open' | 'approval' | 'closed'
        }
        if (data.success && data.mode) {
          setRegistrationMode(data.mode)
        }
      } catch (err) {
        console.error('[LoginPage] fetch registration mode error:', err)
      }
    }
    void fetchMode()
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.username.trim() || !form.password) {
      message.warning(t('Enter your username and password.'))
      return
    }

    if (!isLogin && form.password.length < 4) {
      message.warning(t('Use at least 4 characters for the password.'))
      return
    }

    setLoading(true)
    try {
      const endpoint = isLogin ? '/api/auth/login' : '/api/auth/register'
      const res = await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const data = (await res.json()) as {
        success: boolean
        user?: {
          id: string
          username: string
          role: string
          status?: 'active' | 'pending'
        }
        accessToken?: string
        refreshToken?: string
        message?: string
      }

      if (data.success && data.user) {
        if (!isLogin && data.user.status === 'pending') {
          message.success(
            englishErrorMessage(
              data.message,
              'Account created. Please wait for administrator approval.'
            )
          )
          setMode('login')
          return
        }
        // 保存返回的 token（跨站 HTTP / 直连场景 cookie 不可用时 fallback 到 Bearer 头）
        saveAuthTokens(data.accessToken, data.refreshToken)
        // 登录成功 → 重置 session 过期标志，允许后续 401 时再次尝试 refresh
        resetSessionExpired()
        login({
          id: data.user.id,
          username: data.user.username,
          role: data.user.role as import('@/store/authStore').UserRole,
          status: data.user.status,
        })
        // 登录后 Socket 需要断开重连，以新的认证凭据重新握手，
        // 否则后端 socket.data.role 仍为旧角色（如 guest），导致创建房间等操作被拒绝。
        reconnectSocket()
        message.success(isLogin ? t('Signed in.') : t('Account created.'))
        navigate(from || '/', { replace: true })
      } else {
        message.error(
          englishErrorMessage(
            data.message,
            isLogin ? 'Sign-in failed.' : 'Could not create your account.'
          )
        )
      }
    } catch (err) {
      console.error('[LoginPage] auth error:', err)
      message.error(
        isLogin
          ? t('Could not connect to sign in.')
          : t('Could not connect to create your account.')
      )
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <Card
        className="w-full max-w-sm"
        style={{
          // 登录卡片使用更强的背景模糊，突出主体层次
          backdropFilter: 'blur(var(--glass-blur-strong))',
          WebkitBackdropFilter: 'blur(var(--glass-blur-strong))',
        }}
      >
        <div className="text-center mb-6">
          <Fade delay={80} className="inline-block">
            <div
              className="w-12 h-12 rounded-xl flex items-center justify-center mx-auto"
              style={{
                backgroundColor: 'var(--md-sys-color-primary-container)',
                color: 'var(--md-sys-color-on-primary-container)',
                boxShadow:
                  '0 8px 24px -6px color-mix(in srgb, var(--md-sys-color-primary) 30%, transparent)',
              }}
            >
              <Shield className="w-6 h-6" />
            </div>
          </Fade>
          <Fade delay={120} key={`login-title-${mode}`}>
            <Title level={3} className="m-0 mt-4">
              {isLogin ? t('Welcome to TongMu') : t('Create an account')}
            </Title>
            <Paragraph type="secondary" className="m-0 mt-2">
              {isLogin
                ? t('Sign in to your account and join your shared space.')
                : registrationMode === 'closed'
                  ? t('Registration is closed.')
                  : registrationMode === 'open'
                    ? t('Create an account to get started.')
                    : t(
                        'An administrator will review your registration before you can sign in.'
                      )}
            </Paragraph>
          </Fade>
        </div>

        <form onSubmit={handleSubmit}>
          <Space direction="vertical" className="w-full">
            <Fade delay={180} className="w-full">
              <Input
                label={t('Username')}
                type="text"
                value={form.username}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, username: e.target.value }))
                }
                placeholder={t('Your username')}
                size="lg"
              />
            </Fade>

            <Fade delay={220} className="w-full">
              <InputPassword
                label={t('Password')}
                value={form.password}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, password: e.target.value }))
                }
                placeholder={
                  isLogin ? t('Your password') : t('At least 4 characters')
                }
                size="lg"
              />
            </Fade>

            <Fade delay={280} className="w-full">
              <Button
                variant="primary"
                type="submit"
                block
                loading={loading}
                icon={
                  isLogin ? (
                    <LogIn className="w-4 h-4" />
                  ) : (
                    <UserPlus className="w-4 h-4" />
                  )
                }
                className="mt-2"
              >
                {isLogin ? t('Sign in') : t('Register')}
              </Button>
            </Fade>
          </Space>
        </form>

        <Fade delay={340} key={`login-switch-${mode}`}>
          <div className="mt-6 text-center">
            {isLogin ? (
              registrationMode === 'closed' ? (
                <Paragraph type="secondary" className="text-xs m-0">
                  {t('New account registration is currently closed.')}
                </Paragraph>
              ) : (
                <Paragraph
                  type="secondary"
                  className="m-0 flex flex-wrap items-center justify-center gap-2 text-xs"
                >
                  {t('New to TongMu?')}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    icon={<UserPlus className="h-4 w-4" />}
                    onClick={() => setMode('register')}
                  >
                    {t('Create an account')}
                  </Button>
                </Paragraph>
              )
            ) : (
              <Paragraph
                type="secondary"
                className="m-0 flex flex-wrap items-center justify-center gap-2 text-xs"
              >
                {t('Already have an account?')}
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  icon={<LogIn className="h-4 w-4" />}
                  onClick={() => setMode('login')}
                >
                  {t('Back to sign in')}
                </Button>
              </Paragraph>
            )}
          </div>
        </Fade>
      </Card>
    </div>
  )
}
