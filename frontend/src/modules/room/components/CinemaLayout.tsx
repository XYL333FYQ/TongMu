import { type ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useRoomExitGuard } from '@/hooks/useRoomExitGuard'
import { cn } from '@/lib/utils'

interface CinemaLayoutProps {
  children: ReactNode
  /** 房间信息面板（watch-together 模式使用） */
  roomInfoPanel?: ReactNode
  /** 影片列表面板（watch-together 模式使用） */
  movieListPanel?: ReactNode
  /** 添加影片面板（watch-together 模式使用） */
  moviePushPanel?: ReactNode
  /**
   * 投屏状态面板（screen-share 模式使用）。
   * 提供时替代三列网格，底部仅渲染此面板（与房主端布局一致）。
   */
  statsPanel?: ReactNode
  chatPanel: ReactNode
  /**
   * CSS 模拟的网页全屏状态。
   * 为 true 时整个布局变为 fixed 铺满视口，隐藏底部面板和聊天区，
   * 并移除 Card 的 backdrop-filter 以避免成为 fixed 定位的包含块。
   */
  webFullscreen?: boolean
}

export function CinemaLayout({
  children,
  roomInfoPanel,
  movieListPanel,
  moviePushPanel,
  statsPanel,
  chatPanel,
  webFullscreen = false,
}: CinemaLayoutProps) {
  const { guardNavigate, confirmModal } = useRoomExitGuard()
  // Only render supplied panels. OBS viewers have room info but no movie tools.
  const bottomPanels = statsPanel
    ? [roomInfoPanel, statsPanel]
    : [roomInfoPanel, movieListPanel, moviePushPanel]
  const visiblePanels = bottomPanels.filter((panel) => panel != null)

  return (
    <div
      className={cn(
        'tongmu-room-layout p-3 lg:p-6',
        webFullscreen
          ? 'fixed inset-0 z-[100] h-screen overflow-hidden p-0'
          : 'min-h-[100dvh]'
      )}
      style={{ backgroundColor: 'transparent' }}
    >
      <div
        className={cn(
          'tongmu-room__stage relative mx-auto flex w-full flex-col bg-transparent',
          webFullscreen
            ? 'h-full w-full max-w-none overflow-hidden bg-black'
            : 'max-w-[1152px]'
        )}
      >
        <div className={cn('mb-3', webFullscreen && 'hidden')}>
          <Button
            variant="ghost"
            size="sm"
            disableAnimation
            icon={<ArrowLeft className="h-4 w-4" />}
            onClick={() => guardNavigate('/')}
            className="min-h-11 border px-3"
            style={{
              backgroundColor: 'var(--tm-glass-card-bg)',
              color: 'var(--tm-text-primary)',
              borderColor: 'var(--tm-border)',
            }}
          >
            返回大厅
          </Button>
        </div>
        <div
          className={cn(
            'gap-4 lg:flex-row',
            webFullscreen ? 'flex h-full flex-col p-0' : 'flex flex-col'
          )}
        >
          {/* 主区域 */}
          <div className="flex min-w-0 flex-1 flex-col gap-4">
            {/* 播放器区域 */}
            <div
              className={cn(
                'relative w-full overflow-hidden rounded-2xl',
                !webFullscreen && 'rounded-2xl'
              )}
              style={
                webFullscreen
                  ? { height: '100%', backgroundColor: '#000' }
                  : {
                      aspectRatio: '16 / 9',
                      backgroundColor: '#000',
                      borderColor: 'var(--md-sys-color-outline-variant)',
                    }
              }
            >
              {children}
            </div>

            {/* 底部信息/控制/添加区（或投屏状态面板）—— 网页全屏时隐藏 */}
            {visiblePanels.length > 0 && (
              <div
                className={cn(
                  'grid gap-3',
                  visiblePanels.length > 1 && 'lg:grid-cols-2',
                  webFullscreen && 'hidden'
                )}
              >
                {visiblePanels.map((panel, index) => (
                  <div key={index} className="min-w-0">
                    {panel}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 右侧聊天区 —— 网页全屏时隐藏 */}
          <div
            className={cn(
              'min-h-[320px] w-full flex-shrink-0 lg:min-h-0 lg:w-[320px]',
              webFullscreen && 'hidden'
            )}
          >
            {chatPanel}
          </div>
        </div>
      </div>
      {confirmModal}
    </div>
  )
}
