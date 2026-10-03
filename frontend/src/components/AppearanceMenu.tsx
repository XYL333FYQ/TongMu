import { t, useTranslation } from '@/i18n'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Check,
  Image as ImageIcon,
  Moon,
  Palette,
  SlidersHorizontal,
  Sun,
} from 'lucide-react'
import { BackgroundSettingsPanel } from '@/components/BackgroundSettingsPanel'
import { Modal } from '@/components/ui/Modal'
import { Slider } from '@/components/ui/Slider'
import { Switch } from '@/components/ui/Switch'
import { PRESET_SEEDS } from '@/lib/themes'
import { cn } from '@/lib/utils'
import { RADIUS_PRESETS, useThemeStore } from '@/store/themeStore'
import { disclosureExitDuration } from './ui/motion'

export function AppearanceMenu() {
  useTranslation()

  const rootRef = useRef<HTMLDivElement>(null)
  const menuRef = useRef<HTMLElement>(null)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [open, setOpen] = useState(false)
  const [closing, setClosing] = useState(false)
  const [menuPosition, setMenuPosition] = useState({ top: 0, right: 0 })
  const [backgroundOpen, setBackgroundOpen] = useState(false)

  useEffect(() => {
    const openFromPage = () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
      setClosing(false)
      setOpen(true)
    }
    window.addEventListener('tongmu:open-appearance', openFromPage)
    return () =>
      window.removeEventListener('tongmu:open-appearance', openFromPage)
  }, [])
  const {
    isDark,
    setDark,
    sourceColor,
    setSourceColor,
    radius,
    setRadius,
    glassStrength,
    setGlassStrength,
    glassBlur,
    setGlassBlur,
    reducedMotion,
    setReducedMotion,
    disableHoverTransform,
    setDisableHoverTransform,
    cursorGlowEnabled,
    setCursorGlowEnabled,
    cursorGlowSize,
    setCursorGlowSize,
    cursorGlowOpacity,
    setCursorGlowOpacity,
    backgroundImage,
  } = useThemeStore()

  const closeMenu = () => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    setClosing(true)
    closeTimerRef.current = setTimeout(() => {
      setOpen(false)
      setClosing(false)
      closeTimerRef.current = null
    }, disclosureExitDuration())
  }

  useEffect(
    () => () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    },
    []
  )

  useEffect(() => {
    if (!open) return
    const position = () => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (rect)
        setMenuPosition({
          top: rect.bottom + 10,
          right: innerWidth - rect.right,
        })
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => {
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', position, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node
      if (
        !rootRef.current?.contains(target) &&
        !menuRef.current?.contains(target)
      )
        closeMenu()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMenu()
        rootRef.current?.querySelector('button')?.focus()
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={t('Appearance')}
        aria-expanded={open && !closing}
        aria-controls="tongmu-appearance-menu"
        title={t('Appearance')}
        onClick={() => {
          if (open && !closing) closeMenu()
          else {
            if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
            setClosing(false)
            setOpen(true)
          }
        }}
        className={cn(
          'inline-flex h-9 w-9 items-center justify-center rounded-xl text-[var(--md-sys-color-on-surface)] transition-colors',
          open
            ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
            : 'bg-[var(--glass-bg)] hover:bg-[var(--md-sys-color-surface-container-high)]'
        )}
      >
        <Palette className="h-4 w-4" aria-hidden="true" />
      </button>

      {open &&
        createPortal(
          <section
            ref={menuRef}
            id="tongmu-appearance-menu"
            role="dialog"
            aria-label={t('Appearance')}
            className={cn(
              'tongmu-appearance-menu fixed z-[70] max-h-[min(78vh,44rem)] w-[min(26rem,calc(100vw-2rem))] overflow-y-auto border border-[var(--glass-border)] bg-[var(--glass-bg)] p-5 text-[var(--md-sys-color-on-surface)]',
              closing ? 'zen-dropdown-exit' : 'zen-dropdown-enter'
            )}
            style={{
              top: menuPosition.top,
              right: innerWidth < 480 ? 16 : Math.max(16, menuPosition.right),
              width: 'min(26rem, calc(100vw - 2rem))',
            }}
          >
            <div
              className="zen-dropdown-item mb-3 flex items-center justify-between"
              style={{ '--item-index': 0 } as React.CSSProperties}
            >
              <div>
                <h2 className="text-sm font-semibold">{t('Appearance')}</h2>
                <p className="mt-0.5 text-xs text-[var(--md-sys-color-on-surface-variant)]">
                  {t('Saved in this browser')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDark(!isDark)}
                className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-[var(--md-sys-color-on-surface-variant)] transition-colors hover:bg-[var(--md-sys-color-surface-container-high)]"
              >
                {isDark ? (
                  <Moon className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <Sun className="h-4 w-4" aria-hidden="true" />
                )}
                {isDark ? t('Dark') : t('Light')}
              </button>
            </div>

            <div
              className="zen-dropdown-item border-t border-[var(--glass-border)] pt-3"
              style={{ '--item-index': 1 } as React.CSSProperties}
            >
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-[var(--md-sys-color-on-surface-variant)]">
                <Palette className="h-3.5 w-3.5" aria-hidden="true" />
                {t('Accent color')}
              </p>
              <div className="grid grid-cols-4 gap-1.5">
                {PRESET_SEEDS.map((seed) => {
                  const active = sourceColor === seed.color
                  return (
                    <button
                      key={seed.id}
                      type="button"
                      aria-label={t('Accent: {name}', { name: t(seed.name) })}
                      aria-pressed={active}
                      onClick={() => setSourceColor(seed.color)}
                      className={cn(
                        'flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[11px] transition-colors',
                        active
                          ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                          : 'text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-high)]'
                      )}
                    >
                      <span
                        className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full ring-1 ring-black/10"
                        style={{ backgroundColor: seed.color }}
                      >
                        {active && (
                          <Check
                            className="h-3 w-3 text-white"
                            aria-hidden="true"
                          />
                        )}
                      </span>
                      <span className="truncate">{t(seed.name)}</span>
                    </button>
                  )
                })}
              </div>
            </div>

            <div
              className="zen-dropdown-item mt-3 border-t border-[var(--glass-border)] pt-3"
              style={{ '--item-index': 2 } as React.CSSProperties}
            >
              <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-[var(--md-sys-color-on-surface-variant)]">
                <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden="true" />
                {t('Surface')}
              </p>
              <div className="space-y-2">
                <Slider
                  size="sm"
                  label={t('Glass opacity')}
                  value={Math.round((1 - glassStrength) * 100)}
                  min={0}
                  max={100}
                  valueFormatter={(value) => `${value}%`}
                  onChange={(value) => setGlassStrength(1 - value / 100)}
                />
                <Slider
                  size="sm"
                  label={t('Background blur')}
                  value={glassBlur}
                  min={0}
                  max={40}
                  valueFormatter={(value) => `${value}px`}
                  onChange={setGlassBlur}
                />
              </div>
              <p className="mb-2 mt-3 flex items-center gap-1.5 text-xs font-medium text-[var(--md-sys-color-on-surface-variant)]">
                {t('Corner radius')}
              </p>
              <div className="grid grid-cols-4 gap-1.5">
                {RADIUS_PRESETS.map((preset) => {
                  const active = radius === preset.value
                  return (
                    <button
                      key={preset.value}
                      type="button"
                      aria-pressed={active}
                      onClick={() => setRadius(preset.value)}
                      className={cn(
                        'rounded-lg px-2 py-1.5 text-xs transition-colors',
                        active
                          ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                          : 'text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-high)]'
                      )}
                    >
                      {t(preset.label)}
                    </button>
                  )
                })}
              </div>
            </div>

            <div
              className="zen-dropdown-item mt-3 space-y-2 border-t border-[var(--glass-border)] pt-3"
              style={{ '--item-index': 3 } as React.CSSProperties}
            >
              <p className="text-xs font-medium text-[var(--md-sys-color-on-surface-variant)]">
                {t('Pointer glow')}
              </p>
              <div className="flex items-center justify-between gap-4">
                <span className="text-xs">{t('Follow pointer')}</span>
                <Switch
                  aria-label={t('Pointer glow')}
                  checked={cursorGlowEnabled}
                  onChange={(event) =>
                    setCursorGlowEnabled(event.target.checked)
                  }
                />
              </div>
              {cursorGlowEnabled && (
                <div className="space-y-2 pb-1">
                  <Slider
                    size="sm"
                    label={t('Glow size')}
                    value={cursorGlowSize}
                    min={240}
                    max={1000}
                    step={20}
                    valueFormatter={(value) => `${value}px`}
                    onChange={setCursorGlowSize}
                  />
                  <Slider
                    size="sm"
                    label={t('Glow intensity')}
                    value={Math.round(cursorGlowOpacity * 100)}
                    min={0}
                    max={100}
                    valueFormatter={(value) => `${value}%`}
                    onChange={(value) => setCursorGlowOpacity(value / 100)}
                  />
                </div>
              )}
            </div>

            <div
              className="zen-dropdown-item mt-3 space-y-2 border-t border-[var(--glass-border)] pt-3"
              style={{ '--item-index': 4 } as React.CSSProperties}
            >
              <div className="flex items-center justify-between gap-4">
                <span className="text-xs">{t('Reduce motion')}</span>
                <Switch
                  aria-label={t('Reduce motion')}
                  checked={reducedMotion}
                  onChange={(event) => setReducedMotion(event.target.checked)}
                />
              </div>
              <div className="flex items-center justify-between gap-4">
                <span className="text-xs">
                  {t('Keep controls still on hover')}
                </span>
                <Switch
                  aria-label={t('Keep controls still on hover')}
                  checked={disableHoverTransform}
                  onChange={(event) =>
                    setDisableHoverTransform(event.target.checked)
                  }
                />
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                setOpen(false)
                setBackgroundOpen(true)
              }}
              className="zen-dropdown-item mt-3 flex w-full items-center gap-2 border-t border-[var(--glass-border)] pt-3 text-left text-xs text-[var(--md-sys-color-primary)] transition-colors hover:text-[var(--md-sys-color-on-surface)]"
              style={{ '--item-index': 5 } as React.CSSProperties}
            >
              <ImageIcon className="h-4 w-4" aria-hidden="true" />
              <span className="flex-1">{t('Custom background')}</span>
              <span className="text-[var(--md-sys-color-on-surface-variant)]">
                {backgroundImage ? t('Set') : t('Default')}
              </span>
            </button>
          </section>,
          document.body
        )}

      <Modal
        open={backgroundOpen}
        onClose={() => setBackgroundOpen(false)}
        title={t('Custom background')}
        className="max-w-xl"
      >
        <div className="mx-auto flex h-[min(560px,calc(100vh-9rem))] w-full max-w-[300px] flex-col overflow-hidden rounded-xl border border-[var(--glass-border)]">
          <BackgroundSettingsPanel
            open={backgroundOpen}
            onClose={() => setBackgroundOpen(false)}
          />
        </div>
      </Modal>
    </div>
  )
}
