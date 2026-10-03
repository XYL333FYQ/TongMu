import { t, useTranslation } from '@/i18n'
import { Button } from '@/components/ui/Button'
import { Space } from '@/components/ui/Space'
import { Tag } from '@/components/ui/Tag'
import { PauseCircle, PlayCircle, Power, RefreshCw } from 'lucide-react'

interface ShareControlsBarProps {
  /** 是否Pause中（决定显示Pause/Restore按钮） */
  isPaused: boolean
  /** socket 是否Connected */
  connected: boolean
  /** OnlineMembers数量 */
  viewerCount: number
  /** PeerConnection 数量 */
  connectionCount: number
  /** 是否正在Close room（loading 状态） */
  closing: boolean
  /** Pause/Resume sharing */
  onTogglePause: () => void
  /** Copy invite link */
  onCopyLink: () => void
  /** Clear annotations */
  onClearAnnotations: () => void
  /** Stop sharing */
  onClose: () => void
  /** Refresh共享（重启采集并重建连接） */
  onRefresh: () => void
}

export function ShareControlsBar({
  isPaused,
  connected,
  viewerCount,
  connectionCount,
  closing,
  onTogglePause,
  onClearAnnotations,
  onClose,
  onRefresh,
}: ShareControlsBarProps): JSX.Element {
  useTranslation()

  return (
    <div className="vc-container absolute bottom-0 left-0 right-0 z-20 p-2">
      <div className="glass-strong rounded-xl px-2.5 py-2 shadow-lg">
        <Space className="w-full" wrap>
          {isPaused ? (
            <Button
              variant="primary"
              icon={<PlayCircle className="h-5 w-5" />}
              onClick={onTogglePause}
            >
              {t('Resume sharing')}
            </Button>
          ) : (
            <Button
              icon={<PauseCircle className="h-5 w-5" />}
              onClick={onTogglePause}
            >
              {t('Pause sharing')}
            </Button>
          )}
          <Button variant="ghost" onClick={onClearAnnotations}>
            {t('Clear annotations')}
          </Button>
          <Button
            variant="secondary"
            icon={<RefreshCw className="h-5 w-5" />}
            onClick={onRefresh}
          >
            {t('Refresh')}
          </Button>
          <Button
            variant="danger"
            icon={<Power className="h-5 w-5" />}
            loading={closing}
            onClick={onClose}
          >
            {t('Stop sharing')}
          </Button>
        </Space>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Tag color={connected ? 'success' : 'default'}>
            {connected ? t('Connected') : t('Disconnected')}
          </Tag>
          <Tag color="primary">{t('Sharing')}</Tag>
          {isPaused && <Tag color="warning">{t('Paused')}</Tag>}
          {!isPaused && <Tag color="cyan">{t('Streaming')}</Tag>}
          <Tag color="purple">
            {t('Viewers:')} {viewerCount} / {connectionCount} {t('connections')}
          </Tag>
        </div>
      </div>
    </div>
  )
}
