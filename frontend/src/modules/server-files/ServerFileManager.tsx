import { t, useTranslation } from '@/i18n'
/**
 * 服务器文件管理面板（个人中心使用，仅 root 可见）。
 *
 * 功能：
 * - 支持多个根目录：默认 uploads 空间 + root 自定义挂载的服务器真实目录
 * - 浏览目录、上传文件、新建文件夹、重命名、删除
 * - 添加/删除自定义根目录
 *
 * 文件播放通过房间内 MoviePushPanel 的「服务器文件」源类型完成。
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ChevronLeft,
  File,
  Folder,
  FolderPlus,
  Pencil,
  Trash2,
  Upload,
  HardDrive,
  RefreshCw,
  Plus,
  Lock,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useDisclosureMotion } from '@/components/ui/useDisclosureMotion'
import { Input } from '@/components/ui/Input'
import { Modal, ConfirmModal } from '@/components/ui/Modal'
import { Spinner } from '@/components/ui/Spinner'
import { Switch } from '@/components/ui/Switch'
import { Text } from '@/components/ui/Typography'
import { message } from '@/components/ui/message'
import {
  browseServerFiles,
  uploadServerFiles,
  createFolder,
  renameServerFile,
  deleteServerFile,
  listServerRoots,
  addServerRoot,
  deleteServerRoot,
  browseSystemDirs,
  extractRootKey,
} from './serverFilesApi'
import type { ServerFileEntry, ServerFileRoot, SystemDirEntry } from './types'
import { DirPickerSidePanel } from './DirPickerSidePanel'
import { formatFileSize } from '@/lib/utils'

export default function ServerFileManager({
  showHeading = true,
}: { showHeading?: boolean } = {}) {
  useTranslation()
  const addRootDialogId = useId()

  const [entries, setEntries] = useState<ServerFileEntry[]>([])
  const [currentPath, setCurrentPath] = useState<string>('uploads:/')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // 根目录列表
  const [roots, setRoots] = useState<ServerFileRoot[]>([])
  const [rootsLoading, setRootsLoading] = useState(false)
  const {
    open: rootsMenuOpen,
    closing: rootsMenuClosing,
    show: showRootsMenu,
    close: closeRootsMenu,
  } = useDisclosureMotion()
  const {
    open: addRootModalOpen,
    closing: addRootModalClosing,
    show: showAddRootModal,
    close: closeAddRootModal,
  } = useDisclosureMotion()
  const addRootDialogRef = useRef<HTMLDivElement>(null)
  const addRootOpenerRef = useRef<HTMLElement | null>(null)
  const addRootClosingRef = useRef(addRootModalClosing)
  const [newRootName, setNewRootName] = useState('')
  const [newRootPath, setNewRootPath] = useState('')
  const [newRootReadonly, setNewRootReadonly] = useState(false)
  const [addingRoot, setAddingRoot] = useState(false)
  const [deleteRootTarget, setDeleteRootTarget] =
    useState<ServerFileRoot | null>(null)
  const [deletingRoot, setDeletingRoot] = useState(false)

  // 目录选取器（添加根目录时浏览服务器文件系统）
  const [dirPickerOpen, setDirPickerOpen] = useState(false)
  const [dirPickerEntries, setDirPickerEntries] = useState<SystemDirEntry[]>([])
  const [dirPickerPath, setDirPickerPath] = useState('')
  const [dirPickerParent, setDirPickerParent] = useState('')
  const [dirPickerIsRoot, setDirPickerIsRoot] = useState(false)
  const [dirPickerLoading, setDirPickerLoading] = useState(false)
  const [dirPickerError, setDirPickerError] = useState('')

  // 当前根的只读状态（来自 browse 返回）
  const [currentReadonly, setCurrentReadonly] = useState(false)

  // 上传状态
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 新建文件夹
  const [folderModalOpen, setFolderModalOpen] = useState(false)
  const [folderName, setFolderName] = useState('')
  const [folderCreating, setFolderCreating] = useState(false)

  // 重命名
  const [renameTarget, setRenameTarget] = useState<ServerFileEntry | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renaming, setRenaming] = useState(false)

  // 删除
  const [deleteTarget, setDeleteTarget] = useState<ServerFileEntry | null>(null)
  const [deleting, setDeleting] = useState(false)

  const currentRootKey = extractRootKey(currentPath)
  const currentRoot = roots.find((r) => r.key === currentRootKey)

  const loadRoots = useCallback(async () => {
    setRootsLoading(true)
    try {
      const list = await listServerRoots()
      setRoots(list)
    } catch (err) {
      message.error(
        err instanceof Error ? err.message : t('Could not load root folders.')
      )
    } finally {
      setRootsLoading(false)
    }
  }, [])

  const load = useCallback(async (path?: string) => {
    setLoading(true)
    setError('')
    try {
      const data = await browseServerFiles(path)
      setEntries(data.entries)
      setCurrentPath(data.currentPath)
      setCurrentReadonly(!!data.readonly)
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t('Could not load this content.')
      )
    } finally {
      setLoading(false)
    }
  }, [])

  // React Compiler 严格规则误报：组件挂载时一次性加载服务器文件根目录。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    void loadRoots()
  }, [loadRoots])

  // React Compiler 严格规则误报：组件挂载时一次性加载默认 uploads 目录。
  useEffect(() => {
    void load('uploads:/')
  }, [load])
  /* eslint-enable react-hooks/set-state-in-effect */

  // 根目录变化时关闭下拉
  useEffect(() => {
    if (!rootsMenuOpen) return
    const onClick = () => closeRootsMenu()
    window.addEventListener('click', onClick)
    return () => window.removeEventListener('click', onClick)
  }, [rootsMenuOpen, closeRootsMenu])

  useEffect(() => {
    addRootClosingRef.current = addRootModalClosing
  }, [addRootModalClosing])

  useEffect(() => {
    if (!addRootModalOpen) return
    const dialog = addRootDialogRef.current
    if (!dialog) return
    const focusableSelector =
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const ownedMenus = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-tongmu-modal-owner]')
      ).filter((menu) => menu.dataset.tongmuModalOwner === addRootDialogId)
    const containsFocus = () =>
      dialog.contains(document.activeElement) ||
      ownedMenus().some((menu) => menu.contains(document.activeElement))
    const focusables = () =>
      [
        ...Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)),
        ...ownedMenus().flatMap((menu) =>
          Array.from(menu.querySelectorAll<HTMLElement>(focusableSelector))
        ),
      ].filter(
        (element) =>
          element.getClientRects().length > 0 &&
          !element.closest('[inert], [aria-hidden="true"]')
      )
    if (!containsFocus()) (focusables()[0] ?? dialog).focus()
    const onKeyDown = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[data-tongmu-modal]')
      if (dialogs[dialogs.length - 1] !== dialog || event.defaultPrevented)
        return
      if (event.key === 'Escape' && !addRootClosingRef.current) {
        event.preventDefault()
        event.stopPropagation()
        closeAddRootModal()
      }
      if (event.key !== 'Tab') return
      const items = focusables()
      if (!items.length) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      if (
        event.shiftKey &&
        (document.activeElement === first || !containsFocus())
      ) {
        event.preventDefault()
        last.focus()
      } else if (
        !event.shiftKey &&
        (document.activeElement === last || !containsFocus())
      ) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      if (addRootOpenerRef.current?.isConnected)
        addRootOpenerRef.current.focus()
      addRootOpenerRef.current = null
    }
  }, [addRootModalOpen, addRootDialogId, closeAddRootModal])

  const handleEntryClick = (entry: ServerFileEntry) => {
    if (entry.type === 'directory') {
      void load(entry.path)
    }
  }

  const handleBack = () => {
    // 在当前根内回退：去掉 'rootKey:/' 后的最后一层
    const match = currentPath.match(/^(uploads|custom:\d+):(.*)$/)
    if (!match) return
    const rootKey = match[1]
    const rel = match[2].replace(/^\/+/, '')
    if (!rel) return
    const parent = rel.split('/').slice(0, -1).join('/')
    void load(`${rootKey}:/${parent}`)
  }

  const handleSwitchRoot = (root: ServerFileRoot) => {
    closeRootsMenu()
    if (root.key === currentRootKey) return
    if (!root.exists) {
      message.warning(t('This folder does not exist on the server.'))
      return
    }
    void load(`${root.key}:/`)
  }

  // ============ 添加根目录 ============
  const openAddRootModal = () => {
    if (!addRootModalOpen) {
      const opener = document.activeElement as HTMLElement | null
      addRootOpenerRef.current =
        opener && typeof opener.focus === 'function' ? opener : null
    }
    setNewRootName('')
    setNewRootPath('')
    setNewRootReadonly(false)
    setDirPickerOpen(false)
    setDirPickerError('')
    showAddRootModal()
  }

  // 目录选取器：加载指定路径下的子目录
  const loadDirPicker = useCallback(async (absPath?: string) => {
    setDirPickerLoading(true)
    setDirPickerError('')
    try {
      const result = await browseSystemDirs(absPath)
      setDirPickerEntries(result.entries)
      setDirPickerPath(result.currentPath)
      setDirPickerParent(result.parentPath)
      setDirPickerIsRoot(result.isRoot)
    } catch (err) {
      setDirPickerError(
        err instanceof Error ? err.message : t('Could not load this content.')
      )
      setDirPickerEntries([])
    } finally {
      setDirPickerLoading(false)
    }
  }, [])

  // 目录选取器：进入子目录
  const handleDirPickerEnter = (entry: SystemDirEntry) => {
    void loadDirPicker(entry.absPath)
  }

  // 目录选取器：返回上一级
  const handleDirPickerBack = () => {
    if (dirPickerParent) {
      void loadDirPicker(dirPickerParent)
    } else if (!dirPickerIsRoot) {
      // 无父目录但不是系统根，回到系统根
      void loadDirPicker(undefined)
    }
  }

  // 目录选取器：选中当前目录作为根目录路径
  const handleDirPickerSelect = () => {
    if (dirPickerPath) {
      setNewRootPath(dirPickerPath)
      setDirPickerOpen(false)
      // 自动填充名称（如果名称为空）
      if (!newRootName.trim()) {
        const parts = dirPickerPath
          .replace(/\\/g, '/')
          .split('/')
          .filter(Boolean)
        const lastPart = parts[parts.length - 1] || dirPickerPath
        setNewRootName(lastPart)
      }
    }
  }

  // 目录选取器：展开/折叠
  const handleDirPickerToggle = () => {
    if (!dirPickerOpen) {
      setDirPickerOpen(true)
      void loadDirPicker(undefined)
    } else {
      setDirPickerOpen(false)
    }
  }

  const handleAddRoot = async () => {
    const name = newRootName.trim()
    const absPath = newRootPath.trim()
    if (!name) {
      message.warning(t('Enter a name.'))
      return
    }
    if (!absPath) {
      message.warning(t('Choose a server folder.'))
      return
    }
    setAddingRoot(true)
    try {
      const added = await addServerRoot(name, absPath, newRootReadonly)
      message.success(
        t('Root folder added: {value1}」', { value1: added.name })
      )
      closeAddRootModal()
      await loadRoots()
      // 自动切换到新添加的根
      void load(`${added.key}:/`)
    } catch (err) {
      message.error(
        err instanceof Error ? err.message : t('Could not add this item.')
      )
    } finally {
      setAddingRoot(false)
    }
  }

  // ============ 删除根目录 ============
  const handleDeleteRoot = async () => {
    if (!deleteRootTarget) return
    setDeletingRoot(true)
    try {
      await deleteServerRoot(deleteRootTarget.key)
      message.success(t('Root folder disconnected.'))
      setDeleteRootTarget(null)
      await loadRoots()
      // 若删除的是当前根，回到 uploads
      if (deleteRootTarget.key === currentRootKey) {
        void load('uploads:/')
      }
    } catch (err) {
      message.error(
        err instanceof Error ? err.message : t('Could not remove this item.')
      )
    } finally {
      setDeletingRoot(false)
    }
  }

  // ============ 上传 ============
  const handleUploadClick = () => {
    fileInputRef.current?.click()
  }

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    setUploading(true)
    setUploadProgress(0)
    try {
      await uploadServerFiles(files, currentPath, (loaded, total) => {
        setUploadProgress(total > 0 ? Math.round((loaded / total) * 100) : 0)
      })
      message.success(t('Uploaded  {value1}  files', { value1: files.length }))
      void load(currentPath)
    } catch (err) {
      message.error(err instanceof Error ? err.message : t('Upload failed.'))
    } finally {
      setUploading(false)
      setUploadProgress(0)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // ============ 新建文件夹 ============
  const openFolderModal = () => {
    setFolderName('')
    setFolderModalOpen(true)
  }

  const handleCreateFolder = async () => {
    const name = folderName.trim()
    if (!name) {
      message.warning(t('Enter a folder name.'))
      return
    }
    setFolderCreating(true)
    try {
      await createFolder(currentPath, name)
      message.success(t('Folder created.'))
      setFolderModalOpen(false)
      void load(currentPath)
    } catch (err) {
      message.error(
        err instanceof Error ? err.message : t('Could not create the folder.')
      )
    } finally {
      setFolderCreating(false)
    }
  }

  // ============ 重命名 ============
  const openRenameModal = (entry: ServerFileEntry) => {
    setRenameTarget(entry)
    setRenameValue(entry.name)
  }

  const handleRename = async () => {
    if (!renameTarget) return
    const newName = renameValue.trim()
    if (!newName || newName === renameTarget.name) {
      setRenameTarget(null)
      return
    }
    setRenaming(true)
    try {
      await renameServerFile(renameTarget.path, newName)
      message.success(t('Renamed.'))
      setRenameTarget(null)
      void load(currentPath)
    } catch (err) {
      message.error(
        err instanceof Error ? err.message : t('Could not rename this item.')
      )
    } finally {
      setRenaming(false)
    }
  }

  // ============ 删除 ============
  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await deleteServerFile(deleteTarget.path)
      message.success(t('Removed '))
      setDeleteTarget(null)
      void load(currentPath)
    } catch (err) {
      message.error(
        err instanceof Error ? err.message : t('Could not remove this item.')
      )
    } finally {
      setDeleting(false)
    }
  }

  const readonly = currentReadonly || !!currentRoot?.readonly

  return (
    <div className="glass-card p-4">
      {/* 头部 */}
      <div className="mb-4 flex flex-col gap-3">
        {showHeading && (
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
            <div className="flex flex-col">
              <Text className="text-sm font-medium">{t('Server files')}</Text>
              <Text className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                {t('SERVER FILES')}
              </Text>
            </div>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw className="h-4 w-4" />}
            onClick={() => {
              void loadRoots()
              void load(currentPath)
            }}
            disabled={loading || rootsLoading}
          >
            {t('Refresh')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<Plus className="h-4 w-4" />}
            onClick={openAddRootModal}
          >
            {t('Add folder')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            icon={<FolderPlus className="h-4 w-4" />}
            onClick={openFolderModal}
            disabled={readonly}
          >
            {t('New folder')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            icon={<Upload className="h-4 w-4" />}
            onClick={handleUploadClick}
            disabled={uploading || readonly}
          >
            {uploading
              ? t('Uploading… {value1}%', { value1: uploadProgress })
              : t('Upload files')}
          </Button>
        </div>
      </div>

      {/* Upload进度 comments */}
      {uploading && (
        <div className="mb-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--md-sys-color-surface-container)]">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${uploadProgress}%`,
                backgroundColor: 'var(--md-sys-color-primary)',
              }}
            />
          </div>
        </div>
      )}

      {/* 隐藏的文件输入 */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => void handleFileChange(e)}
      />

      {/* Root folder切换器 + Path栏 */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <div className="relative shrink-0">
          <Button
            variant="secondary"
            size="sm"
            icon={<HardDrive className="h-4 w-4" />}
            onClick={(e) => {
              e.stopPropagation()
              if (rootsMenuOpen && !rootsMenuClosing) closeRootsMenu()
              else showRootsMenu()
            }}
            disabled={rootsLoading}
          >
            {currentRoot?.name ?? t('Choose root folder')}
          </Button>
          {rootsMenuOpen && (
            <div
              className={
                'glass absolute left-0 top-full z-30 mt-1 min-w-[260px] max-w-[calc(100vw-2rem)] rounded-[var(--md-sys-shape-corner)] p-1 shadow-lg ' +
                (rootsMenuClosing ? 'zen-dropdown-exit' : 'zen-dropdown-enter')
              }
              style={{
                transformOrigin: 'top left',
                pointerEvents: rootsMenuClosing ? 'none' : undefined,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-2 py-1.5">
                <Text className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                  {t('Root folder')}
                </Text>
              </div>
              {roots.map((r, index) => (
                <div
                  key={r.key}
                  className="zen-dropdown-item group flex items-center gap-2 rounded-[var(--md-sys-shape-corner)] px-2 py-1.5 transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
                  style={{ '--item-index': index } as React.CSSProperties}
                >
                  <button
                    type="button"
                    onClick={() => handleSwitchRoot(r)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    disabled={!r.exists}
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
                    <div className="flex min-w-0 flex-1 flex-col">
                      <Text
                        className={
                          'truncate text-xs font-medium ' +
                          (r.key === currentRootKey
                            ? 'text-[var(--md-sys-color-primary)]'
                            : '')
                        }
                      >
                        {r.name}
                        {r.readonly && (
                          <Lock className="ml-1 inline-block h-3 w-3 align-text-bottom" />
                        )}
                      </Text>
                      <Text
                        type="secondary"
                        className="truncate text-[10px]"
                        title={r.absPath}
                      >
                        {r.absPath}
                      </Text>
                    </div>
                    {!r.exists && (
                      <span className="shrink-0 text-[10px] text-[var(--md-sys-color-error)]">
                        {t('Unavailable')}
                      </span>
                    )}
                  </button>
                  {r.key !== 'uploads' && (
                    <button
                      type="button"
                      onClick={() => setDeleteRootTarget(r)}
                      className="shrink-0 rounded p-1 text-[var(--md-sys-color-on-surface-variant)] opacity-0 transition-opacity hover:text-[var(--md-sys-color-error)] group-hover:opacity-100"
                      title={t('Disconnect source')}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
              <div
                className="zen-dropdown-item mt-1 border-t border-[var(--glass-border)] pt-1"
                style={{ '--item-index': roots.length } as React.CSSProperties}
              >
                <button
                  type="button"
                  onClick={() => {
                    closeRootsMenu()
                    openAddRootModal()
                  }}
                  className="flex w-full items-center gap-2 rounded-[var(--md-sys-shape-corner)] px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
                  style={{ color: 'var(--md-sys-color-primary)' }}
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t('Add server folder')}
                </button>
              </div>
            </div>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="shrink-0"
          icon={<ChevronLeft className="h-4 w-4" />}
          onClick={handleBack}
          disabled={
            currentPath === 'uploads:/' ||
            currentPath === 'custom:/' ||
            !currentPath
          }
        >
          {t('Back')}
        </Button>
        <Text
          className="min-w-0 flex-1 truncate text-xs text-[var(--md-sys-color-on-surface-variant)]"
          title={currentPath}
        >
          {currentPath}
        </Text>
        {readonly && (
          <span
            className="inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium"
            style={{
              backgroundColor:
                'color-mix(in srgb, var(--md-sys-color-outline) 15%, transparent)',
              color: 'var(--md-sys-color-on-surface-variant)',
            }}
          >
            <Lock className="h-3 w-3" />
            {t('Read-only')}
          </span>
        )}
      </div>

      {/* 文件List */}
      {error ? (
        <div className="flex flex-col items-center gap-3 py-6">
          <Text className="text-sm text-[var(--md-sys-color-error)]">
            {t(error)}
          </Text>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void load(currentPath)}
          >
            {t('Try again')}
          </Button>
        </div>
      ) : loading && entries.length === 0 ? (
        <div className="py-6">
          <Spinner tip={t('Loading…')} size={28} />
        </div>
      ) : entries.length === 0 ? (
        <div className="py-6 text-center">
          <Text type="secondary" className="text-sm">
            {readonly
              ? t('This folder is empty.')
              : t('This folder is empty. Upload files to get started.')}
          </Text>
        </div>
      ) : (
        <div className="space-y-1.5">
          {entries.map((entry) => (
            <div
              key={entry.path}
              className="glass group flex items-center gap-3 rounded-[var(--md-sys-shape-corner)] p-2.5 transition-all hover:-translate-y-0.5 hover:shadow-sm"
            >
              <div
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                onClick={() => handleEntryClick(entry)}
                style={{
                  backgroundColor:
                    entry.type === 'directory'
                      ? 'var(--md-sys-color-primary-container)'
                      : 'var(--md-sys-color-surface-container-high)',
                  color:
                    entry.type === 'directory'
                      ? 'var(--md-sys-color-on-primary-container)'
                      : 'var(--md-sys-color-on-surface-variant)',
                  cursor: entry.type === 'directory' ? 'pointer' : 'default',
                }}
              >
                {entry.type === 'directory' ? (
                  <Folder className="h-4 w-4" />
                ) : (
                  <File className="h-4 w-4" />
                )}
              </div>
              <div
                className="min-w-0 flex-1"
                onClick={() => handleEntryClick(entry)}
                style={{
                  cursor: entry.type === 'directory' ? 'pointer' : 'default',
                }}
              >
                <Text className="block truncate text-sm font-medium">
                  {entry.name}
                </Text>
                {entry.type === 'file' && entry.size !== undefined && (
                  <Text className="text-[10px] uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
                    {formatFileSize(entry.size)}
                  </Text>
                )}
              </div>
              {!readonly && (
                <div className="flex shrink-0 gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <Button
                    aria-label={t('Rename')}
                    variant="ghost"
                    size="sm"
                    icon={<Pencil className="h-3.5 w-3.5" />}
                    onClick={() => openRenameModal(entry)}
                  />
                  <Button
                    aria-label={t('Delete')}
                    variant="danger"
                    size="sm"
                    icon={<Trash2 className="h-3.5 w-3.5" />}
                    onClick={() => setDeleteTarget(entry)}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* AddRoot folder Popup（主面板 + 副面板 flex 布局，向右延伸） */}
      {addRootModalOpen &&
        createPortal(
          <div
            className="fixed inset-0 flex items-start justify-center px-4"
            style={{
              zIndex: 999,
              paddingTop: '80px',
            }}
          >
            {/* 轻量遮罩（点击Close） */}
            <div
              className={
                'absolute inset-0 bg-black/20 ' +
                (addRootModalClosing
                  ? 'zen-modal-backdrop-exit'
                  : 'zen-modal-backdrop-enter')
              }
              style={{
                backdropFilter: 'blur(var(--glass-blur-mask))',
                WebkitBackdropFilter: 'blur(var(--glass-blur-mask))',
              }}
              onClick={closeAddRootModal}
            />
            {/* 主面板 + 副面板 flex 容器 */}
            <div
              ref={addRootDialogRef}
              data-tongmu-modal={addRootDialogId}
              role="dialog"
              aria-modal="true"
              aria-labelledby={`${addRootDialogId}-title`}
              tabIndex={-1}
              className={
                'glass-strong relative z-10 flex max-h-[calc(100vh-160px)] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-[var(--md-sys-shape-corner)] shadow-lg md:flex-row ' +
                (addRootModalClosing
                  ? 'zen-modal-content-exit'
                  : 'zen-modal-content-enter')
              }
              style={{
                boxShadow:
                  '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-primary) 25%, transparent)',
              }}
            >
              {/* 主面板 */}
              <div className="glass w-full flex-shrink-0 flex-col p-5 md:w-[360px] md:flex">
                {/* 标题栏 */}
                <div className="mb-4 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div
                      className="flex h-8 w-8 items-center justify-center rounded-[var(--md-sys-shape-corner)]"
                      style={{
                        backgroundColor:
                          'var(--md-sys-color-primary-container)',
                        color: 'var(--md-sys-color-on-primary-container)',
                      }}
                    >
                      <HardDrive className="h-4 w-4" />
                    </div>
                    <h3
                      id={`${addRootDialogId}-title`}
                      className="text-base font-semibold text-[var(--md-sys-color-on-surface)]"
                    >
                      {t('Add server folder')}
                    </h3>
                  </div>
                  <button
                    type="button"
                    aria-label={t('Close')}
                    onClick={closeAddRootModal}
                    className="rounded-[var(--md-sys-shape-corner)] p-1 text-[var(--md-sys-color-on-surface-variant)] transition-all hover:bg-[var(--md-sys-color-surface-container)] hover:text-[var(--md-sys-color-on-surface)]"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                {/* 表单内容 */}
                <div className="flex flex-col gap-3">
                  <Input
                    id={`${addRootDialogId}-name`}
                    label={t('Name')}
                    value={newRootName}
                    onChange={(e) => setNewRootName(e.target.value)}
                    placeholder={t('Media library, Downloads…')}
                    autoFocus
                  />
                  {/* Server folder选取 */}
                  <div className="flex flex-col gap-1.5">
                    <label
                      htmlFor={`${addRootDialogId}-path`}
                      className="text-sm font-medium"
                    >
                      {t('Server folder')}
                    </label>
                    <div className="flex gap-2">
                      <Input
                        id={`${addRootDialogId}-path`}
                        value={newRootPath}
                        onChange={(e) => setNewRootPath(e.target.value)}
                        placeholder={t('Choose a folder using Browse')}
                        className="flex-1"
                      />
                      <Button
                        variant="secondary"
                        size="sm"
                        icon={<HardDrive className="h-3.5 w-3.5" />}
                        onClick={handleDirPickerToggle}
                      >
                        {dirPickerOpen ? t('Collapse') : t('Browse')}
                      </Button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex flex-col">
                      <Text className="text-sm font-medium">
                        {t('Read-only mode')}
                      </Text>
                      <Text
                        type="secondary"
                        className="text-[10px] uppercase tracking-wide"
                      >
                        {t(
                          'Prevents uploads, creation, renaming and deletion.'
                        )}
                      </Text>
                    </div>
                    <Switch
                      checked={newRootReadonly}
                      onChange={(e) => setNewRootReadonly(e.target.checked)}
                    />
                  </div>
                  <Text
                    type="secondary"
                    className="text-[10px] leading-relaxed"
                  >
                    {t(
                      'Browse the server folders or enter a path. The folder must exist and be accessible to the server.'
                    )}
                  </Text>
                </div>

                {/* Bottom按钮 */}
                <div className="mt-5 flex items-center justify-end gap-3">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={closeAddRootModal}
                  >
                    {t('Cancel')}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void handleAddRoot()}
                    disabled={addingRoot}
                  >
                    {addingRoot ? t('Adding…') : t('Add')}
                  </Button>
                </div>
              </div>

              {/* 副面板：目录Browse（向右延伸，width 动画） */}
              <DirPickerSidePanel
                open={dirPickerOpen}
                loading={dirPickerLoading}
                error={dirPickerError}
                entries={dirPickerEntries}
                currentPath={dirPickerPath}
                isRoot={dirPickerIsRoot}
                onEnter={handleDirPickerEnter}
                onBack={handleDirPickerBack}
                onSelect={handleDirPickerSelect}
                onClose={() => setDirPickerOpen(false)}
              />
            </div>
          </div>,
          document.body
        )}

      {/* New folder Modal */}
      <Modal
        open={folderModalOpen}
        onClose={() => setFolderModalOpen(false)}
        title={t('New folder')}
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setFolderModalOpen(false)}
            >
              {t('Cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleCreateFolder()}
              disabled={folderCreating}
            >
              {folderCreating ? t('Creating…') : t('Create')}
            </Button>
          </>
        }
      >
        <Input
          value={folderName}
          onChange={(e) => setFolderName(e.target.value)}
          placeholder={t('Folder name')}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleCreateFolder()
          }}
        />
      </Modal>

      {/* Rename Modal */}
      <Modal
        open={!!renameTarget}
        onClose={() => setRenameTarget(null)}
        title={t('Rename')}
        footer={
          <>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setRenameTarget(null)}
            >
              {t('Cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleRename()}
              disabled={renaming}
            >
              {renaming ? t('Renaming…') : t('Confirm')}
            </Button>
          </>
        }
      >
        <Input
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          placeholder={t('New name')}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleRename()
          }}
        />
      </Modal>

      {/* Remove文件Confirm */}
      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title={t('Remove')}
        onOk={() => void handleDelete()}
        okText={deleting ? t('Removing…') : t('Remove')}
        cancelText={t('Cancel')}
      >
        {t('Remove 「')}
        {deleteTarget?.name}?
        {deleteTarget?.type === 'directory' &&
          t(
            ' All contents of this folder will also be removed. This cannot be undone.'
          )}
      </ConfirmModal>

      {/* RemoveRoot folderConfirm */}
      <ConfirmModal
        open={!!deleteRootTarget}
        onClose={() => setDeleteRootTarget(null)}
        title={t('Disconnect root folder')}
        onOk={() => void handleDeleteRoot()}
        okText={deletingRoot ? t('Removing…') : t('Remove')}
        cancelText={t('Cancel')}
      >
        {t('Remove 「')}
        {deleteRootTarget?.name}
        {t('? Files on the server are kept. Only this shortcut is removed.')}
      </ConfirmModal>
    </div>
  )
}
