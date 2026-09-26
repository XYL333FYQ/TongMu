import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { DoorOpen, X } from 'lucide-react'
import { useRoomStore } from '@/store/roomStore'
import { useSocket } from '@/hooks/useSocket'
import { cn } from '@/lib/utils'

/**
 * "回到房间"入口，收在顶栏账户控件旁，避免遮住页面标题。
 *
 * 当用户进入过房间后不在房间页面时（无论是不离开房间导航到其他页面，
 * 还是主动离开房间），在顶栏显示一个快捷入口，点击即可快速回到房间。
 *
 * 工作原理：
 * - RoomPage 挂载时设置 roomStore.activeRoomId
 * - 「主动离开房间」与「导航到其他页面」都保留 activeRoomId
 * - 此组件检测到 activeRoomId 存在且当前不在房间路由，显示浮动入口
 * - 用户点击"回到房间"导航回 /room/:activeRoomId
 * - 用户点击关闭按钮才真正退出：房主 emit host-leave（进入宽限期）+
 *   exitRoom() 清除本地状态；进入/创建新房间时也会自动释放旧房间
 */
export function ReturnToRoomButton() {
  const location = useLocation()
  const navigate = useNavigate()
  const { socket } = useSocket()
  const activeRoomId = useRoomStore((state) => state.activeRoomId)
  const roomName = useRoomStore((state) => state.roomName)
  const exitRoom = useRoomStore((state) => state.exitRoom)

  // 当前路由是否为房间页面。
  // 注意：不能用 startsWith('/room')，否则 /rooms（房间列表）会被误判。
  // 房间路由只有两种形式：/room（无 roomId）和 /room/:roomId
  const isInRoomRoute =
    location.pathname === '/room' || location.pathname.startsWith('/room/')

  // 是否应该显示：有活跃房间且不在房间页面
  const shouldShow = !!activeRoomId && !isInRoomRoute

  // 渲染状态：配合退场动画，shouldShow=false 时延迟卸载
  const [render, setRender] = useState(false)
  const [exiting, setExiting] = useState(false)

  // React Compiler 严格规则误报：render/exiting 仅用于入场/退场动画状态同步。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (shouldShow) {
      setRender(true)
      setExiting(false)
    } else if (render) {
      // 播放退场动画后卸载
      setExiting(true)
      const timer = setTimeout(() => {
        setRender(false)
        setExiting(false)
      }, 280)
      return () => clearTimeout(timer)
    }
  }, [shouldShow, render])
  /* eslint-enable react-hooks/set-state-in-effect */

  if (!render || !activeRoomId) return null

  const handleReturn = () => {
    navigate(`/room/${activeRoomId}`)
  }

  const handleExit = () => {
    // 真正退出：房主此时才 emit host-leave（房间进入 10 分钟宽限期后关闭，
    // 期间可通过房间链接重新进入恢复房主身份），并清除本地房间状态。
    try {
      if (
        activeRoomId &&
        sessionStorage.getItem('zcontrol-host-room') === activeRoomId
      ) {
        socket?.emit('host-leave', () => {
          /* ack */
        })
      }
    } catch {
      // ignore
    }
    exitRoom()
  }

  return (
    <div
      className={cn(
        'flex shrink-0 items-center gap-1',
        exiting ? 'zen-toast-exit' : 'zen-toast-enter'
      )}
    >
      <button
        type="button"
        onClick={handleReturn}
        aria-label={`回到房间 ${roomName || activeRoomId}`}
        className={cn(
          'group flex h-9 max-w-[180px] items-center gap-2 rounded-xl border border-[var(--glass-border)] px-1.5 transition-colors sm:max-w-[240px] sm:px-2.5',
          'hover:bg-[var(--md-sys-color-surface-container-high)] active:scale-[0.98]'
        )}
        style={{
          backgroundColor: 'var(--glass-bg)',
          backdropFilter: 'blur(var(--glass-blur-strong))',
          WebkitBackdropFilter: 'blur(var(--glass-blur-strong))',
        }}
        title="回到房间"
      >
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
          style={{
            backgroundColor: 'var(--md-sys-color-primary-container)',
            color: 'var(--md-sys-color-on-primary-container)',
          }}
        >
          <DoorOpen className="h-4 w-4" />
        </span>

        <div className="hidden min-w-0 flex-col items-start xl:flex">
          <span className="text-xs font-medium text-[var(--md-sys-color-on-surface)]">
            回到房间
          </span>
          <span className="max-w-[140px] truncate text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
            {roomName || activeRoomId}
          </span>
        </div>
      </button>
      <button
        type="button"
        onClick={handleExit}
        aria-label="退出房间"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--md-sys-color-on-surface-variant)] transition-colors hover:bg-[var(--md-sys-color-surface-container-high)] hover:text-[var(--md-sys-color-on-surface)]"
        title="退出房间"
      >
        <X className="h-3 w-3 text-[var(--md-sys-color-on-surface)]" />
      </button>
    </div>
  )
}
