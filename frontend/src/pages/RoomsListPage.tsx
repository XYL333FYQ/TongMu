import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
  LayoutGrid,
  List,
  Lock,
  Unlock,
  RefreshCw,
  PlayCircle,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Text } from '@/components/ui/Typography'
import { Tag } from '@/components/ui/Tag'
import { Spinner } from '@/components/ui/Spinner'
import { useAuthStore } from '@/store/authStore'
import type { RoomDirectoryView } from '@/hooks/useRoomDirectory'
import { roomPath, type RoomListItem } from '@/lib/roomDirectory'
import { cn } from '@/lib/utils'
import { formatRecentTime } from '@/lib/formatTime'
import { useHideBodyScrollbar } from '@/hooks/useHideBodyScrollbar'

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

export default function RoomsListPage({
  directory,
}: {
  directory: RoomDirectoryView
}) {
  useHideBodyScrollbar()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { isAuthenticated, authResolved } = useAuthStore()
  const { rooms, loading, error, refresh: loadData } = directory
  const query = searchParams.get('q') ?? ''
  const [modeFilter, setModeFilter] = useState('all')
  const [onlineOnly, setOnlineOnly] = useState(false)
  const [sort, setSort] = useState('recent')
  const [viewMode, setViewMode] = useState<'list' | 'tile'>(() => {
    const saved = localStorage.getItem('rooms-list-view-mode')
    return saved === 'list' ? 'list' : 'tile'
  })

  /** 创建时间：<24h 显示相对时间，≥24h 显示准确时间（公共 formatRecentTime） */
  const formatDate = formatRecentTime

  const getModeLabel = (mode: RoomListItem['mode']) => {
    if (mode === 'watch-together') return '一起看'
    return '屏幕共享'
  }

  const visibleRooms = rooms
    .filter(
      (room) =>
        (!onlineOnly || room.sharerOnline) &&
        (modeFilter === 'all' || room.mode === modeFilter) &&
        `${room.name ?? ''} ${room.roomId}`
          .toLowerCase()
          .includes(query.trim().toLowerCase())
    )
    .sort((a, b) => {
      if (sort === 'viewers')
        return b.viewerCount - a.viewerCount || a.roomId.localeCompare(b.roomId)
      const time = (value: string) => Date.parse(value) || 0
      return sort === 'newest'
        ? time(b.createdAt) - time(a.createdAt)
        : time(b.lastAccessedAt) - time(a.lastAccessedAt)
    })

  return (
    <section
      className="tongmu-rooms-page"
      aria-labelledby="hall-discover-title"
    >
      <div className="tongmu-rooms-page__content">
        <header className="tongmu-hall__directory-head">
          <p className="tongmu-home__section-kicker">TongMu 大厅</p>
          <h1 id="hall-discover-title">发现房间</h1>
          <p>浏览正在进行的房间，找到想一起看的伙伴。</p>
        </header>

        <Fade delay={160}>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div
              className="glass flex items-center gap-1.5 rounded-[var(--md-sys-shape-corner)] px-3 py-1.5 text-sm font-medium"
              style={{
                color: 'var(--md-sys-color-on-surface-variant)',
              }}
            >
              <span>共</span>
              <span
                className="min-w-[1.25rem] text-center font-semibold"
                style={{ color: 'var(--md-sys-color-on-surface)' }}
              >
                {rooms.length}
              </span>
              <span>
                个房间 · {rooms.filter((room) => room.sharerOnline).length}{' '}
                个房主在线
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div
                className="inline-flex rounded-[var(--md-sys-shape-corner)] border p-0.5"
                style={{ borderColor: 'var(--md-sys-color-outline)' }}
              >
                <button
                  type="button"
                  onClick={() => {
                    setViewMode('list')
                    localStorage.setItem('rooms-list-view-mode', 'list')
                  }}
                  className="flex items-center gap-1.5 rounded-[calc(var(--md-sys-shape-corner)-2px)] px-2.5 py-1.5 text-sm font-medium transition-all"
                  style={{
                    backgroundColor:
                      viewMode === 'list'
                        ? 'var(--md-sys-color-primary-container)'
                        : 'transparent',
                    color:
                      viewMode === 'list'
                        ? 'var(--md-sys-color-on-primary-container)'
                        : 'var(--md-sys-color-on-surface)',
                  }}
                  aria-label="列表视图"
                  title="列表视图"
                >
                  <List className="h-4 w-4" />
                  <span className="hidden sm:inline">列表</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setViewMode('tile')
                    localStorage.setItem('rooms-list-view-mode', 'tile')
                  }}
                  className="flex items-center gap-1.5 rounded-[calc(var(--md-sys-shape-corner)-2px)] px-2.5 py-1.5 text-sm font-medium transition-all"
                  style={{
                    backgroundColor:
                      viewMode === 'tile'
                        ? 'var(--md-sys-color-primary-container)'
                        : 'transparent',
                    color:
                      viewMode === 'tile'
                        ? 'var(--md-sys-color-on-primary-container)'
                        : 'var(--md-sys-color-on-surface)',
                  }}
                  aria-label="平铺视图"
                  title="平铺视图"
                >
                  <LayoutGrid className="h-4 w-4" />
                  <span className="hidden sm:inline">平铺</span>
                </button>
              </div>
              <Button
                variant="secondary"
                size="sm"
                icon={<RefreshCw className="h-4 w-4" />}
                onClick={() => void loadData()}
                disabled={loading}
              >
                刷新
              </Button>
            </div>
          </div>
        </Fade>

        <div className="tongmu-directory-filters">
          <select
            aria-label="房间类型"
            className="hall-select"
            value={modeFilter}
            onChange={(event) => setModeFilter(event.target.value)}
          >
            <option value="all">全部房间</option>
            <option value="watch-together">一起看</option>
            <option value="screen-share">屏幕共享</option>
          </select>
          <details className="tongmu-directory-filters__more">
            <summary>
              更多筛选{onlineOnly || sort !== 'recent' ? ' · 已设置' : ''}
            </summary>
            <div className="tongmu-directory-filters__advanced">
              <select
                aria-label="房间排序"
                className="hall-select"
                value={sort}
                onChange={(event) => setSort(event.target.value)}
              >
                <option value="recent">最近活跃</option>
                <option value="newest">最新创建</option>
                <option value="viewers">观众最多</option>
              </select>
              <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                <input
                  type="checkbox"
                  checked={onlineOnly}
                  onChange={(event) => setOnlineOnly(event.target.checked)}
                  className="h-4 w-4 accent-[var(--md-sys-color-primary)]"
                />
                仅看房主在线
              </label>
            </div>
          </details>
        </div>
        <div className="tongmu-directory-results text-xs text-[var(--md-sys-color-on-surface-variant)]">
          {!loading && !error && (
            <span role="status">
              显示 {visibleRooms.length} / {rooms.length} 个房间
            </span>
          )}
        </div>
        {authResolved && !isAuthenticated ? (
          <div role="status" className="py-10 text-center">
            连接不可用，请刷新页面或检查服务器地址。
          </div>
        ) : error ? (
          <div role="alert" className="py-10 text-center">
            <p>{error}</p>
            <Button className="mt-3" onClick={() => void loadData()}>
              重试
            </Button>
          </div>
        ) : loading ? (
          <Fade delay={200}>
            <div className="py-12">
              <Spinner tip="加载中..." size={32} />
            </div>
          </Fade>
        ) : (
          <div
            className={
              viewMode === 'tile'
                ? 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3'
                : 'grid gap-3'
            }
          >
            {visibleRooms.length === 0 ? (
              <Fade delay={200} className="col-span-full">
                <div className="col-span-full py-12 text-center">
                  <Text type="secondary">
                    {rooms.length
                      ? '没有匹配的房间，试试调整搜索或筛选条件。'
                      : '暂时还没有房间，邀请朋友开启第一场放映吧。'}
                  </Text>
                </div>
              </Fade>
            ) : (
              visibleRooms.map((room, idx) => (
                <div
                  key={room.id}
                  className={cn(
                    'room-discovery-card zen-stagger-fade-up glass-card flex min-w-0 flex-col gap-4 p-4 transition-colors',
                    viewMode !== 'tile' &&
                      'sm:flex-row sm:items-center sm:justify-between'
                  )}
                  style={
                    {
                      '--stagger-delay': `${Math.min(200 + idx * 30, 500)}ms`,
                    } as React.CSSProperties
                  }
                >
                  <div className="min-w-0 flex-1">
                    <div className="room-discovery-card__primary">
                      <strong className="room-discovery-card__name">
                        {room.name || room.roomId}
                      </strong>
                      <span className="room-discovery-card__mode">
                        {getModeLabel(room.mode)}
                      </span>
                    </div>
                    <div className="room-discovery-card__meta">
                      <Tag
                        color={
                          room.status === 'active' && room.sharerOnline
                            ? 'success'
                            : 'default'
                        }
                      >
                        {room.status !== 'active'
                          ? '已关闭'
                          : room.sharerOnline
                            ? '房主在线'
                            : '房主离线'}
                      </Tag>
                      {room.requireApproval ? (
                        <Tag color="warning">需确认</Tag>
                      ) : (
                        <Tag color="default">直接加入</Tag>
                      )}
                      {room.hasPassword ? (
                        <Tag color="purple">
                          <Lock className="mr-1 inline h-3 w-3" />
                          有密码
                        </Tag>
                      ) : (
                        <Tag color="default">
                          <Unlock className="mr-1 inline h-3 w-3" />
                          无密码
                        </Tag>
                      )}
                    </div>
                    <dl className="room-discovery-card__details">
                      <dt>人数</dt>
                      <dd className="room-discovery-card__count">
                        {room.viewerCount} / {room.maxViewers}
                      </dd>
                      <dt>房间号</dt>
                      <dd className="truncate text-right font-mono">
                        {room.roomId}
                      </dd>
                      <dt>最近活跃</dt>
                      <dd className="truncate text-right">
                        {formatDate(room.lastAccessedAt)}
                      </dd>
                    </dl>
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    className={viewMode === 'tile' ? 'mt-auto w-full' : ''}
                    icon={<PlayCircle className="h-4 w-4" />}
                    onClick={() =>
                      navigate(roomPath(room.roomId) ?? '/', {
                        state: {
                          fromList: true,
                          hasPassword: room.hasPassword,
                          name: room.name,
                        },
                      })
                    }
                    disabled={room.status !== 'active'}
                  >
                    加入房间
                  </Button>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </section>
  )
}
