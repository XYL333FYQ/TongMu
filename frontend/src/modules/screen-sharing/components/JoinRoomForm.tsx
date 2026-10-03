import { t, useTranslation } from '@/i18n'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { Title, Text } from '@/components/ui/Typography'
import { Form } from '@/components/ui/Form'
import { Input } from '@/components/ui/Input'
import { InputPassword } from '@/components/ui/InputPassword'
import { ArrowLeft, Eye, Lock } from 'lucide-react'
import type { JoinStatus, JoinFormValues } from '../types'
import { useAuthStore } from '@/store/authStore'
import { getGuestNickname } from '@/modules/room/guestNickname'

interface JoinRoomFormProps {
  /** 初始房间号（来自 URL） */
  initialRoomId: string
  /** Current加入状态 */
  joinStatus: JoinStatus
  /** 提交表单（房间号 + Password） */
  onSubmit: (values: JoinFormValues) => void
  /** BackPrevious page */
  onBack: () => void
  /** 隐藏房间号输入框（从房间List进入，房间号已Confirm） */
  hideRoomId?: boolean
  /** 房间Name（hideRoomId 模式下展示） */
  roomName?: string
  /** 强制Password模式：从房间List进入且房间Password protected时，Password框变为必填 */
  passwordRequired?: boolean
  error?: string
}

export function JoinRoomForm(props: JoinRoomFormProps): JSX.Element {
  useTranslation()

  const {
    initialRoomId,
    joinStatus,
    onSubmit,
    onBack,
    hideRoomId = false,
    roomName,
    passwordRequired = false,
    error,
  } = props
  const isGuest = useAuthStore((state) => state.user?.role === 'guest')

  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <Card className="relative w-full max-w-xl text-center">
        <Button
          variant="ghost"
          size="sm"
          disableAnimation
          icon={<ArrowLeft className="h-4 w-4" />}
          onClick={onBack}
          className="absolute left-4 top-4"
        >
          {t('Hall')}
        </Button>
        <div
          className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
          style={{
            backgroundColor: 'var(--md-sys-color-primary-container)',
            color: 'var(--md-sys-color-on-primary-container)',
          }}
        >
          <Lock className="h-6 w-6" />
        </div>
        <Title level={3}>{t('Join a room')}</Title>
        {hideRoomId && roomName && <Text type="secondary">{roomName}</Text>}
        {!error && (joinStatus === 'rejected' || joinStatus === 'closed') && (
          <div
            className="mb-3 rounded px-3 py-2 text-sm"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-error) 12%, transparent)',
              color: 'var(--md-sys-color-error)',
            }}
          >
            {joinStatus === 'rejected'
              ? t(
                  'The host declined your request. You can ask again or choose a different room.'
                )
              : t(
                  'This room has ended. Check the invitation or choose a different room.'
                )}
          </div>
        )}
        <Form<JoinFormValues>
          onFinish={onSubmit}
          initialValues={{
            roomId: initialRoomId,
            password: '',
            nickname: getGuestNickname(),
          }}
          className="mt-4 text-left"
        >
          {!hideRoomId && (
            <Form.Item
              label={t('Room ID')}
              name="roomId"
              rules={[{ required: true, message: t('Enter a room ID.') }]}
            >
              <Input size="lg" placeholder={t('Enter a room ID')} />
            </Form.Item>
          )}
          {isGuest && (
            <Form.Item
              label={t('Your nickname')}
              name="nickname"
              rules={[{ required: true, message: t('Choose a nickname.') }]}
            >
              <Input
                size="lg"
                placeholder={t('How should others call you?')}
                maxLength={40}
                autoComplete="nickname"
              />
            </Form.Item>
          )}
          <Form.Item
            label={
              passwordRequired
                ? t('Room password')
                : t('Password (if required)')
            }
            name="password"
            rules={
              passwordRequired
                ? [{ required: true, message: t('Enter the room password.') }]
                : undefined
            }
          >
            <InputPassword
              size="lg"
              placeholder={
                passwordRequired
                  ? t('Enter the room password')
                  : t('Leave empty for rooms without a password')
              }
              maxLength={128}
            />
          </Form.Item>
          {error && (
            <p role="alert" className="room-inline-error mb-4">
              {t(error)}
            </p>
          )}
          <Form.Item>
            <Button
              variant="primary"
              type="submit"
              size="lg"
              block
              icon={<Eye className="h-5 w-5" />}
              loading={joinStatus === 'joining'}
            >
              {joinStatus === 'password-required' || joinStatus === 'rejected'
                ? t('Try again')
                : t('Join room')}
            </Button>
          </Form.Item>
        </Form>
      </Card>
    </div>
  )
}
