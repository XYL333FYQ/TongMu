import { t, useTranslation } from '@/i18n'
import MountBrowserBase from '@/modules/mounts/MountBrowserBase'
import { browseFTPMount } from './ftpApi'
import type { FTPDirectoryEntry } from './types'

interface FTPBrowserProps {
  mountId: number | null
  open: boolean
  onClose: () => void
  onSelectFiles?: (paths: string[]) => void
  selectable?: boolean
}

export default function FTPBrowser({
  mountId,
  open,
  onClose,
  onSelectFiles,
}: FTPBrowserProps) {
  useTranslation()

  return (
    <MountBrowserBase<FTPDirectoryEntry>
      title={t('Browse FTP folders')}
      mountId={mountId}
      open={open}
      onClose={onClose}
      onConfirm={(paths) => onSelectFiles?.(paths)}
      browse={browseFTPMount}
    />
  )
}
