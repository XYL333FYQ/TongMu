import { t, useTranslation } from '@/i18n'
import { Text, Paragraph } from '@/components/ui/Typography'
import { Tag } from '@/components/ui/Tag'
import { IconButton } from '@/components/VideoControls'
import { cn } from '@/lib/utils'
import {
  Maximize,
  Minimize,
  Pause,
  Play,
  Pencil,
  PictureInPicture,
  PictureInPicture2,
  Volume2,
  VolumeX,
  X,
  RefreshCw,
} from 'lucide-react'

interface WatchControlsBarProps {
  /** 是否Mute */
  isMuted: boolean
  /** 是否正在Play */
  isPlaying: boolean
  /** 是否有远端音频 */
  hasRemoteAudio: boolean
  /** 是否有远端视频流 */
  hasRemoteStream: boolean
  /** 是否处于画中画 */
  isPictureInPicture: boolean
  /** Browse器是否支持画中画 */
  isPiPSupported: boolean
  /** 是否显示Annotation tools栏 */
  showAnnotationToolbar: boolean
  /** socket 是否Connected */
  connected: boolean
  /** WebRTC connections状态 */
  connectionState:
    'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed'
  /** 视频Resolution（Optional） */
  videoResolution: { width: number; height: number } | null
  /** 切换Mute */
  onToggleMute: () => void
  /** Play / Pause */
  onTogglePlayPause: () => void
  /** Fullscreen */
  onFullscreen: () => void
  /** 切换画中画 */
  onTogglePiP: () => void
  /** 切换Annotation tools栏 */
  onToggleAnnotation: () => void
  /** Refresh connection */
  onRefresh: () => void
  /** 控制栏是否可见（自动隐藏），Default true */
  controlBarVisible?: boolean
  /** 是否处于Cinema mode */
  isWebFullscreen?: boolean
  /** 切换Cinema mode */
  onToggleWebFullscreen?: () => void
}

function getConnectionStateText(
  state: WatchControlsBarProps['connectionState']
): string {
  switch (state) {
    case 'connecting':
      return t('Connecting')
    case 'connected':
      return t('Connected')
    case 'disconnected':
      return t('Disconnected')
    case 'failed':
      return t('Connection failed')
    case 'closed':
      return t('Connection closed')
    default:
      return t('Waiting')
  }
}

function getConnectionStateColor(
  state: WatchControlsBarProps['connectionState']
): 'default' | 'primary' | 'success' | 'danger' {
  switch (state) {
    case 'connected':
      return 'success'
    case 'connecting':
      return 'primary'
    case 'disconnected':
    case 'failed':
    case 'closed':
      return 'danger'
    default:
      return 'default'
  }
}

export function WatchControlsBar({
  isMuted,
  isPlaying,
  hasRemoteAudio,
  hasRemoteStream,
  isPictureInPicture,
  isPiPSupported,
  showAnnotationToolbar,
  connected,
  connectionState,
  videoResolution,
  onToggleMute,
  onTogglePlayPause,
  onFullscreen,
  onTogglePiP,
  onToggleAnnotation,
  onRefresh,
  controlBarVisible = true,
  isWebFullscreen = false,
  onToggleWebFullscreen,
}: WatchControlsBarProps): JSX.Element {
  useTranslation()

  return (
    <div
      className={cn(
        'vc-container absolute bottom-0 left-0 right-0 z-20 p-2',
        !controlBarVisible && 'pointer-events-none'
      )}
    >
      <div
        className={cn(
          'glass-strong rounded-xl px-2.5 py-2 shadow-lg',
          controlBarVisible ? 'zart-controlbar-enter' : 'zart-controlbar-exit'
        )}
      >
        <div className="flex flex-wrap items-center vc-gap">
          {/* Play / Pause */}
          <IconButton
            icon={isPlaying ? <Pause /> : <Play />}
            label={isPlaying ? t('Pause') : t('Play')}
            onClick={onTogglePlayPause}
          />
          {hasRemoteAudio && (
            <IconButton
              icon={isMuted ? <VolumeX /> : <Volume2 />}
              label={isMuted ? t('Unmute') : t('Mute')}
              onClick={onToggleMute}
            />
          )}
          <IconButton
            icon={isWebFullscreen ? <Minimize /> : <Maximize />}
            label={isWebFullscreen ? t('Exit cinema mode') : t('Cinema mode')}
            onClick={onToggleWebFullscreen}
          />
          <IconButton
            icon={<Maximize />}
            label={t('Fullscreen')}
            onClick={onFullscreen}
          />
          {isPiPSupported && (
            <IconButton
              icon={
                isPictureInPicture ? (
                  <PictureInPicture2 />
                ) : (
                  <PictureInPicture />
                )
              }
              label={
                isPictureInPicture
                  ? t('Exit picture-in-picture')
                  : t('Picture-in-picture')
              }
              onClick={onTogglePiP}
            />
          )}
          <IconButton
            icon={showAnnotationToolbar ? <X /> : <Pencil />}
            label={
              showAnnotationToolbar ? t('Hide annotations') : t('Annotations')
            }
            active={showAnnotationToolbar}
            onClick={onToggleAnnotation}
          />
          <IconButton
            icon={<RefreshCw />}
            label={t('Refresh connection')}
            onClick={onRefresh}
          />
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Tag color={connected ? 'success' : 'default'}>
            {connected ? t('Connected') : t('Disconnected')}
          </Tag>
          <Tag color="primary">{t('Joined')}</Tag>
          <Tag color={getConnectionStateColor(connectionState)}>
            {getConnectionStateText(connectionState)}
          </Tag>
          {hasRemoteStream && hasRemoteAudio && (
            <Tag color="cyan">{isMuted ? t('Muted') : t('Audio on')}</Tag>
          )}
        </div>
        {videoResolution && (
          <Paragraph className="m-0 mt-2">
            <Text type="secondary">
              {t('Resolution：')}
              {videoResolution.width} x {videoResolution.height}
            </Text>
          </Paragraph>
        )}
      </div>
    </div>
  )
}
