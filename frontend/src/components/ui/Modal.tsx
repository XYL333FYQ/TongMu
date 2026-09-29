import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from './Button'

const MODAL_ANIMATION_DURATION = 220

export interface ModalProps {
  open: boolean
  onClose: () => void
  title?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  className?: string
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  className,
}: ModalProps) {
  const [visible, setVisible] = useState(open)
  const [exiting, setExiting] = useState(false)
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const prevOpenRef = useRef(open)
  const dialogRef = useRef<HTMLDivElement>(null)
  const openerRef = useRef<HTMLElement | null>(null)
  const onCloseRef = useRef(onClose)
  const openRef = useRef(open)
  const titleId = useId()

  useEffect(() => { onCloseRef.current = onClose }, [onClose])
  useEffect(() => { openRef.current = open }, [open])

  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setVisible(true)
      setExiting(false)
    } else if (!open && prevOpenRef.current) {
      setExiting(true)
      closeTimerRef.current = setTimeout(() => {
        setVisible(false)
        setExiting(false)
      }, MODAL_ANIMATION_DURATION)
    }
    prevOpenRef.current = open

    return () => {
      if (closeTimerRef.current) {
        clearTimeout(closeTimerRef.current)
      }
    }
  }, [open])

  // Modal 打开期间锁定 body 滚动，避免滚轮穿透到底层页面
  useEffect(() => {
    if (!visible) return
    const prevOverflow = document.body.style.overflow
    const prevPaddingRight = document.body.style.paddingRight
    document.body.style.overflow = 'hidden'
    // 补偿滚动条消失后的宽度跳变
    const scrollbarWidth =
      window.innerWidth - document.documentElement.clientWidth
    if (scrollbarWidth > 0) {
      document.body.style.paddingRight = `${scrollbarWidth}px`
    }
    return () => {
      document.body.style.overflow = prevOverflow
      document.body.style.paddingRight = prevPaddingRight
    }
  }, [visible])

  useEffect(() => {
    if (!visible) return
    const dialog = dialogRef.current
    if (!dialog) return
    openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusableSelector = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const focusables = () => Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
      .filter((element) => element.getClientRects().length > 0 && !element.closest('[aria-hidden="true"]'))
    const initialFocus = focusables()[0] ?? dialog
    initialFocus.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[data-tongmu-modal]')
      if (dialogs[dialogs.length - 1] !== dialog) return
      if (e.key === 'Escape' && openRef.current) {
        e.preventDefault()
        e.stopPropagation()
        onCloseRef.current()
      }
      if (e.key !== 'Tab') return
      const items = focusables()
      if (!items.length) { e.preventDefault(); dialog.focus(); return }
      const first = items[0]
      const last = items[items.length - 1]
      if (e.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        e.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (openerRef.current?.isConnected) openerRef.current.focus()
      openerRef.current = null
    }
  }, [visible])

  if (!visible) return null

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ zIndex: 999, transform: 'translateZ(0)' }}
      // 阻止滚轮事件冒泡到 document，防止触发底层页面滚动
      onWheel={(e) => e.stopPropagation()}
    >
      <div
        className={cn(
          'absolute inset-0 bg-black/40',
          exiting ? 'zen-modal-backdrop-exit' : 'zen-modal-backdrop-enter'
        )}
        style={{
          // 蒙层模糊度跟随主题设置（取 glass-blur 的 40%，避免大模糊度时背景过度模糊）
          backdropFilter: 'blur(var(--glass-blur-mask))',
          WebkitBackdropFilter: 'blur(var(--glass-blur-mask))',
        }}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        data-tongmu-modal
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : '对话框'}
        tabIndex={-1}
        className={cn(
          'glass-strong relative z-10 flex w-full max-w-md flex-col overflow-hidden rounded-[var(--md-sys-shape-corner)] p-6 shadow-lg',
          exiting ? 'zen-modal-content-exit' : 'zen-modal-content-enter',
          className
        )}
        style={{
          maxHeight: 'calc(100vh - 2rem)',
          boxShadow:
            '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-primary) 25%, transparent)',
        }}
      >
        <div className="flex shrink-0 items-start justify-between">
          {title ? (
            <h3 id={titleId} className="text-lg font-semibold text-[var(--md-sys-color-on-surface)]">
              {title}
            </h3>
          ) : (
            <span />
          )}
          <button
            type="button"
            aria-label="关闭弹窗"
            onClick={onClose}
            className="rounded-[var(--md-sys-shape-corner)] p-1 text-[var(--md-sys-color-on-surface-variant)] transition-all hover:bg-[var(--md-sys-color-surface-container)] hover:text-[var(--md-sys-color-on-surface)] hover:scale-110 active:scale-95"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {/* 内容超出可用高度（小屏）时出滚动条，而不是被裁掉 */}
        <div className="mt-4 flex min-h-0 flex-1 flex-col overflow-y-auto text-sm text-[var(--md-sys-color-on-surface-variant)]">
          {children}
        </div>
        {footer && (
          <div className="mt-6 flex shrink-0 items-center justify-end gap-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

export interface ConfirmModalProps extends Omit<ModalProps, 'footer'> {
  okText?: string
  cancelText?: string
  onOk?: () => void
  onCancel?: () => void
  confirmLoading?: boolean
}

export function ConfirmModal({
  okText = '确认',
  cancelText = '取消',
  onOk,
  onCancel,
  confirmLoading,
  ...modalProps
}: ConfirmModalProps) {
  return (
    <Modal
      {...modalProps}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={onCancel ?? modalProps.onClose}
            disabled={confirmLoading}
          >
            {cancelText}
          </Button>
          <Button
            variant="primary"
            onClick={onOk}
            loading={confirmLoading}
            disabled={confirmLoading}
          >
            {okText}
          </Button>
        </>
      }
    />
  )
}
