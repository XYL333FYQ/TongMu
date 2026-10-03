import { t, useTranslation } from '@/i18n'
import { useState, useEffect, useRef } from 'react'
import { Image, Link2, Upload, Trash2, Check } from 'lucide-react'
import { Slider } from '@/components/ui/Slider'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { useThemeStore } from '@/store/themeStore'
import { message } from '@/components/ui/message'
import { cn } from '@/lib/utils'

interface BackgroundSettingsPanelProps {
  /** 是否展开 */
  open: boolean
  onClose: () => void
}

type TabKey = 'url' | 'upload'

interface BackgroundConfig {
  backgroundImage: string | null
  backgroundBlur: number
  backgroundOpacity: number
  backgroundPositionX: number
  backgroundPositionY: number
  backgroundScale: number
  backgroundRotate: number
}

const DEFAULT_CONFIG: BackgroundConfig = {
  backgroundImage: null,
  backgroundBlur: 0,
  backgroundOpacity: 1,
  backgroundPositionX: 0,
  backgroundPositionY: 0,
  backgroundScale: 1,
  backgroundRotate: 0,
}

/** 左列宽度（px） */
export const COLUMN_WIDTH = 300
export function BackgroundSettingsPanel({
  open,
  onClose,
}: BackgroundSettingsPanelProps) {
  useTranslation()

  const store = useThemeStore()
  const isSavedUpload = store.backgroundImage?.startsWith('data:') ?? false
  const [activeTab, setActiveTab] = useState<TabKey>(
    isSavedUpload ? 'upload' : 'url'
  )
  const [urlInput, setUrlInput] = useState(
    isSavedUpload ? '' : (store.backgroundImage ?? '')
  )
  const [uploadImage, setUploadImage] = useState<string | null>(
    isSavedUpload ? store.backgroundImage : null
  )
  const savedConfigRef = useRef<BackgroundConfig>({
    backgroundImage: store.backgroundImage,
    backgroundBlur: store.backgroundBlur,
    backgroundOpacity: store.backgroundOpacity,
    backgroundPositionX: store.backgroundPositionX,
    backgroundPositionY: store.backgroundPositionY,
    backgroundScale: store.backgroundScale,
    backgroundRotate: store.backgroundRotate,
  })

  const [isDragOver, setIsDragOver] = useState(false)

  // 打开时同步当前背景配置到表单
  useEffect(() => {
    if (!open) return
    savedConfigRef.current = {
      backgroundImage: store.backgroundImage,
      backgroundBlur: store.backgroundBlur,
      backgroundOpacity: store.backgroundOpacity,
      backgroundPositionX: store.backgroundPositionX,
      backgroundPositionY: store.backgroundPositionY,
      backgroundScale: store.backgroundScale,
      backgroundRotate: store.backgroundRotate,
    }
    const nextIsUpload = store.backgroundImage?.startsWith('data:') ?? false
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 打开面板时同步当前背景配置到表单
    setActiveTab(nextIsUpload ? 'upload' : 'url')
    setUrlInput(nextIsUpload ? '' : (store.backgroundImage ?? ''))
    setUploadImage(nextIsUpload ? store.backgroundImage : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const applyToStore = (config: BackgroundConfig) => {
    store.setBackgroundImage(config.backgroundImage)
    store.setBackgroundBlur(config.backgroundBlur)
    store.setBackgroundOpacity(config.backgroundOpacity)
    store.setBackgroundPositionX(config.backgroundPositionX)
    store.setBackgroundPositionY(config.backgroundPositionY)
    store.setBackgroundScale(config.backgroundScale)
    store.setBackgroundRotate(config.backgroundRotate)
  }

  const switchTab = (tab: TabKey) => {
    setActiveTab(tab)
    if (tab === 'url') {
      store.setBackgroundImage(urlInput.trim() || null)
    } else {
      store.setBackgroundImage(uploadImage)
    }
  }

  const handleUrlChange = (value: string) => {
    setUrlInput(value)
    if (value.trim()) {
      store.setBackgroundImage(value.trim())
    } else {
      store.setBackgroundImage(null)
    }
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
    // 清空 input 的 value，允许再次选择同一个文件
    e.target.value = ''
  }

  const handleFile = (file: File) => {
    if (!file.type.startsWith('image/')) {
      message.error(t('Choose an image file.'))
      return
    }
    // 限制图片大小（5MB），避免 base64 数据过大导致内存问题
    if (file.size > 5 * 1024 * 1024) {
      message.error(t('Choose an image smaller than 5 MB.'))
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      if (!result) {
        message.error(t('Could not read the image.'))
        return
      }
      setUploadImage(result)
      try {
        useThemeStore.getState().setBackgroundImage(result)
      } catch (err) {
        console.error(
          '[BackgroundSettingsPanel] setBackgroundImage failed:',
          err
        )
        message.error(
          t(
            'Could not apply the background. Try a smaller image or an image URL.'
          )
        )
      }
    }
    reader.onerror = () => {
      message.error(t('Could not read the image.'))
    }
    reader.readAsDataURL(file)
  }

  const handleDrop = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault()
    setIsDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) handleFile(file)
  }

  const handleClear = () => {
    applyToStore(DEFAULT_CONFIG)
    setActiveTab('url')
    setUrlInput('')
    setUploadImage(null)
    message.success(t('Custom background cleared.'))
    onClose()
  }

  const tabs: { key: TabKey; label: string; icon: React.ReactNode }[] = [
    { key: 'url', label: 'Image URL', icon: <Link2 className="w-3.5 h-3.5" /> },
    {
      key: 'upload',
      label: 'Upload image',
      icon: <Upload className="w-3.5 h-3.5" />,
    },
  ]

  const previewImage = store.backgroundImage

  return (
    <div
      className="h-full flex-shrink-0 overflow-hidden"
      style={{
        width: open ? COLUMN_WIDTH : 0,
        transition: `width 240ms var(--ease-out-expo)`,
        willChange: 'width',
      }}
    >
      <div className="flex h-full flex-col overflow-hidden border-r border-[var(--glass-border)] p-4">
        {/* 标题栏 */}
        <div className="mb-3 flex shrink-0 items-center justify-between">
          <div className="flex items-center gap-2">
            <Image className="h-4 w-4 text-[var(--md-sys-color-primary)]" />
            <span className="text-sm font-medium text-[var(--md-sys-color-on-surface)]">
              {t('Custom background')}
            </span>
          </div>
          <button
            onClick={onClose}
            className="rounded-[var(--md-sys-shape-corner)] p-1 text-[var(--md-sys-color-on-surface-variant)] transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
          >
            <Check className="h-4 w-4" />
          </button>
        </div>

        {/* 可Scrolling内容区 */}
        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pr-1">
          {/* 标签页 */}
          <div className="flex rounded-[var(--md-sys-shape-corner)] bg-[var(--glass-bg)] p-1">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => switchTab(tab.key)}
                className={cn(
                  'flex flex-1 items-center justify-center gap-1 rounded-[var(--md-sys-shape-corner)] py-1.5 text-xs font-medium transition-all',
                  activeTab === tab.key
                    ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                    : 'text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
                )}
              >
                {tab.icon}
                {t(tab.label)}
              </button>
            ))}
          </div>

          {/* 网络图片 */}
          {activeTab === 'url' && (
            <div className="mt-3">
              <Input
                size="sm"
                placeholder="https://example.com/image.jpg"
                value={urlInput}
                onChange={(e) => handleUrlChange(e.target.value)}
              />
            </div>
          )}

          {/* Upload image */}
          {activeTab === 'upload' && (
            <div className="mt-3">
              <label
                onDragOver={(e) => {
                  e.preventDefault()
                  setIsDragOver(true)
                }}
                onDragLeave={(e) => {
                  e.preventDefault()
                  setIsDragOver(false)
                }}
                onDrop={handleDrop}
                className={cn(
                  'flex w-full flex-col items-center justify-center gap-2 rounded-[var(--md-sys-shape-corner)] border border-dashed py-6 transition-all cursor-pointer',
                  isDragOver
                    ? 'scale-[1.02] border-[var(--md-sys-color-primary)] bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                    : 'border-[var(--md-sys-color-outline)] bg-[var(--glass-bg)] text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
                )}
              >
                <Upload
                  className={cn(
                    'h-6 w-6 transition-transform',
                    isDragOver && 'scale-110'
                  )}
                />
                <span className="text-xs font-medium">
                  {isDragOver
                    ? t('Drop to upload')
                    : t('Drag an image here or choose a file')}
                </span>
                <span className="text-[10px] opacity-70">
                  {t('JPG, PNG or WebP · up to 5 MB')}
                </span>
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleFileChange}
                />
              </label>
            </div>
          )}

          {/* 预览 */}
          {previewImage && (
            <div
              className="mt-3 h-24 w-full overflow-hidden rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] bg-cover bg-center bg-[var(--glass-bg)]"
              style={{
                backgroundImage: `url(${previewImage})`,
                filter: `blur(${store.backgroundBlur}px)`,
                opacity: store.backgroundOpacity,
                // 位置由 transform: translate 控制，与 Layout 实际渲染保持一致
                transform: `translate(${store.backgroundPositionX / 2}%, ${store.backgroundPositionY / 2}%) scale(${store.backgroundScale}) rotate(${store.backgroundRotate}deg)`,
              }}
            />
          )}

          {/* 参数滑块 */}
          <div className="mt-3 space-y-2 px-2">
            <Slider
              label={t('Background blur')}
              value={store.backgroundBlur}
              min={0}
              max={20}
              step={1}
              valueFormatter={(v) => `${v}px`}
              onChange={store.setBackgroundBlur}
              disabled={store.reducedMotion}
            />
            {store.reducedMotion && (
              <p className="text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
                {t('Background blur is off while reduced motion is enabled.')}
              </p>
            )}
            <Slider
              label={t('Opacity')}
              value={Math.round(store.backgroundOpacity * 100)}
              min={0}
              max={100}
              step={1}
              valueFormatter={(v) => `${v}%`}
              onChange={(v) => store.setBackgroundOpacity(v / 100)}
            />
            <Slider
              label={t('Horizontal position')}
              value={store.backgroundPositionX}
              min={-100}
              max={100}
              step={1}
              valueFormatter={(v) => `${v}%`}
              onChange={store.setBackgroundPositionX}
            />
            <Slider
              label={t('Vertical position')}
              value={store.backgroundPositionY}
              min={-100}
              max={100}
              step={1}
              valueFormatter={(v) => `${v}%`}
              onChange={store.setBackgroundPositionY}
            />
            <Slider
              label={t('Scale')}
              value={Math.round(store.backgroundScale * 100)}
              min={50}
              max={200}
              step={1}
              valueFormatter={(v) => `${v}%`}
              onChange={(v) => store.setBackgroundScale(v / 100)}
            />
            <Slider
              label={t('Rotation')}
              value={store.backgroundRotate}
              min={0}
              max={360}
              step={1}
              valueFormatter={(v) => `${v}°`}
              onChange={store.setBackgroundRotate}
            />
          </div>
        </div>

        {/* Clear background */}
        <Button
          variant="danger"
          size="sm"
          block
          className="mt-3 shrink-0"
          icon={<Trash2 className="h-3.5 w-3.5" />}
          onClick={handleClear}
        >
          {t('Clear background')}
        </Button>
      </div>
    </div>
  )
}
