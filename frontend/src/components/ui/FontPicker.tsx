import { t, useTranslation } from '@/i18n'
import { useCallback, useState } from 'react'
import { Check, Loader2, Monitor } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Font选 items：value 为 CSS font-family 值（'' 表示Default） */
interface FontOption {
  label: string
  value: string
}

/** 内置常用Font（跨平台 web-safe + 中文常用） */
const BUILTIN_FONTS: FontOption[] = [
  { label: 'Default', value: '' },
  { label: 'Microsoft YaHei', value: "'Microsoft YaHei', sans-serif" },
  { label: 'SimHei', value: "'SimHei', 'Heiti SC', sans-serif" },
  { label: 'SimSun', value: "'SimSun', 'Songti SC', serif" },
  { label: 'KaiTi', value: "'KaiTi', 'Kaiti SC', serif" },
  { label: 'FangSong', value: "'FangSong', 'Fangsong SC', serif" },
  { label: 'PingFang', value: "'PingFang SC', sans-serif" },
  {
    label: 'Source Han Sans',
    value: "'Source Han Sans SC', 'Noto Sans SC', sans-serif",
  },
  {
    label: 'Source Han Serif',
    value: "'Source Han Serif SC', 'Noto Serif SC', serif",
  },
  { label: 'Segoe UI', value: "'Segoe UI', sans-serif" },
  { label: 'Arial', value: 'Arial, sans-serif' },
  { label: 'Times New Roman', value: "'Times New Roman', serif" },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Consolas', value: 'Consolas, monospace' },
  { label: 'Sans serif', value: 'sans-serif' },
  { label: 'Serif', value: 'serif' },
  { label: 'Monospace', value: 'monospace' },
]

const STORAGE_SYSTEM_KEY = 'zviewer:system-fonts'

/** queryLocalFonts() 类型（Chrome/Edge 103+，需用户授权） */
interface LocalFontData {
  family: string
  fullName: string
  postscriptName: string
  style: string
}
declare global {
  interface Navigator {
    queryLocalFonts?: () => Promise<LocalFontData[]>
  }
}

function loadSystemFontsCache(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_SYSTEM_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as string[]
    return Array.isArray(parsed)
      ? parsed.filter((f) => typeof f === 'string')
      : []
  } catch {
    return []
  }
}

export interface FontPickerPanelProps {
  /** Current CSS font-family 值（'' 表示Default） */
  value: string
  onChange: (value: string) => void
  className?: string
}

/**
 * 字体选择面板内容（供 AnimatedSidePanel 侧滑面板承载）。
 *
 * - 内置常用字体 + 浏览器枚举的系统字体（queryLocalFonts，结果持久化缓存）
 * - 每项用实际字体渲染预览
 */
export function FontPickerPanel({
  value,
  onChange,
  className,
}: FontPickerPanelProps) {
  useTranslation()

  const [systemFonts, setSystemFonts] = useState<string[]>(loadSystemFontsCache)
  const [loadingSystem, setLoadingSystem] = useState(false)

  const canQuerySystemFonts =
    typeof navigator !== 'undefined' && !!navigator.queryLocalFonts

  const loadSystemFonts = useCallback(async () => {
    if (!navigator.queryLocalFonts || loadingSystem) return
    setLoadingSystem(true)
    try {
      const fonts = await navigator.queryLocalFonts()
      const families = [
        ...new Set(fonts.map((f) => f.family).filter((f) => f && f.trim())),
      ].sort((a, b) => a.localeCompare(b))
      setSystemFonts(families)
      try {
        localStorage.setItem(STORAGE_SYSTEM_KEY, JSON.stringify(families))
      } catch {
        /* 缓存失败忽略 */
      }
    } catch (err) {
      // 权限拒绝或 API 异常：静默（按钮仍在，用户可重试）
      console.info('[FontPicker] 枚举System fonts失败：', err)
    } finally {
      setLoadingSystem(false)
    }
  }, [loadingSystem])

  const renderItem = (
    key: string,
    label: string,
    fontFamily: string,
    active: boolean
  ) => (
    <button
      key={key}
      type="button"
      onClick={() => onChange(fontFamily)}
      className={cn(
        'flex w-full items-center justify-between gap-2 rounded-[var(--md-sys-shape-corner)] px-2.5 py-1.5 text-left text-xs transition-all',
        active
          ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
          : 'text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
      )}
    >
      <span
        className="truncate"
        style={{ fontFamily: fontFamily || undefined }}
      >
        {t(label)}
      </span>
      {active && <Check className="h-3.5 w-3.5 shrink-0" />}
    </button>
  )

  return (
    <div className={cn('flex flex-col', className)}>
      {/* System fonts枚举入口 */}
      {canQuerySystemFonts && (
        <button
          type="button"
          title={
            systemFonts.length > 0
              ? t('Reload system fonts')
              : t('List installed fonts (browser permission required)')
          }
          onClick={() => void loadSystemFonts()}
          disabled={loadingSystem}
          className="mb-1 flex items-center justify-center gap-1.5 rounded-[var(--md-sys-shape-corner)] bg-[var(--md-sys-color-secondary-container)] px-2 py-1 text-[11px] text-[var(--md-sys-color-on-secondary-container)] transition-opacity hover:opacity-85 disabled:opacity-40"
        >
          {loadingSystem ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Monitor className="h-3.5 w-3.5" />
          )}
          {systemFonts.length > 0
            ? t('Reload fonts (cached:  {value1} )', {
                value1: String(systemFonts.length),
              })
            : t('Load system fonts')}
        </button>
      )}

      {/* FontList（面板整体Scrolling） */}
      <div>
        {BUILTIN_FONTS.map((f) =>
          renderItem(f.value || 'default', f.label, f.value, f.value === value)
        )}
        {systemFonts.length > 0 && (
          <>
            <div className="px-2.5 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-[var(--md-sys-color-on-surface-variant)]">
              {t('System fonts')}
            </div>
            {systemFonts.map((family) =>
              renderItem(family, family, `"${family}"`, `"${family}"` === value)
            )}
          </>
        )}
      </div>
    </div>
  )
}
