import { t, useTranslation } from '@/i18n'
import { useEffect, useRef } from 'react'
import { Menu, LayoutGrid, DoorOpen } from 'lucide-react'
import { useLocation } from 'react-router-dom'
import { useDisclosureMotion } from './ui/useDisclosureMotion'

const destinations = [{ label: 'Hall', path: '/' }]

/** Ordinary-page destinations share the header's guarded navigation action. */
export function AppNavigation({
  onNavigate,
  onJoin,
}: {
  onNavigate: (path: string) => void
  onJoin: () => void
}) {
  useTranslation()

  const { pathname } = useLocation()
  const hasJoinAction = pathname !== '/' && pathname !== '/rooms'
  const { open: mobileOpen, closing, show, close } = useDisclosureMotion()
  const compactRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!mobileOpen) return
    const closeOutside = (event: PointerEvent) => {
      if (!compactRef.current?.contains(event.target as Node)) {
        close()
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        close()
        compactRef.current?.querySelector('button')?.focus()
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [mobileOpen, close])

  const links = destinations.map(({ label, path }) => (
    <button
      key={path}
      type="button"
      aria-current={
        pathname === path || (path === '/' && pathname === '/rooms')
          ? 'page'
          : undefined
      }
      onClick={() => {
        close()
        onNavigate(path)
      }}
      className="tongmu-nav__link"
    >
      <LayoutGrid size={16} aria-hidden="true" />
      {t(label)}
    </button>
  ))

  const joinAction = (
    <button
      type="button"
      className="tongmu-nav__link tongmu-nav__join"
      onClick={() => {
        close()
        onJoin()
      }}
    >
      <DoorOpen size={16} aria-hidden="true" />
      {t('Join by ID')}
    </button>
  )

  return (
    <>
      <nav
        className={`tongmu-nav__desktop${hasJoinAction ? ' tongmu-nav__desktop--with-join' : ''}`}
        aria-label={t('Main navigation')}
      >
        {links}
        {hasJoinAction && joinAction}
      </nav>
      <div
        ref={compactRef}
        className={`tongmu-nav__compact${hasJoinAction ? ' tongmu-nav__compact--with-join' : ''}`}
      >
        <button
          type="button"
          className="tongmu-nav__toggle"
          aria-label={
            mobileOpen && !closing
              ? t('Close navigation')
              : t('Open navigation')
          }
          aria-expanded={mobileOpen && !closing}
          aria-controls="tongmu-primary-menu"
          onClick={() => (mobileOpen && !closing ? close() : show())}
        >
          <Menu className="h-5 w-5" aria-hidden="true" />
        </button>
        {mobileOpen && (
          <nav
            id="tongmu-primary-menu"
            className={`tongmu-nav__menu glass-strong ${closing ? 'zen-dropdown-exit' : 'zen-dropdown-enter'}`}
            aria-label={t('Main navigation')}
          >
            {links}
            {hasJoinAction && joinAction}
          </nav>
        )}
      </div>
    </>
  )
}
