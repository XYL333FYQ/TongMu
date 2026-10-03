import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useId,
} from 'react'
import { cn } from '@/lib/utils'
import { t, useTranslation } from '@/i18n'

export interface Rule {
  required?: boolean
  message?: string
  min?: number
  max?: number
  type?: 'number'
  validator?: (
    value: unknown,
    values: Record<string, unknown>
  ) => string | undefined
}

interface FormContextValue {
  values: Record<string, unknown>
  errors: Record<string, string | undefined>
  setFieldValue: (name: string, value: unknown) => void
  registerField: (name: string, rules: Rule[]) => void
}

const FormContext = createContext<FormContextValue | null>(null)

function useFormContext() {
  const ctx = useContext(FormContext)
  if (!ctx) throw new Error('Form.Item must be used inside Form')
  return ctx
}

export interface FormProps<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  initialValues?: T
  onFinish?: (values: T) => void
  onFinishFailed?: (errors: Record<string, string | undefined>) => void
  layout?: 'vertical' | 'horizontal'
  children: React.ReactNode
  className?: string
}

export function Form<
  T extends Record<string, unknown> = Record<string, unknown>,
>({
  initialValues = {} as T,
  onFinish,
  onFinishFailed,
  layout = 'vertical',
  children,
  className,
}: FormProps<T>) {
  const [values, setValues] = useState<T>(initialValues)
  const [errors, setErrors] = useState<Record<string, string | undefined>>({})
  const [fieldRules] = useState<Map<string, Rule[]>>(new Map())

  const setFieldValue = useCallback((name: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [name]: value }))
    setErrors((prev) => ({ ...prev, [name]: undefined }))
  }, [])

  const registerField = useCallback(
    (name: string, rules: Rule[]) => {
      if (!fieldRules.has(name)) {
        fieldRules.set(name, rules)
      }
    },
    [fieldRules]
  )

  const validate = useCallback(() => {
    const nextErrors: Record<string, string | undefined> = {}
    let valid = true
    fieldRules.forEach((rules, name) => {
      const value = values[name]
      for (const rule of rules) {
        if (rule.required && (value === undefined || value === '')) {
          nextErrors[name] = rule.message ?? 'This field is required.'
          valid = false
          break
        }
        if (rule.type === 'number' && value !== undefined && value !== '') {
          const num = Number(value)
          if (Number.isNaN(num)) {
            nextErrors[name] = rule.message ?? 'Enter a number.'
            valid = false
            break
          }
          if (rule.min !== undefined && num < rule.min) {
            nextErrors[name] = rule.message ?? `The minimum is ${rule.min}.`
            valid = false
            break
          }
          if (rule.max !== undefined && num > rule.max) {
            nextErrors[name] = rule.message ?? `The maximum is ${rule.max}.`
            valid = false
            break
          }
        }
        if (rule.validator) {
          const err = rule.validator(value, values)
          if (err) {
            nextErrors[name] = err
            valid = false
            break
          }
        }
      }
    })
    setErrors(nextErrors)
    return { valid, errors: nextErrors }
  }, [fieldRules, values])

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault()
      const { valid, errors: nextErrors } = validate()
      if (valid) {
        onFinish?.(values)
      } else {
        onFinishFailed?.(nextErrors)
      }
    },
    [validate, values, onFinish, onFinishFailed]
  )

  const contextValue = useMemo(
    () => ({ values, errors, setFieldValue, registerField }),
    [values, errors, setFieldValue, registerField]
  )

  return (
    <FormContext.Provider value={contextValue}>
      <form
        onSubmit={handleSubmit}
        className={cn(
          layout === 'vertical' ? 'space-y-4' : 'space-y-4',
          className
        )}
      >
        {children}
      </form>
    </FormContext.Provider>
  )
}

export interface FormItemProps {
  label?: string
  name?: string
  rules?: Rule[]
  children:
    | React.ReactNode
    | ((props: {
        value: unknown
        onChange: (value: unknown) => void
        error?: string
      }) => React.ReactNode)
  className?: string
}

