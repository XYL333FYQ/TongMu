import { t, useTranslation } from '@/i18n'
import MountBrowserBase from '@/modules/mounts/MountBrowserBase'
import { browseWebDAVMount } from './webdavApi'
import type { WebDAVDirectoryEntry } from './types'

interface WebDAVBrowserProps {
  mountId: number | null
  open: boolean
  onClose: () => void
  onSelectFiles?: (paths: string[]) => void
  selectable?: boolean
}

export default function WebDAVBrowser({
  mountId,
  open,
  onClose,
  onSelectFiles,
}: WebDAVBrowserProps) {
  useTranslation()

  return (
    <MountBrowserBase<WebDAVDirectoryEntry>
      title={t('Browse WebDAV folders')}
      mountId={mountId}
      open={open}
      onClose={onClose}
      onConfirm={(paths) => onSelectFiles?.(paths)}
      browse={browseWebDAVMount}
    />
  )
}
