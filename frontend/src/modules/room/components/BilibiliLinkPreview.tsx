import { Text } from '@/components/ui/Typography'
import type { ResolvedSource } from '@/modules/room/watch-together/resolveSource'

/** Preview facts only; source URLs and credentials never belong in this card. */
export function BilibiliLinkPreview({ movie }: { movie: ResolvedSource }) {
  return (
    <div className="rounded-[var(--md-sys-shape-corner)] bg-[var(--md-sys-color-surface-container-high)] px-3 py-2 text-[11px] leading-relaxed">
      <Text className="block text-xs font-medium">
        {movie.title} · {movie.qualityLabel || '自动画质'}
      </Text>
      <Text type="secondary" className="block">
        哔哩哔哩 · {movie.currentPage ? `第 ${movie.currentPage} 集` : '单集'} ·
        {movie.duration ? ` ${Math.round(movie.duration)} 秒` : ' 时长未知'}
      </Text>
      <details>
        <summary className="cursor-pointer">技术详情</summary>
        <Text type="secondary" className="block">
          Requested: {movie.requestedQn ?? 'auto'} · Actual: {movie.qualityLabel || movie.currentQn || 'unknown'} · Format: {movie.format.toUpperCase()}
        </Text>
        <Text type="secondary" className="block">
          Video: {movie.videoCodec || 'unknown'} · Audio: {movie.audioCodec || 'unknown'} ·
          Bandwidth: {movie.videoBandwidth ? `${Math.round(movie.videoBandwidth / 1000)} kbps` : 'unknown'}
        </Text>
        <Text type="secondary" className="block">
          Resolution: {movie.acceptQuality?.find(quality => quality.id === movie.currentQn)?.resolution || 'unknown'} ·
          Engine: {movie.format === 'dash' ? 'DASH' : 'Direct MP4'}
        </Text>
        {movie.fallbackReason && <Text className="block text-[var(--md-sys-color-error)]">已采用备用播放方案</Text>}
      </details>
    </div>
  )
}
