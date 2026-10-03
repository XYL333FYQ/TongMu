import { t, useTranslation } from '@/i18n'
import { forwardRef, useState, useId } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface InputPasswordProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'size' | 'type'
> {
  label?: string
  error?: string
  size?: 'sm' | 'md' | 'lg'
}

export const InputPassword = forwardRef<HTMLInputElement, InputPasswordProps>(
  ({ label, error, size = 'md', className, ...props }, ref) => {
    useTranslation()

    const [visible, setVisible] = useState(false)
    const generatedId = useId()
    const inputId = props.id ?? generatedId
    const errorId = `${inputId}-error`

    const sizes = {
      sm: 'px-2.5 py-1.5 pr-9 text-xs',
      md: 'px-3 py-2 pr-10 text-sm',
      lg: 'px-4 py-3 pr-11 text-base',
    }

    return (
      <div className={cn('w-full text-left', className)}>
        {label && (
          <label
            htmlFor={inputId}
            className="mb-1.5 block text-sm font-medium text-[var(--md-sys-color-on-surface-variant)]"
          >
            {label}
          </label>
        )}
        <div className="relative">
          <input
            ref={ref}
            type={visible ? 'text' : 'password'}
            className={cn(
              'w-full rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-high)] text-[var(--md-sys-color-on-surface)] placeholder:text-[var(--md-sys-color-on-surface-variant)] focus:border-[var(--md-sys-color-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--md-sys-color-primary)] disabled:cursor-not-allowed disabled:bg-[var(--md-sys-color-surface-container)] disabled:opacity-60',
              sizes[size],
              error &&
                'border-[var(--md-sys-color-error)] focus:border-[var(--md-sys-color-error)] focus:ring-[var(--md-sys-color-error)]'
            )}
            {...props}
            id={inputId}
            aria-invalid={error ? true : props['aria-invalid']}
            aria-describedby={
              [props['aria-describedby'], error ? errorId : undefined]
                .filter(Boolean)
                .join(' ') || undefined
            }
          />
          <button
            type="button"
            aria-label={visible ? t('Hide password') : t('Show password')}
            onClick={() => setVisible((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container)] hover:text-[var(--md-sys-color-on-surface)]"
          >
            {visible ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </button>
        </div>
        {error && (
          <p
            id={errorId}
            role="alert"
            className="mt-1 text-xs text-[var(--md-sys-color-error)]"
          >
            {t(error)}
          </p>
        )}
      </div>
    )
  }
)

InputPassword.displayName = 'InputPassword'
