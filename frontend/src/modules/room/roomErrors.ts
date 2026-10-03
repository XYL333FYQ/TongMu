export function roomErrorMessage(message?: string, code?: string): string {
  const codes: Record<string, string> = {
    LOGIN_REQUIRED: 'Sign in to join this room.',
    NICKNAME_REQUIRED: 'Choose a nickname before joining.',
    LEAVE_CURRENT_ROOM: 'Leave your current room before joining another.',
    ALREADY_IN_ROOM:
      'This account is already in this room in another tab. Close that tab, then retry.',
  }
  if (code && codes[code]) return t(codes[code])
  const messages: Record<string, string> = {
    密码错误: 'Incorrect password. Check it and try again.',
    房间不存在:
      'This room could not be found. Check the room ID or invitation link.',
    房间已关闭:
      'This room has ended. Return to the hall or join a different room.',
    房间观看人数已达上限: 'This room is full. Try again when someone leaves.',
    投票已失效: 'This vote is no longer available.',
    投票已结束: 'Voting has ended.',
    请求已失效: 'This request is no longer available.',
    已经在该活动中: 'This activity is already open.',
    请向房主请求切换活动: 'Ask the host to switch activities.',
    代理仅可控制当前活动:
      'Temporary hosts can control activities. Room management belongs to the owner.',
  }
  if (message && messages[message]) return t(messages[message])
  return englishErrorMessage(
    message,
    'Unable to complete this action. Check the room rules and your connection, then try again.'
  )
}
import { t } from '@/i18n'
import { englishErrorMessage } from '@/lib/errorMessage'
