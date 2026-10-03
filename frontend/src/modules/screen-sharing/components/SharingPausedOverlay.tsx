import { t, useTranslation } from '@/i18n'
import { Paragraph } from '@/components/ui/Typography'

interface SharingPausedOverlayProps {
  visible: boolean
}

export function SharingPausedOverlay({
  visible,
}: SharingPausedOverlayProps): JSX.Element | null {
  useTranslation()

  if (!visible) return null

  return (
    <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/60">
      <Paragraph className="m-0 text-white">
        {t('Sharing is paused. Members will see the last frame.')}
      </Paragraph>
    </div>
  )
}
