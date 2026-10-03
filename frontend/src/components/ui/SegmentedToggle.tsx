import { cn } from '@/lib/utils'

export interface SegmentedToggleOption {
  value: string
  label: string
}

export interface SegmentedToggleProps {
  options: SegmentedToggleOption[]
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
}

export function SegmentedToggle({
  options,
  value,
  onChange,
  disabled = false,
  className,
}: SegmentedToggleProps) {
  return (
    <div
      className={cn(
        'flex min-w-0 items-center gap-1 rounded-xl border border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface-container-low)] p-1',
        disabled && 'opacity-50',
        className
      )}
      role="group"
      aria-disabled={disabled}
    >
      {options.map((option) => {
        const isActive = option.value === value
        return (
          <button
            key={option.value}
            type="button"
            data-segment={option.value}
            onClick={() => onChange(option.value)}
            disabled={disabled}
            aria-pressed={isActive}
            className={cn(
              'min-w-0 flex-1 rounded-lg px-3 py-2 text-xs font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--md-sys-color-primary)] disabled:cursor-not-allowed',
              isActive
                ? 'bg-[var(--md-sys-color-primary)] text-[var(--md-sys-color-on-primary)] shadow-sm'
                : 'text-[var(--md-sys-color-on-surface-variant)] hover:text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-high)] active:bg-[var(--md-sys-color-secondary-container)]'
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}
