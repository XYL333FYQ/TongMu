import { t, useTranslation } from '@/i18n'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ChevronRight,
  File,
  Folder,
  HardDrive,
  Lock,
  Plus,
  CheckSquare2,
  Square,
  ListChecks,
} from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { useDisclosureMotion } from '@/components/ui/useDisclosureMotion'
import { Spinner } from '@/components/ui/Spinner'
import { Text } from '@/components/ui/Typography'
import {
  browseServerFiles,
  listServerRoots,
  extractRootKey,
} from './serverFilesApi'
import type { ServerFileEntry, ServerFileRoot } from './types'
import { cn, formatFileSize } from '@/lib/utils'

interface ServerFilesBrowserProps {
  open: boolean
  onClose: () => void
  /** ConfirmAdd所选文件（单选模式为单个Path，Select multiple模式为批量Path） */
  onConfirm: (paths: string[]) => void
}

/** Resolve前缀式Path（uploads:/a/b 或 custom:3:/a/b），非法PathBack null */
function splitPrefixedPath(
  path: string
): { rootKey: string; rel: string } | null {
  const match = path.match(/^(uploads|custom:\d+):(.*)$/)
  if (!match) return null
  return { rootKey: match[1], rel: match[2].replace(/^\/+/, '') }
}

/** Parent folderPath（同根）；已在Root folder时Back null */
function getParentPath(path: string): string | null {
  const parts = splitPrefixedPath(path)
  if (!parts) return null
  const segs = parts.rel.split('/').filter(Boolean)
  if (segs.length === 0) return null
  return `${parts.rootKey}:/${segs.slice(0, -1).join('/')}`
}

/** Path显示名：最后一段（Root folder显示 /） */
function getEntryName(path: string): string {
  const parts = splitPrefixedPath(path)
  if (!parts) return '/'
  const segs = parts.rel.split('/').filter(Boolean)
  return segs.length > 0 ? segs[segs.length - 1] : '/'
}

function EntrySkeleton() {
  useTranslation()

  return (
    <div className="flex animate-pulse items-center gap-3 rounded-lg p-2.5">
      <div className="h-5 w-5 rounded bg-[var(--md-sys-color-surface-container-high)]" />
      <div className="h-4 flex-1 rounded bg-[var(--md-sys-color-surface-container-high)]" />
      <div className="h-3 w-12 rounded bg-[var(--md-sys-color-surface-container-high)]" />
    </div>
  )
}

