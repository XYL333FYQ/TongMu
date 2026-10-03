import { t, useTranslation } from '@/i18n'
import { useCallback, useRef, useState } from 'react'
import { AtSign, Camera, KeyRound, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Avatar } from '@/components/ui/Avatar'
import { Modal, ConfirmModal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { Text } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import { englishErrorMessage } from '@/lib/errorMessage'
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
  useTranslation()
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
      message.warning(t('Enter your current and new passwords.'))
      return
    }
    if (newPassword !== confirmPassword) {
      message.error(t('The new passwords do not match.'))
      return
    }
    if (newPassword.length < 4) {
      message.error(t('Use at least 4 characters for the new password.'))
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
        message.success(t('Password updated.'))
        setOldPassword('')
        setNewPassword('')
        setConfirmPassword('')
      } else {
        message.error(
          englishErrorMessage(data.message, 'Could not save the change.')
        )
      }
    } catch {
      message.error(t('Could not change the password.'))
    } finally {
      setPasswordLoading(false)
    }
  }, [oldPassword, newPassword, confirmPassword])

  const handleChangeUsername = useCallback(async () => {
    const trimmed = newUsername.trim()
    if (!trimmed) {
      message.warning(t('Enter a new username.'))
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
        message.success(t('Username updated.'))
        setUser(data.user)
        setNewUsername('')
      } else {
        message.error(
          englishErrorMessage(data.message, 'Could not save the change.')
        )
      }
    } catch {
      message.error(t('Could not change the username.'))
    } finally {
      setUsernameLoading(false)
    }
  }, [newUsername, setUser])

  // 头像上传
  const handleAvatarUpload = useCallback(
    async (file: File) => {
      if (user?.role === 'guest') {
        message.warning(t('Sign in to set an avatar.'))
        return
      }
      const allowedTypes = [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
      ]
      if (!allowedTypes.includes(file.type)) {
        message.error(t('Use a JPG, PNG, GIF or WebP image.'))
        return
      }
      if (file.size > 5 * 1024 * 1024) {
        message.error(t('Choose an image smaller than 5 MB.'))
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
          message.success(t('Avatar updated.'))
          setUser(data.user)
        } else {
          message.error(
            englishErrorMessage(data.message, 'Could not upload the avatar.')
          )
        }
      } catch {
        message.error(t('Could not upload the avatar.'))
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
        message.success(t('Avatar removed.'))
        setUser(data.user)
      } else {
        message.error(
          englishErrorMessage(data.message, 'Could not remove the avatar.')
        )
      }
    } catch {
      message.error(t('Could not remove the avatar.'))
    } finally {
      setAvatarLoading(false)
    }
  }, [setUser])

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={t('Profile & security')}
        className="max-w-2xl"
        footer={
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('Close')}
          </Button>
        }
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {/* 左侧列：头像 + Username */}
          <div className="flex flex-col gap-3">
            {/* Your avatar区块 */}
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
                    {t('Your avatar')}
                  </Text>
                  <Text
                    type="secondary"
                    className="text-[10px] uppercase tracking-wide"
                  >
                    {t('Choose a profile image.')}
                  </Text>
                </div>
              </div>
              <div className="flex flex-col gap-2.5 px-4 py-3">
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <Avatar
                      size="lg"
                      alt={user.username}
                      src={buildAvatarUrl(user.avatar)}
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
                      {user.avatar ? t('Change avatar') : t('Upload avatar')}
                    </Button>
                    {user.avatar && (
                      <Button
                        variant="danger"
                        size="sm"
                        icon={<Trash2 className="h-3.5 w-3.5" />}
                        disabled={avatarLoading}
                        onClick={() => setAvatarDeleteTarget(true)}
                      >
                        {t('Remove avatar')}
                      </Button>
                    )}
                  </div>
                </div>
                <Text type="secondary" className="text-[10px] leading-relaxed">
                  {t('JPG, PNG, GIF or WebP · up to 5 MB')}
                </Text>
              </div>
            </div>

            {/* Change username区块 */}
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
                      {t('Change username')}
                    </Text>
                    <Text
                      type="secondary"
                      className="text-[10px] uppercase tracking-wide"
                    >
                      {t('Update your account name.')}
                    </Text>
                  </div>
                </div>
                <div className="flex flex-col gap-2.5 px-4 py-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                      {t('New username')}
                    </label>
                    <Input
                      size="sm"
                      placeholder={t('Enter a new username.')}
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
                    {t('Save changes')}
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* 右侧列：Change password */}
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
                  {t('Change password')}
                </Text>
                <Text
                  type="secondary"
                  className="text-[10px] uppercase tracking-wide"
                >
                  {t('Update your sign-in password.')}
                </Text>
              </div>
            </div>
            <div className="flex flex-col gap-2.5 px-4 py-3">
              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                  {t('Current password')}
                </label>
                <Input
                  type="password"
                  size="sm"
                  placeholder={t('Current password')}
                  value={oldPassword}
                  onChange={(e) => setOldPassword(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                  {t('New password')}
                </label>
                <Input
                  type="password"
                  size="sm"
                  placeholder={t('At least 4 characters')}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                  {t('Confirm new password')}
                </label>
                <Input
                  type="password"
                  size="sm"
                  placeholder={t('Repeat the new password')}
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
                {t('Save changes')}
              </Button>
            </div>
          </div>
        </div>
      </Modal>

      <ConfirmModal
        open={avatarDeleteTarget}
        onClose={() => setAvatarDeleteTarget(false)}
        title={t('Remove avatar')}
        okText={t('Remove')}
        onOk={() => void handleAvatarDelete()}
        onCancel={() => setAvatarDeleteTarget(false)}
      >
        <Text className="text-sm">
          {t('Remove your avatar and use the default profile image?')}
        </Text>
      </ConfirmModal>
    </>
  )
}
