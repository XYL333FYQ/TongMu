import { t, useTranslation } from '@/i18n'
import { Text } from '@/components/ui/Typography'
import type { ResolvedSource } from '@/modules/room/watch-together/resolveSource'

/** Preview facts only; source URLs and credentials never belong in this card. */
export function BilibiliLinkPreview({ movie }: { movie: ResolvedSource }) {
  useTranslation()

  return (
    <div className="rounded-[var(--md-sys-shape-corner)] bg-[var(--md-sys-color-surface-container-high)] px-3 py-2 text-[11px] leading-relaxed">
      <Text className="block text-xs font-medium">
        {movie.title} · {movie.qualityLabel || t('Automatic quality')}
      </Text>
      <Text type="secondary" className="block">
        {t('Bilibili ·')}{' '}
        {movie.currentPage ? t('Part {number}', { number: movie.currentPage }) : t('Single video')} ·
        {movie.duration
          ? t(' {value1} seconds', { value1: Math.round(movie.duration) })
          : t(' Duration unknown')}
      </Text>
      <details>
        <summary className="cursor-pointer">{t('Technical details')}</summary>
        <Text type="secondary" className="block">
          {t('Requested:')} {movie.requestedQn ?? 'auto'} {t('· Actual:')}{' '}
          {movie.qualityLabel || movie.currentQn || t('unknown')}{' '}
          {t('· Format:')} {movie.format.toUpperCase()}
        </Text>
        <Text type="secondary" className="block">
          {t('Video:')} {movie.videoCodec || t('unknown')} {t('· Audio:')}{' '}
          {movie.audioCodec || t('unknown')} {t('· Bandwidth:')}{' '}
          {movie.videoBandwidth
            ? `${Math.round(movie.videoBandwidth / 1000)} kbps`
            : t('unknown')}
        </Text>
        <Text type="secondary" className="block">
          {t('Resolution:')}{' '}
          {movie.acceptQuality?.find(
            (quality) => quality.id === movie.currentQn
          )?.resolution || t('unknown')}{' '}
          {t('· Engine:')} {movie.format === 'dash' ? 'DASH' : t('Direct MP4')}
        </Text>
        {movie.fallbackReason && (
          <Text className="block text-[var(--md-sys-color-error)]">
            {t('Using an alternative playback route.')}
          </Text>
        )}
      </details>
    </div>
  )
}