export default function ServerFilesBrowser({
  open,
  onClose,
  onConfirm,
}: ServerFilesBrowserProps) {
  useTranslation()

  const [currentPath, setCurrentPath] = useState<string>('uploads:/')
  const [entries, setEntries] = useState<ServerFileEntry[]>([])
  const [parentEntries, setParentEntries] = useState<ServerFileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set())
  const [multiSelectMode, setMultiSelectMode] = useState(false)

  // 根目录列表（本地浏览特有：uploads / custom:N）
  const [roots, setRoots] = useState<ServerFileRoot[]>([])
  const {
    open: rootsMenuOpen,
    closing: rootsMenuClosing,
    show: showRootsMenu,
    close: closeRootsMenu,
  } = useDisclosureMotion()

  const currentRootKey = extractRootKey(currentPath)
  const currentRoot = roots.find((r) => r.key === currentRootKey)

  const load = useCallback(async (path: string) => {
    setLoading(true)
    setError('')
    try {
      const data = await browseServerFiles(path)
      setEntries(data.entries)
      setCurrentPath(data.currentPath)

      const parent = getParentPath(data.currentPath)
      if (parent) {
        try {
          const parentData = await browseServerFiles(parent)
          setParentEntries(parentData.entries)
        } catch {
          setParentEntries([])
        }
      } else {
        setParentEntries([])
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t('Could not load this content.')
      )
    } finally {
      setLoading(false)
    }
  }, [])

  const loadRoots = useCallback(async () => {
    try {
      setRoots(await listServerRoots())
    } catch {
      // 静默失败，根目录加载错误不影响浏览
    }
  }, [])

  // React Compiler 严格规则误报：Modal 打开时重置浏览状态并加载根目录。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (open) {
      setCurrentPath('uploads:/')
      setEntries([])
      setParentEntries([])
      setSelectedPaths(new Set())
      setMultiSelectMode(false)
      void loadRoots()
      void load('uploads:/')
    }
  }, [open, load, loadRoots])
  /* eslint-enable react-hooks/set-state-in-effect */

  // 关闭根目录下拉
  useEffect(() => {
    if (!rootsMenuOpen) return
    const onClick = () => closeRootsMenu()
    window.addEventListener('click', onClick)
    return () => window.removeEventListener('click', onClick)
  }, [rootsMenuOpen, closeRootsMenu])

  const handleOpenDirectory = (path: string) => {
    void load(path)
  }

  const handleSwitchRoot = (root: ServerFileRoot) => {
    closeRootsMenu()
    if (root.key === currentRootKey || !root.exists) return
    setSelectedPaths(new Set())
    void load(`${root.key}:/`)
  }

  const toggleSelection = (path: string) => {
    setSelectedPaths((prev) => {
      // 非多选模式：单选行为，点击新文件替换已有选择，再次点击取消
      if (!multiSelectMode) {
        return prev.has(path) ? new Set<string>() : new Set([path])
      }
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }

  const selectedFiles = useMemo(
    () =>
      [...selectedPaths]
        .map(
          (p) =>
            entries.find((e) => e.path === p) ??
            parentEntries.find((e) => e.path === p)
        )
        .filter((e): e is ServerFileEntry => !!e && e.type === 'file'),
    [selectedPaths, entries, parentEntries]
  )

  const renderEntry = (entry: ServerFileEntry, side: 'left' | 'right') => {
    const isSelected = selectedPaths.has(entry.path)
    const isDirectory = entry.type === 'directory'
    const showCheckbox = multiSelectMode && side === 'right' && !isDirectory

    return (
      <div
        key={`${side}-${entry.path}`}
        className={cn(
          'group flex cursor-pointer items-center gap-3 rounded-lg p-2.5 transition-all',
          isSelected
            ? 'bg-[var(--md-sys-color-primary-container)] shadow-sm'
            : 'hover:bg-[var(--md-sys-color-surface-container-high)] hover:translate-x-0.5'
        )}
        onClick={() => {
          if (isDirectory) {
            handleOpenDirectory(entry.path)
          } else if (showCheckbox || side === 'right') {
            toggleSelection(entry.path)
          }
        }}
      >
        {isDirectory ? (
          <Folder className="h-5 w-5 shrink-0 text-[var(--md-sys-color-primary)]" />
        ) : (
          <File className="h-5 w-5 shrink-0 text-[var(--md-sys-color-on-surface-variant)]" />
        )}

        <span
          className="min-w-0 flex-1 truncate text-[15px] font-medium"
          title={entry.name}
        >
          {entry.name}
        </span>

        {!isDirectory && (
          <>
            {entry.size !== undefined && (
              <span className="shrink-0 text-[13px] text-[var(--md-sys-color-on-surface-variant)]">
                {formatFileSize(entry.size)}
              </span>
            )}
            {(showCheckbox || isSelected) && (
              <span
                className={cn(
                  'shrink-0 rounded-md p-1.5 text-[var(--md-sys-color-primary)] transition-all',
                  showCheckbox
                    ? 'opacity-100'
                    : 'opacity-0 group-hover:opacity-100',
                  isSelected && 'bg-[var(--md-sys-color-primary-container)]'
                )}
                onClick={(e) => {
                  e.stopPropagation()
                  toggleSelection(entry.path)
                }}
              >
                {isSelected ? (
                  <CheckSquare2 className="h-5 w-5" />
                ) : (
                  <Square className="h-5 w-5" />
                )}
              </span>
            )}
          </>
        )}
      </div>
    )
  }

  const breadcrumb = useMemo(() => {
    const parts = splitPrefixedPath(currentPath)
    if (!parts) return [{ name: 'Root folder', path: 'uploads:/' }]
    const items = [{ name: 'Root folder', path: `${parts.rootKey}:/` }]
    let acc = ''
    for (const seg of parts.rel.split('/').filter(Boolean)) {
      acc = acc ? `${acc}/${seg}` : seg
      items.push({ name: seg, path: `${parts.rootKey}:/${acc}` })
    }
    return items
  }, [currentPath])

  const loadingSkeletons = (
    <>
      <div className="mb-4 h-5 w-2/3 animate-pulse rounded bg-[var(--md-sys-color-surface-container-high)]" />
      <div className="grid h-[420px] grid-cols-1 gap-4 overflow-hidden rounded-2xl border border-[var(--md-sys-color-outline-variant)] md:grid-cols-2">
        <div className="hidden min-h-0 flex-col border-r border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface-container-low)]/60 p-3 md:flex">
          <div className="mb-3 h-4 w-16 animate-pulse rounded bg-[var(--md-sys-color-surface-container-high)]" />
          <div className="flex-1 space-y-1 overflow-hidden">
            {Array.from({ length: 8 }).map((_, i) => (
              <EntrySkeleton key={`left-${i}`} />
            ))}
          </div>
        </div>
        <div className="flex flex-col bg-[var(--md-sys-color-surface)]/80 p-3">
          <div className="mb-3 h-4 w-16 animate-pulse rounded bg-[var(--md-sys-color-surface-container-high)]" />
          <div className="flex-1 space-y-1 overflow-hidden">
            {Array.from({ length: 8 }).map((_, i) => (
              <EntrySkeleton key={`right-${i}`} />
            ))}
          </div>
        </div>
      </div>
    </>
  )

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('Browse server files')}
      className="max-w-4xl"
      footer={
        <div className="flex w-full items-center justify-between">
          <Text
            className={cn(
              'text-sm transition-colors',
              selectedFiles.length > 0
                ? 'text-[var(--md-sys-color-primary)]'
                : 'text-[var(--md-sys-color-on-surface-variant)]'
            )}
          >
            {multiSelectMode
              ? t('Selected  {value1}  files', { value1: selectedFiles.length })
              : t('Select multiple items to add them together.')}
          </Text>
          <div className="flex items-center gap-3">
            <Button variant="secondary" size="md" onClick={onClose}>
              {t('Cancel')}
            </Button>
            <Button
              variant="primary"
              size="md"
              icon={<Plus className="h-4 w-4" />}
              onClick={() => {
                if (selectedFiles.length === 0) return
                onConfirm(selectedFiles.map((f) => f.path))
                onClose()
              }}
              disabled={selectedFiles.length === 0}
            >
              {multiSelectMode
                ? t('Add ({value1})', { value1: selectedFiles.length })
                : t('Add selected file')}
            </Button>
          </div>
        </div>
      }
    >
      <div className="relative min-h-[320px]">
        {error ? (
          <div className="flex flex-col items-center gap-3 py-8">
            <Text className="text-base text-[var(--md-sys-color-error)]">
              {t(error)}
            </Text>
            <Button
              variant="secondary"
              size="md"
              onClick={() => void load(currentPath)}
            >
              {t('Try again')}
            </Button>
          </div>
        ) : loading && entries.length === 0 ? (
          loadingSkeletons
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-1.5 text-sm text-[var(--md-sys-color-on-surface-variant)]">
                {/* Root folder切换器（本地Browse特有：uploads / custom:N） */}
                <div className="relative">
                  <Button
                    variant="secondary"
                    size="sm"
                    icon={<HardDrive className="h-3.5 w-3.5" />}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (rootsMenuOpen && !rootsMenuClosing) closeRootsMenu()
                      else showRootsMenu()
                    }}
                  >
                    {currentRoot?.name ?? t('Root folder')}
                  </Button>
                  {rootsMenuOpen && (
                    <div
                      className={cn(
                        'glass absolute left-0 top-full z-30 mt-1 min-w-[220px] rounded-[var(--md-sys-shape-corner)] p-1 shadow-lg',
                        rootsMenuClosing
                          ? 'zen-dropdown-exit'
                          : 'zen-dropdown-enter'
                      )}
                      style={{
                        transformOrigin: 'top left',
                        pointerEvents: rootsMenuClosing ? 'none' : undefined,
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {roots.map((r, index) => (
                        <button
                          key={r.key}
                          type="button"
                          onClick={() => handleSwitchRoot(r)}
                          disabled={!r.exists}
                          className="zen-dropdown-item flex w-full items-center gap-2 rounded-[var(--md-sys-shape-corner)] px-2 py-1.5 text-left transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)] disabled:opacity-50"
                          style={
                            { '--item-index': index } as React.CSSProperties
                          }
                        >
                          <HardDrive
                            className="h-3.5 w-3.5 shrink-0"
                            style={{
                              color:
                                r.key === currentRootKey
                                  ? 'var(--md-sys-color-primary)'
                                  : 'var(--md-sys-color-on-surface-variant)',
                            }}
                          />
                          <span
                            className={
                              'truncate text-xs ' +
                              (r.key === currentRootKey
                                ? 'font-medium text-[var(--md-sys-color-primary)]'
                                : '')
                            }
                          >
                            {r.name}
                          </span>
                          {r.readonly && (
                            <Lock className="ml-auto h-3 w-3 shrink-0 text-[var(--md-sys-color-on-surface-variant)]" />
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {breadcrumb.map((item, index) => (
                  <span key={item.path} className="flex items-center">
                    {index > 0 && <ChevronRight className="mx-1 h-4 w-4" />}
                    <button
                      className="rounded-lg px-2 py-1 hover:bg-[var(--md-sys-color-surface-container-high)] hover:text-[var(--md-sys-color-on-surface)]"
                      onClick={() => void load(item.path)}
                    >
                      {index === 0 ? t('Root folder') : item.name}
                    </button>
                  </span>
                ))}
              </div>

              <Button
                variant={multiSelectMode ? 'primary' : 'secondary'}
                size="sm"
                icon={<ListChecks className="h-4 w-4" />}
                onClick={() => {
                  setMultiSelectMode((prev) => {
                    if (prev) {
                      setSelectedPaths(new Set())
                    }
                    return !prev
                  })
                }}
              >
                {multiSelectMode ? t('Stop selection') : t('Select multiple')}
              </Button>
            </div>

            <div className="grid h-[420px] grid-cols-1 gap-4 overflow-hidden rounded-2xl border border-[var(--md-sys-color-outline-variant)] backdrop-blur-sm md:grid-cols-2">
              {/* 左侧：Parent folder（小屏单栏时隐藏，导航由面包屑承担） */}
              <div className="hidden min-h-0 flex-col border-r border-[var(--md-sys-color-outline-variant)] bg-[var(--md-sys-color-surface-container-low)]/60 md:flex">
                <div className="shrink-0 border-b border-[var(--md-sys-color-outline-variant)] px-4 py-3 text-sm font-semibold uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                  {t('Parent folder')}
                </div>
                <div className="zen-scroll min-h-0 flex-1 overflow-y-auto p-3">
                  {getParentPath(currentPath) ? (
                    parentEntries.length > 0 ? (
                      parentEntries.map((entry) =>
                        entry.type === 'directory'
                          ? renderEntry(entry, 'left')
                          : null
                      )
                    ) : (
                      <Text className="py-8 text-center text-sm text-[var(--md-sys-color-on-surface-variant)]">
                        {t('The parent folder is empty.')}
                      </Text>
                    )
                  ) : (
                    <Text className="py-8 text-center text-sm text-[var(--md-sys-color-on-surface-variant)]">
                      {t('You are at the root folder.')}
                    </Text>
                  )}
                </div>
              </div>

              {/* 右侧：Current folder */}
              <div className="flex min-h-0 flex-col bg-[var(--md-sys-color-surface)]/80">
                <div className="shrink-0 border-b border-[var(--md-sys-color-outline-variant)] px-4 py-3 text-sm font-semibold uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                  {getEntryName(currentPath)}
                </div>
                <div className="zen-scroll min-h-0 flex-1 overflow-y-auto p-3">
                  {entries.length > 0 ? (
                    entries.map((entry) => renderEntry(entry, 'right'))
                  ) : (
                    <Text className="py-8 text-center text-sm text-[var(--md-sys-color-on-surface-variant)]">
                      {t('This folder is empty.')}
                    </Text>
                  )}
                </div>
              </div>
            </div>

            {loading && entries.length > 0 && (
              <div className="absolute inset-0 flex items-center justify-center rounded-2xl bg-[var(--md-sys-color-surface)]/40 backdrop-blur-md">
                <Spinner tip={t('Loading…')} size={28} />
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
