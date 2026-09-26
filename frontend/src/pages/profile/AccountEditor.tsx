import { useCallback, useRef, useState } from 'react'
import { AtSign, Camera, KeyRound, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Avatar } from '@/components/ui/Avatar'
import { Modal, ConfirmModal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { Text } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { useAuthStore, type User as AuthUser } from '@/store/authStore'
import { apiFetch } from '@/lib/api'
import { buildAvatarUrl } from './avatarUrl'

export function AccountEditor({
  user,
  onClose,
}: {
  user: AuthUser
  onClose: () => void
}) {
  const setUser = useAuthStore((state) => state.setUser)
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [passwordLoading, setPasswordLoading] = useState(false)

  const [newUsername, setNewUsername] = useState('')
  const [usernameLoading, setUsernameLoading] = useState(false)

  // 头像上传
  const [avatarLoading, setAvatarLoading] = useState(false)
  const [avatarDeleteTarget, setAvatarDeleteTarget] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement>(null)

  const handleChangePassword = useCallback(async () => {
    if (!oldPassword || !newPassword) {
      message.warning('请填写原密码和新密码')
      return
    }
    if (newPassword !== confirmPassword) {
      message.error('两次输入的新密码不一致')
      return
    }
    if (newPassword.length < 4) {
      message.error('新密码至少 4 位')
      return
    }
    setPasswordLoading(true)
    try {
      const res = await apiFetch('/api/auth/password', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ oldPassword, newPassword }),
      })
      const data = (await res.json()) as {
        success: boolean
        message?: string
      }
      if (data.success) {
        message.success('密码修改成功')
        setOldPassword('')
        setNewPassword('')
        setConfirmPassword('')
      } else {
        message.error(data.message ?? '修改失败')
      }
    } catch {
      message.error('修改密码失败')
    } finally {
      setPasswordLoading(false)
    }
  }, [oldPassword, newPassword, confirmPassword])

  const handleChangeUsername = useCallback(async () => {
    const trimmed = newUsername.trim()
    if (!trimmed) {
      message.warning('请输入新用户名')
      return
    }
    setUsernameLoading(true)
    try {
      const res = await apiFetch('/api/auth/username', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username: trimmed }),
      })
      const data = (await res.json()) as {
        success: boolean
        message?: string
        user?: AuthUser
      }
      if (data.success && data.user) {
        message.success('用户名修改成功')
        setUser(data.user)
        setNewUsername('')
      } else {
        message.error(data.message ?? '修改失败')
      }
    } catch {
      message.error('修改用户名失败')
    } finally {
      setUsernameLoading(false)
    }
  }, [newUsername, setUser])

  // 头像上传
  const handleAvatarUpload = useCallback(
    async (file: File) => {
      if (user?.role === 'guest') {
        message.warning('游客无法设置头像')
        return
      }
      const allowedTypes = [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
      ]
      if (!allowedTypes.includes(file.type)) {
        message.error('仅支持 JPG / PNG / GIF / WEBP 格式')
        return
      }
      if (file.size > 5 * 1024 * 1024) {
        message.error('头像文件不能超过 5MB')
        return
      }
      setAvatarLoading(true)
      try {
        const formData = new FormData()
        formData.append('avatar', file)
        const res = await apiFetch('/api/auth/avatar', {
          method: 'POST',
          body: formData,
        })
        const data = (await res.json()) as {
          success: boolean
          message?: string
          user?: AuthUser
        }
        if (data.success && data.user) {
          message.success('头像更新成功')
          setUser(data.user)
        } else {
          message.error(data.message ?? '头像上传失败')
        }
      } catch {
        message.error('头像上传失败')
      } finally {
        setAvatarLoading(false)
      }
    },
    [user, setUser]
  )

  // 头像删除
  const handleAvatarDelete = useCallback(async () => {
    setAvatarDeleteTarget(false)
    setAvatarLoading(true)
    try {
      const res = await apiFetch('/api/auth/avatar', {
        method: 'DELETE',
      })
      const data = (await res.json()) as {
        success: boolean
        message?: string
        user?: AuthUser
      }
      if (data.success && data.user) {
        message.success('头像已删除')
        setUser(data.user)
      } else {
        message.error(data.message ?? '删除头像失败')
      }
    } catch {
      message.error('删除头像失败')
    } finally {
      setAvatarLoading(false)
    }
  }, [setUser])

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title="编辑账号信息"
        className="max-w-2xl"
        footer={
          <Button variant="secondary" size="sm" onClick={onClose}>
            关闭
          </Button>
        }
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {/* 左侧列：头像 + 用户名 */}
          <div className="flex flex-col gap-3">
            {/* 修改头像区块 */}
            <div className="glass-card overflow-hidden rounded-[var(--md-sys-shape-corner)]">
              <div className="flex items-center gap-2.5 border-b border-[var(--glass-border)] px-4 py-3">
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                  style={{
                    background:
                      'linear-gradient(135deg, color-mix(in srgb, var(--md-sys-color-secondary) 22%, transparent), color-mix(in srgb, var(--md-sys-color-primary) 18%, transparent))',
                  }}
                >
                  <Camera
                    className="h-4 w-4"
                    style={{ color: 'var(--md-sys-color-primary)' }}
                  />
                </span>
                <div className="flex min-w-0 flex-col">
                  <Text className="text-sm font-semibold leading-tight">
                    修改头像
                  </Text>
                  <Text
                    type="secondary"
                    className="text-[10px] uppercase tracking-wide"
                  >
                    上传自定义头像图片
                  </Text>
                </div>
              </div>
              <div className="flex flex-col gap-2.5 px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <Avatar
                      size="lg"
                      alt={user.username}
                      src={buildAvatarUrl(user.avatar, user.role)}
                    />
                    {avatarLoading && (
                      <div
                        className="absolute inset-0 flex items-center justify-center rounded-full"
                        style={{
                          backgroundColor:
                            'color-mix(in srgb, var(--md-sys-color-surface) 70%, transparent)',
                        }}
                      >
                        <Spinner size={16} />
                      </div>
                    )}
                  </div>
                  <div className="flex flex-1 flex-col gap-1.5">
                    <input
                      ref={avatarInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/gif,image/webp"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0]
                        if (file) {
                          void handleAvatarUpload(file)
                        }
                        // 重置 input value 以便重复选择同一文件
                        e.target.value = ''
                      }}
                    />
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<Camera className="h-3.5 w-3.5" />}
                      loading={avatarLoading}
                      onClick={() => avatarInputRef.current?.click()}
                    >
                      {user.avatar ? '更换头像' : '上传头像'}
                    </Button>
                    {user.avatar && (
                      <Button
                        variant="danger"
                        size="sm"
                        icon={<Trash2 className="h-3.5 w-3.5" />}
                        disabled={avatarLoading}
                        onClick={() => setAvatarDeleteTarget(true)}
                      >
                        删除头像
                      </Button>
                    )}
                  </div>
                </div>
                <Text type="secondary" className="text-[10px] leading-relaxed">
                  支持 JPG / PNG / GIF / WEBP，最大 5MB
                </Text>
              </div>
            </div>

            {/* 修改用户名区块 */}
            {user.role === 'root' && (
              <div className="glass-card overflow-hidden rounded-[var(--md-sys-shape-corner)]">
                <div className="flex items-center gap-2.5 border-b border-[var(--glass-border)] px-4 py-3">
                  <span
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                    style={{
                      background:
                        'linear-gradient(135deg, color-mix(in srgb, var(--md-sys-color-tertiary) 22%, transparent), color-mix(in srgb, var(--md-sys-color-secondary) 18%, transparent))',
                    }}
                  >
                    <AtSign
                      className="h-4 w-4"
                      style={{ color: 'var(--md-sys-color-primary)' }}
                    />
                  </span>
                  <div className="flex min-w-0 flex-col">
                    <Text className="text-sm font-semibold leading-tight">
                      修改用户名
                    </Text>
                    <Text
                      type="secondary"
                      className="text-[10px] uppercase tracking-wide"
                    >
                      更改登录账户名称
                    </Text>
                  </div>
                </div>
                <div className="flex flex-col gap-2.5 px-4 py-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                      新用户名
                    </label>
                    <Input
                      size="sm"
                      placeholder="请输入新用户名"
                      value={newUsername}
                      onChange={(e) => setNewUsername(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          void handleChangeUsername()
                        }
                      }}
                    />
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={usernameLoading}
                    icon={<AtSign className="h-4 w-4" />}
                    onClick={() => void handleChangeUsername()}
                    className="mt-1"
                  >
                    确认修改
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* 右侧列：修改密码 */}
          <div className="glass-card overflow-hidden rounded-[var(--md-sys-shape-corner)]">
            <div className="flex items-center gap-2.5 border-b border-[var(--glass-border)] px-4 py-3">
              <span
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                style={{
                  background:
                    'linear-gradient(135deg, color-mix(in srgb, var(--md-sys-color-primary) 22%, transparent), color-mix(in srgb, var(--md-sys-color-tertiary) 18%, transparent))',
                }}
              >
                <KeyRound
                  className="h-4 w-4"
                  style={{ color: 'var(--md-sys-color-primary)' }}
                />
              </span>
              <div className="flex min-w-0 flex-col">
                <Text className="text-sm font-semibold leading-tight">
                  修改密码
                </Text>
                <Text
                  type="secondary"
                  className="text-[10px] uppercase tracking-wide"
                >
                  更新账户登录密码
                </Text>
              </div>
            </div>
            <div className="flex flex-col gap-2.5 px-4 py-3">
              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                  原密码
                </label>
                <Input
                  type="password"
                  size="sm"
                  placeholder="请输入原密码"
                  value={oldPassword}
                  onChange={(e) => setOldPassword(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                  新密码
                </label>
                <Input
                  type="password"
                  size="sm"
                  placeholder="至少 4 位"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                  确认新密码
                </label>
                <Input
                  type="password"
                  size="sm"
                  placeholder="再次输入新密码"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      void handleChangePassword()
                    }
                  }}
                />
              </div>
              <Button
                variant="primary"
                size="sm"
                loading={passwordLoading}
                icon={<KeyRound className="h-4 w-4" />}
                onClick={() => void handleChangePassword()}
                className="mt-1"
              >
                确认修改
              </Button>
            </div>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={avatarDeleteTarget}
        onClose={() => setAvatarDeleteTarget(false)}
        title="删除头像"
        okText="删除"
        onOk={() => void handleAvatarDelete()}
        onCancel={() => setAvatarDeleteTarget(false)}
      >
        <Text className="text-sm">确定要删除当前头像并恢复默认头像吗？</Text>
      </ConfirmModal>
    </>
  )
}
