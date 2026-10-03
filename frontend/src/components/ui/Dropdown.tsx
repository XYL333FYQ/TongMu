import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useId,
} from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { t, useTranslation } from '@/i18n'
import { disclosureExitDuration } from './motion'

export interface DropdownOption {
  label: string
  value: string | number
  /** 禁用该 items：不Optional择，显示为灰色 */
  disabled?: boolean
}

export interface DropdownProps {
  label?: string
  error?: string
  options: DropdownOption[]
  value?: string | number
  placeholder?: string
  disabled?: boolean
  className?: string
  onChange?: (value: string) => void
}

export function Dropdown({
  label,
  error,
  options,
  value,
  placeholder = 'Choose an option',
  disabled = false,
  className,
  onChange,
}: DropdownProps) {
  useTranslation()
  const [open, setOpen] = useState(false)
  const [modalOwner, setModalOwner] = useState<string>()
  const generatedId = useId()
  const labelId = `${generatedId}-label`
  const valueId = `${generatedId}-value`
  const menuId = `${generatedId}-menu`
  const errorId = `${generatedId}-error`
  const [closing, setClosing] = useState(false)
  const [position, setPosition] = useState<{
    top: number
    left: number
    width: number
    placement: 'bottom' | 'top'
    maxHeight: number
  } | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const focusMenuOnOpenRef = useRef(false)
  // 记录上次测量到的菜单高度，用于判断是否需要重新定位（避免无限循环）
  const lastMeasuredHeightRef = useRef<number | null>(null)

  const selectedLabel =
    options.find((opt) => String(opt.value) === String(value))?.label ??
    t(placeholder)

  // 计算菜单位置：根据触发按钮位置和上下方可用空间，自动选择展开方向并限制最大高度
  // actualMenuHeight 用于在菜单渲染后用实测高度修正（首次为 null 走估算）
  const computePosition = useCallback(
    (actualMenuHeight?: number) => {
      if (!triggerRef.current) return
      setModalOwner(
        triggerRef.current.closest<HTMLElement>('[data-tongmu-modal]')?.dataset
          .tongmuModal
      )
      const rect = triggerRef.current.getBoundingClientRect()
      const viewportHeight = window.innerHeight
      const margin = 6
      const spaceBelow = viewportHeight - rect.bottom - margin
      const spaceAbove = rect.top - margin

      // 估算菜单自然高度：每项约 40px（py-2 + text-sm）+ 容器 padding 12px，上限 288px(max-h-72)
      const naturalHeight = Math.min(options.length * 40 + 12, 288)
      const menuHeight = actualMenuHeight ?? naturalHeight

      let top: number
      let placement: 'bottom' | 'top'
      let maxHeight: number

      if (spaceBelow >= menuHeight) {
        // 下方空间充足，向下展开
        top = rect.bottom + margin
        placement = 'bottom'
        maxHeight = 288
      } else if (spaceAbove >= menuHeight) {
        // 上方空间充足，向上展开（菜单底部贴触发按钮顶部）
        top = rect.top - menuHeight - margin
        placement = 'top'
        maxHeight = 288
      } else {
        // 上下都不够，选空间更大的一侧并限制 maxHeight
        if (spaceBelow >= spaceAbove) {
          top = rect.bottom + margin
          placement = 'bottom'
          maxHeight = Math.max(spaceBelow, 120)
        } else {
          // 向上展开，顶部贴近视口顶部
          top = Math.max(margin, rect.top - spaceAbove)
          placement = 'top'
          maxHeight = Math.max(spaceAbove, 120)
        }
      }

      setPosition({
        top,
        left: rect.left,
        width: rect.width,
        placement,
        maxHeight,
      })
    },
    [options.length]
  )

  const closeMenu = useCallback(() => {
    if (!open) return
    setClosing(true)
    setTimeout(() => {
      setOpen(false)
      setClosing(false)
      setPosition(null)
      lastMeasuredHeightRef.current = null
    }, disclosureExitDuration())
  }, [open])

  useEffect(() => {
    if (!open || !position || !focusMenuOnOpenRef.current) return
    focusMenuOnOpenRef.current = false
    const options = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="option"]:not([disabled])'
      ) ?? []
    )
    const initialOption =
      options.find(
        (option) => option.getAttribute('aria-selected') === 'true'
      ) ?? options[0]
    initialOption?.focus()
  }, [open, position])

  useEffect(() => {
    if (!open) return
    computePosition()
    const handler = () => {
      lastMeasuredHeightRef.current = null
      computePosition()
    }
    window.addEventListener('resize', handler)
    window.addEventListener('scroll', handler, true)
    return () => {
      window.removeEventListener('resize', handler)
      window.removeEventListener('scroll', handler, true)
    }
  }, [open, computePosition])

  // 菜单渲染后用实测高度修正位置（绘制前同步执行，避免闪烁）
  // 仅当实测高度与上次差异较大时重新计算，防止无限循环
  useLayoutEffect(() => {
    if (!open || !menuRef.current || !position) return
    const actualHeight = menuRef.current.scrollHeight
    if (
      lastMeasuredHeightRef.current === null ||
      Math.abs(actualHeight - lastMeasuredHeightRef.current) > 4
    ) {
      lastMeasuredHeightRef.current = actualHeight
      computePosition(actualHeight)
    }
  }, [open, position, computePosition])

  useEffect(() => {
    if (!open) return
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node
      if (
        triggerRef.current?.contains(target) ||
        menuRef.current?.contains(target)
      ) {
        return
      }
      closeMenu()
    }
    window.addEventListener('mousedown', handleClick)
    return () => window.removeEventListener('mousedown', handleClick)
  }, [open, closeMenu])

  const handleSelect = (opt: DropdownOption) => {
    onChange?.(String(opt.value))
    closeMenu()
    triggerRef.current?.focus()
  }

  const handleMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeMenu()
      triggerRef.current?.focus()
      return
    }
    if (event.key === 'Tab') {
      closeMenu()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const enabled = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="option"]:not([disabled])'
      ) ?? []
    )
    if (!enabled.length) return
    event.preventDefault()
    const current = enabled.indexOf(document.activeElement as HTMLButtonElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? enabled.length - 1
          : event.key === 'ArrowDown'
            ? (current + 1) % enabled.length
            : (current - 1 + enabled.length) % enabled.length
    enabled[next].focus()
  }

  return (
    <div className={cn('w-full text-left', className)}>
      {label && (
        <span
          id={labelId}
          className="mb-1.5 block text-sm font-medium text-[var(--md-sys-color-on-surface-variant)]"
        >
          {label}
        </span>
      )}
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open && !closing}
        aria-controls={open ? menuId : undefined}
        aria-labelledby={label ? `${labelId} ${valueId}` : undefined}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        onClick={() => {
          if (open) {
            closeMenu()
          } else {
            focusMenuOnOpenRef.current = true
            setOpen(true)
            setClosing(false)
          }
        }}
        onKeyDown={(event) => {
          if (
            open ||
            !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)
          )
            return
          event.preventDefault()
          focusMenuOnOpenRef.current = true
          setOpen(true)
          setClosing(false)
        }}
        className={cn(
          'zen-input-glow w-full flex items-center justify-between gap-2 rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-high)] px-3 py-2 text-sm text-[var(--md-sys-color-on-surface)] focus:border-[var(--md-sys-color-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--md-sys-color-primary)] disabled:cursor-not-allowed disabled:bg-[var(--md-sys-color-surface-container)] disabled:opacity-60',
          'transition-all duration-200',
          'hover:border-[var(--md-sys-color-primary)] hover:shadow-sm',
          error &&
            'border-[var(--md-sys-color-error)] focus:border-[var(--md-sys-color-error)] focus:ring-[var(--md-sys-color-error)]'
        )}
      >
        <span id={valueId} className="truncate">
          {selectedLabel}
        </span>
        <ChevronDown
          className={cn(
            'h-4 w-4 shrink-0 text-[var(--md-sys-color-on-surface-variant)] transition-transform duration-200',
            open && !closing && 'rotate-180'
          )}
        />
      </button>
      {error && (
        <p
          id={errorId}
          className="mt-1 text-xs text-[var(--md-sys-color-error)]"
        >
          {t(error)}
        </p>
      )}

      {open &&
        position &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            role="listbox"
            data-tongmu-modal-owner={modalOwner}
            aria-labelledby={label ? labelId : valueId}
            onKeyDown={handleMenuKeyDown}
            className={cn(
              'glass-strong fixed overflow-auto rounded-[var(--md-sys-shape-corner)] p-1.5 shadow-lg',
              closing ? 'zen-dropdown-exit' : 'zen-dropdown-enter'
            )}
            style={{
              top: `${position.top}px`,
              left: `${position.left}px`,
              width: `${position.width}px`,
              maxHeight: `${position.maxHeight}px`,
              zIndex: 1000,
              transformOrigin:
                position.placement === 'top' ? 'bottom center' : 'top center',
              boxShadow:
                '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-primary) 25%, transparent)',
            }}
          >
            {options.map((opt, index) => {
              const active = String(opt.value) === String(value)
              const optDisabled = opt.disabled === true
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  disabled={optDisabled}
                  onClick={() => {
                    if (optDisabled) return
                    handleSelect(opt)
                  }}
                  className={cn(
                    'zen-dropdown-item flex w-full items-center justify-between gap-2 rounded-[var(--md-sys-shape-corner)] px-3 py-2 text-left text-sm transition-all',
                    optDisabled
                      ? 'cursor-not-allowed text-[var(--md-sys-color-on-surface)] opacity-40'
                      : active
                        ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                        : 'text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
                  )}
                  style={
                    {
                      '--item-index': Math.min(index, 5),
                    } as React.CSSProperties
                  }
                >
                  <span className="truncate">{opt.label}</span>
                  {active && <Check className="h-3.5 w-3.5 shrink-0" />}
                </button>
              )
            })}
          </div>,
          document.body
        )}
    </div>
  )
}
