import { t, useTranslation } from '@/i18n'
import { ChevronLeft, HardDrive, Folder, Check } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Spinner } from '@/components/ui/Spinner'
import { Text } from '@/components/ui/Typography'
import type { SystemDirEntry } from './types'

/** 副面板宽度（px） */
export const SIDE_PANEL_WIDTH = 300
export interface DirPickerSidePanelProps {
  /** 是否展开 */
  open: boolean
  /** Loading… */
  loading: boolean
  /** 错误信息 */
  error: string
  /** 目录 itemsList */
  entries: SystemDirEntry[]
  /** CurrentPath */
  currentPath: string
  /** 是否为系统根 */
  isRoot: boolean
  /** 进入子目录 */
  onEnter: (entry: SystemDirEntry) => void
  /** Back上一级 */
  onBack: () => void
  /** 选择Current folder */
  onSelect: () => void
  /** Close面板 */
  onClose: () => void
}

/**
 * 目录选取副面板（flex 子元素，通过 width 动画向右展开）。
 * 作为主面板的 flex 兄弟元素，展开时宽度从 0 过渡到 SIDE_PANEL_WIDTH。
 */
export function DirPickerSidePanel({
  open,
  loading,
  error,
  entries,
  currentPath,
  isRoot,
  onEnter,
  onBack,
  onSelect,
  onClose,
}: DirPickerSidePanelProps) {
  useTranslation()

  return (
    <div
      ref={(element) => {
        if (element) element.inert = !open
      }}
      role="region"
      aria-label={t('Choose folder')}
      aria-hidden={!open}
      className="flex-shrink-0 overflow-hidden"
      style={{
        width: open ? SIDE_PANEL_WIDTH : 0,
        maxWidth: open ? 'calc(100vw - 2rem)' : 0,
        transition: `width var(${open ? '--tm-motion-enter' : '--tm-motion-exit'}) var(${open ? '--ease-out-expo' : '--ease-in-expo'}), max-width var(${open ? '--tm-motion-enter' : '--tm-motion-exit'}) var(${open ? '--ease-out-expo' : '--ease-in-expo'})`,
        willChange: 'width',
      }}
    >
      <div
        className="glass flex h-full max-h-[calc(100vh-160px)] flex-col overflow-hidden border-t border-[var(--glass-border)] p-3 md:border-l md:border-t-0"
        style={{ width: SIDE_PANEL_WIDTH, maxWidth: 'calc(100vw - 2rem)' }}
      >
        {/* 标题栏 */}
        <div className="mb-2 flex shrink-0 items-center justify-between">
          <div className="flex items-center gap-2">
            <div
              className="flex h-8 w-8 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
              style={{
                backgroundColor: 'var(--md-sys-color-primary-container)',
                color: 'var(--md-sys-color-on-primary-container)',
              }}
            >
              <HardDrive className="h-4 w-4" />
            </div>
            <span className="text-sm font-medium text-[var(--md-sys-color-on-surface)]">
              {t('Choose folder')}
            </span>
          </div>
          <button
            type="button"
            aria-label={t('Close')}
            onClick={onClose}
            className="rounded-[var(--md-sys-shape-corner)] p-1 text-[var(--md-sys-color-on-surface-variant)] transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
          >
            <Check className="h-4 w-4" />
          </button>
        </div>

        {/* Path栏 + Back */}
        <div className="mb-2 flex shrink-0 items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            icon={<ChevronLeft className="h-3.5 w-3.5" />}
            onClick={onBack}
            disabled={isRoot}
          >
            {t('Back')}
          </Button>
          <Text
            className="min-w-0 flex-1 truncate text-xs text-[var(--md-sys-color-on-surface-variant)]"
            title={currentPath}
          >
            {currentPath || t('Server root folder')}
          </Text>
        </div>

        {/* 目录List */}
        <div className="min-h-0 flex-1 overflow-y-auto rounded-md">
          {loading ? (
            <div className="flex items-center justify-center py-4">
              <Spinner size={20} />
            </div>
          ) : error ? (
            <Text className="py-4 text-center text-xs text-[var(--md-sys-color-error)]">
              {t(error)}
            </Text>
          ) : entries.length === 0 ? (
            <Text className="py-4 text-center text-xs text-[var(--md-sys-color-on-surface-variant)]">
              {t('No subfolders.')}
            </Text>
          ) : (
            entries.map((entry) => (
              <div
                key={entry.absPath}
                onClick={() => onEnter(entry)}
                className="flex cursor-pointer items-center gap-2 rounded p-1.5 transition-colors hover:bg-[var(--md-sys-color-surface-container-high)]"
              >
                <div
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                  style={{
                    backgroundColor: 'var(--md-sys-color-primary-container)',
                    color: 'var(--md-sys-color-on-primary-container)',
                  }}
                >
                  {isRoot ? (
                    <HardDrive className="h-3.5 w-3.5" />
                  ) : (
                    <Folder className="h-3.5 w-3.5" />
                  )}
                </div>
                <span className="truncate text-sm">{entry.name}</span>
              </div>
            ))
          )}
        </div>

        {/* 选择Current folder按钮 */}
        {!isRoot && currentPath && !loading && !error && (
          <Button
            variant="primary"
            size="sm"
            block
            className="mt-2 shrink-0"
            onClick={onSelect}
          >
            {t('Use this folder')}
          </Button>
        )}
      </div>
    </div>
  )
}