Form.Item = function FormItem({
  label,
  name,
  rules = [],
  children,
  className,
}: FormItemProps) {
  useTranslation()
  const ctx = useFormContext()
  const generatedId = useId()

  if (name) {
    ctx.registerField(name, rules)
  }

  const value = name ? ctx.values[name] : undefined
  const error = name ? ctx.errors[name] : undefined

  const onChange = useCallback(
    (newValue: unknown) => {
      if (name) {
        ctx.setFieldValue(name, newValue)
      }
    },
    [ctx, name]
  )

  const childNode =
    typeof children === 'function'
      ? children({ value, onChange, error })
      : children

  const firstControl = React.Children.toArray(childNode).find(
    React.isValidElement
  )
  const inputId =
    React.isValidElement<{ id?: unknown }>(firstControl) &&
    typeof firstControl.props.id === 'string'
      ? firstControl.props.id
      : `form-field-${generatedId}`
  const errorId = `${inputId}-form-error`

  return (
    <div className={cn('text-left', className)}>
      {label && (
        <label
          htmlFor={name ? inputId : undefined}
          className="mb-1.5 block text-sm font-medium text-[var(--md-sys-color-on-surface-variant)]"
        >
          {label}
        </label>
      )}
      {name ? (
        <ValueBinder
          value={value}
          onChange={onChange}
          inputId={inputId}
          errorId={errorId}
          error={error}
        >
          {childNode}
        </ValueBinder>
      ) : (
        childNode
      )}
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

function ValueBinder({
  value,
  onChange,
  children,
  inputId,
  errorId,
  error,
}: {
  value: unknown
  onChange: (value: unknown) => void
  children: React.ReactNode
  inputId: string
  errorId: string
  error?: string
}) {
  return (
    <>
      {React.Children.map(children, (child) => {
        if (!React.isValidElement(child)) return child
        const childType = child.type
        const displayName =
          typeof childType === 'function' || typeof childType === 'object'
            ? (childType as { displayName?: string }).displayName
            : undefined
        const accessibleProps = {
          id: child.props.id ?? inputId,
          'aria-invalid': error ? true : child.props['aria-invalid'],
          'aria-describedby':
            [child.props['aria-describedby'], error ? errorId : undefined]
              .filter(Boolean)
              .join(' ') || undefined,
        }

        // 原生 input/select/textarea：注入 value + 事件 onChange
        if (
          typeof childType === 'string' &&
          ['input', 'select', 'textarea'].includes(childType)
        ) {
          return React.cloneElement(
            child as React.ReactElement<
              React.InputHTMLAttributes<HTMLInputElement>
            >,
            {
              ...accessibleProps,
              value: value ?? '',
              onChange: (
                e: React.ChangeEvent<
                  HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
                >
              ) => {
                onChange(e.target.value)
                ;(child.props.onChange as ((e: unknown) => void) | undefined)?.(
                  e
                )
              },
            } as unknown as Record<string, unknown>
          )
        }

        // Switch：使用 checked + 事件 onChange
        if (displayName === 'Switch') {
          return React.cloneElement(
            child as React.ReactElement<
              React.InputHTMLAttributes<HTMLInputElement>
            >,
            {
              ...accessibleProps,
              checked: !!value,
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
                onChange(e.target.checked)
                ;(child.props.onChange as ((e: unknown) => void) | undefined)?.(
                  e
                )
              },
            } as unknown as Record<string, unknown>
          )
        }

        // Input / InputPassword：事件 onChange，由组件透传给原生 input
        if (displayName === 'Input' || displayName === 'InputPassword') {
          return React.cloneElement(
            child as React.ReactElement<
              React.InputHTMLAttributes<HTMLInputElement>
            >,
            {
              ...accessibleProps,
              value: value ?? '',
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
                onChange(e.target.value)
                ;(child.props.onChange as ((e: unknown) => void) | undefined)?.(
                  e
                )
              },
            } as unknown as Record<string, unknown>
          )
        }

        // 自定义组件（InputNumber / Select 等）：注入 value + value onChange
        return React.cloneElement(child, {
          ...accessibleProps,
          value: value ?? '',
          onChange: (newValue: unknown) => {
            onChange(newValue)
            ;(child.props.onChange as ((v: unknown) => void) | undefined)?.(
              newValue
            )
          },
        } as Record<string, unknown>)
      })}
    </>
  )
}
