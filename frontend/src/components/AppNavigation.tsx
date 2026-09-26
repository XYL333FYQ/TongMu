import { useEffect, useRef, useState } from 'react'
import { Menu } from 'lucide-react'
import { useLocation } from 'react-router-dom'

const destinations = [
  { label: '大厅', path: '/' },
  { label: '发现', path: '/rooms' },
]

/** Ordinary-page destinations share the header's guarded navigation action. */
export function AppNavigation({
  onNavigate,
  onJoin,
}: {
  onNavigate: (path: string) => void
  onJoin: () => void
}) {
  const { pathname } = useLocation()
  const [mobileOpen, setMobileOpen] = useState(false)
  const compactRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!mobileOpen) return
    const closeOutside = (event: PointerEvent) => {
      if (!compactRef.current?.contains(event.target as Node)) {
        setMobileOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false)
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [mobileOpen])

  const links = destinations.map(({ label, path }) => (
    <button
      key={path}
      type="button"
      aria-current={pathname === path ? 'page' : undefined}
      onClick={() => {
        setMobileOpen(false)
        onNavigate(path)
      }}
      className="tongmu-nav__link"
    >
      {label}
    </button>
  ))

  const joinAction = (
    <button
      type="button"
      className="tongmu-nav__link tongmu-nav__join"
      onClick={() => {
        setMobileOpen(false)
        onJoin()
      }}
    >
      加入房间
    </button>
  )

  return (
    <>
      <nav className="tongmu-nav__desktop" aria-label="主要导航">
        {links}
        {joinAction}
      </nav>
      <div ref={compactRef} className="tongmu-nav__compact">
        <button
          type="button"
          className="tongmu-nav__toggle"
          aria-label={mobileOpen ? '关闭主导航' : '打开主导航'}
          aria-expanded={mobileOpen}
          aria-controls="tongmu-primary-menu"
          onClick={() => setMobileOpen((open) => !open)}
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </button>
        {mobileOpen && (
          <nav
            id="tongmu-primary-menu"
            className="tongmu-nav__menu glass-strong"
            aria-label="主要导航"
          >
            {links}
            {joinAction}
          </nav>
        )}
      </div>
    </>
  )
}
