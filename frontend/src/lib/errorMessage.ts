import { redactMediaError } from '@/modules/player/services/media-redaction'
import { canonicalProductMessage, t } from '@/i18n'

/** Localize legacy server errors at the UI boundary; retain the old export for callers. */
export function englishErrorMessage(
  value: unknown,
  fallback = 'Unable to complete this action. Please try again.'
): string {
  const text =
    value instanceof Error
      ? value.message
      : typeof value === 'string'
        ? value
        : ''
  if (!text) return t(fallback)
  const known: Record<string, string> = {
    密码错误: 'Incorrect password. Check it and try again.',
    用户名或密码错误: 'Incorrect username or password.',
    未登录: 'Sign in to continue.',
    请先登录: 'Sign in to continue.',
    登录已过期: 'Your session has expired. Sign in again.',
    无权限: 'You do not have permission to do this.',
    权限不足: 'You do not have permission to do this.',
    房间不存在: 'This room could not be found.',
    房间已关闭: 'This room has ended.',
    房间观看人数已达上限: 'This room is full. Try again when someone leaves.',
    当前房间授权已失效:
      'Room access has expired. Return to the room to reconnect.',
    加入语音超时: 'Joining voice chat timed out. Try again.',
    加入语音失败: 'Unable to join voice chat. Try again.',
    当前音乐来源无法解析: 'This music source could not be opened.',
    网易云音乐解析失败:
      'NetEase Music could not open this track. Check your connection and account access.',
    房主拒绝了控制申请: 'The host declined your control request.',
    默认空间不可删除: 'The default storage space cannot be removed.',
    文件不存在: 'This file could not be found.',
    路径不存在: 'This folder could not be found.',
    网络错误: 'Connection failed. Check your network and try again.',
    操作超时: 'This action timed out. Try again.',
    'Failed to fetch': 'Connection failed. Check your network and try again.',
    'Network request failed':
      'Connection failed. Check your network and try again.',
    'Load failed': 'Connection failed. Check your network and try again.',
    请先加入房间: 'Join the room before continuing.',
    不在该房间中: 'Join the room before continuing.',
    游客无此权限: 'Guests do not have permission to do this.',
    目标不在房间中: 'This member is no longer in the room.',
    不能对自己执行此操作: 'You cannot perform this action on yourself.',
    不能对系统管理员操作:
      'You cannot perform this action on a platform administrator.',
    '仅房主、房管或系统管理员可管理音乐队列':
      'Only the host, a room moderator or a platform administrator can manage this queue.',
    仅当前房主或系统管理员可控制音乐:
      'Only the current host or a platform administrator can control this music.',
    仅房主或系统管理员可执行此操作:
      'Only the host or a platform administrator can do this.',
    '仅房主、房管或系统管理员可执行此操作':
      'Only the host, a room moderator or a platform administrator can do this.',
    '房管不能操作房主、房管或系统管理员':
      'Room moderators cannot manage the host, other moderators or platform administrators.',
    仅房主或系统管理员可管理房管:
      'Only the room owner or a platform administrator can manage room moderators.',
    目标不是可管理的普通成员:
      'This member cannot be managed by your room role.',
    仅房主或系统管理员可修改房间设置:
      'Only the room owner or a platform administrator can change room settings.',
    未知权限动作: 'This action is not supported.',
    请等待房主处理已有请求:
      'Wait for the host to review the existing requests.',
    活动选项无效: 'The selected activity is invalid.',
    处理选项无效: 'Invalid decision.',
    投票选项无效: 'Invalid decision.',
    影片不存在: 'This selection is no longer available. Refresh the queue.',
    当前成员没有选片权限或房间身份已失效:
      'Content selection permission is required.',
    '选片权限或媒体记录已变更，请重新选择':
      'Content selection permission or room access has changed. Choose the content again.',
    新增影片失败: 'Unable to add this movie. Try again.',
    获取影片列表失败: 'Unable to load the watch queue. Refresh to try again.',
    更新影片失败: 'Unable to update this movie. Try again.',
    删除影片失败: 'Unable to remove this movie. Try again.',
    重排序失败: 'Unable to reorder the watch queue. Try again.',
  }
  const copy = known[text]
  if (copy) return t(copy)
  const canonical = canonicalProductMessage(text)
  if (canonical !== text) return t(redactMediaError(text))
  // Unknown legacy diagnostics may include private provider paths or credentials.
  // Keep their original form available to callers while showing a contextual safe message.
  return /\p{Script=Han}/u.test(text) ? t(fallback) : t(redactMediaError(text))
}
