import { t, useTranslation } from '@/i18n'
import { useCallback, useState } from 'react'
import { Download, Copy, Radio, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Text, Paragraph } from '@/components/ui/Typography'
import { Card } from '@/components/ui/Card'
import { message } from '@/components/ui/message'
import { useRoomStore } from '@/store/roomStore'
import {
  buildFlvUrl,
  downloadObsConfig,
  getRtmpPushUrl,
} from '../streamPushApi'
import { FlvPlayer } from './FlvPlayer'

interface StreamPushPageProps {
  roomId: string
  className?: string
  style?: React.CSSProperties
}

/**
 * 房主端 OBS 推流子模式页面。
 * - 显示推流地址与流密钥
 * - 提供一键下载 OBS 配置文件
 * - 拉流预览（房主自检推流是否成功）
 * - 显示推流状态（从 roomStore 读取，单一数据源）
 */
export function StreamPushPage({
  roomId,
  className,
  style,
}: StreamPushPageProps) {
  useTranslation()

  const streamKey = useRoomStore((state) => state.streamKey)
  const [downloading, setDownloading] = useState(false)
  const [previewMode, setPreviewMode] = useState(false)

  const rtmpUrl = getRtmpPushUrl()
  const effectiveStreamKey = streamKey ?? roomId
  const flvUrl = buildFlvUrl(effectiveStreamKey)

  const handleDownloadConfig = useCallback(async () => {
    setDownloading(true)
    try {
      await downloadObsConfig(roomId)
      message.success(t('OBS configuration downloaded.'))
    } catch (err) {
      console.error(err)
      const msg = err instanceof Error ? err.message : 'Download failed.'
      message.error(msg)
    } finally {
      setDownloading(false)
    }
  }, [roomId])

  const handleCopyRtmp = useCallback(() => {
    const fullText = `${rtmpUrl}/${effectiveStreamKey}`
    navigator.clipboard
      .writeText(fullText)
      .then(() => message.success(t('Stream URL copied.')))
  }, [rtmpUrl, effectiveStreamKey])

  const handleCopyStreamKey = useCallback(() => {
    navigator.clipboard
      .writeText(effectiveStreamKey)
      .then(() => message.success(t('Stream key copied.')))
  }, [effectiveStreamKey])

  return (
    <div
      className={`h-full min-h-0 overflow-y-auto p-6 space-y-4 ${className ?? ''}`}
      style={style}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Radio className="h-5 w-5 text-[var(--md-sys-color-primary)]" />
          <Text className="!text-white text-lg font-semibold">
            {t('OBS streaming')}
          </Text>
        </div>
      </div>

      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-1">
          <Paragraph type="secondary" className="m-0 text-xs">
            {t('RTMP stream URL')}
          </Paragraph>
          <div className="flex items-center gap-2">
            <Text className="flex-1 truncate rounded px-3 py-1.5 font-mono text-sm">
              {rtmpUrl}
            </Text>
            <Button
              size="sm"
              variant="ghost"
              icon={<Copy className="h-4 w-4" />}
              onClick={handleCopyRtmp}
            >
              {t('Copy URL')}
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Paragraph type="secondary" className="m-0 text-xs">
            {t('Stream key')}
          </Paragraph>
          <div className="flex items-center gap-2">
            <Text className="flex-1 truncate rounded px-3 py-1.5 font-mono text-sm">
              {effectiveStreamKey}
            </Text>
            <Button
              size="sm"
              variant="ghost"
              icon={<Copy className="h-4 w-4" />}
              onClick={handleCopyStreamKey}
            >
              {t('Copy key')}
            </Button>
          </div>
          {!streamKey && (
            <Paragraph type="danger" className="m-0 text-xs">
              {t(
                'A dedicated stream key is unavailable. Download the OBS configuration again or refresh this page.'
              )}
            </Paragraph>
          )}
        </div>

        <div className="flex flex-wrap gap-2 pt-2">
          <Button
            variant="primary"
            icon={<Download className="h-4 w-4" />}
            loading={downloading}
            onClick={handleDownloadConfig}
          >
            {t('Download OBS configuration')}
          </Button>
          <Button
            variant="ghost"
            icon={<ExternalLink className="h-4 w-4" />}
            onClick={() => setPreviewMode((prev) => !prev)}
          >
            {previewMode ? t('Hide preview') : t('Show stream preview')}
          </Button>
        </div>
      </Card>

      {previewMode && (
        <Card className="aspect-video w-full min-h-[480px] overflow-hidden p-0">
          <FlvPlayer src={flvUrl} muted autoPlay />
        </Card>
      )}

      <Card className="flex flex-col gap-2 p-4 text-sm">
        <Text className="font-semibold">{t('Start streaming with OBS')}</Text>
        <ol className="flex flex-col gap-1.5 pl-5 text-[var(--md-sys-color-on-surface-variant)]">
          <li>
            {t('Download the OBS configuration.')}{' '}
            <code className="font-mono">tongmu-obs-config.json</code>
          </li>
          <li>
            {t(
              'In OBS, choose Scene Collection → Import and select the downloaded JSON file.'
            )}
          </li>
          <li>
            {t(
              'Select the imported TongMu scene collection and check the stream URL and key.'
            )}
          </li>
          <li>{t('Choose Start Streaming in OBS.')}</li>
          <li>{t('Members can watch the stream in this room.')}</li>
        </ol>
        <Paragraph type="secondary" className="m-0 mt-2 text-xs">
          {t(
            'Choose Stop Streaming in OBS when finished. Stop OBS before switching back to browser sharing.'
          )}
        </Paragraph>
      </Card>
    </div>
  )
}
