import { t, useTranslation } from '@/i18n'
import MountBrowserBase from '@/modules/mounts/MountBrowserBase'
import { browseOpenListMount } from './openlistApi'
import type { OpenListDirectoryEntry } from './types'

interface OpenListBrowserProps {
  mountId: number | null
  open: boolean
  onClose: () => void
  onSelectFiles?: (paths: string[]) => void
  selectable?: boolean
}

export default function OpenListBrowser({
  mountId,
  open,
  onClose,
  onSelectFiles,
}: OpenListBrowserProps) {
  useTranslation()

  return (
    <MountBrowserBase<OpenListDirectoryEntry>
      title={t('Browse OpenList folders')}
      mountId={mountId}
      open={open}
      onClose={onClose}
      onConfirm={(paths) => onSelectFiles?.(paths)}
      browse={browseOpenListMount}
    />
  )
}
