import { t, useTranslation } from '@/i18n'
import { RotateCcw, ChevronRight } from 'lucide-react'
import { Switch } from '@/components/ui/Switch'
import { Slider } from '@/components/ui/Slider'
import { cn } from '@/lib/utils'
import type {
  DanmakuStyleState,
  DanmakuTypeFilters,
  DanmakuAdvancedStyle,
} from '@/store/danmakuStore'

const FILTER_BUTTONS: {
  key: keyof DanmakuTypeFilters
  label: string
}[] = [
  { key: 'scroll', label: 'Scrolling' },
  { key: 'fixed', label: 'Fixed comments' },
  { key: 'color', label: 'Colored' },
  { key: 'advanced', label: 'Advanced' },
]

interface DanmakuStylePanelProps {
  style: DanmakuStyleState
  setStyle: (updates: Partial<DanmakuStyleState>) => void
  resetStyle: () => void
  advancedOpen: boolean
  onAdvancedToggle: () => void
}

/**
 * 弹幕样式面板（主内容）：
 * 显示区域 / 不透明度 / 字号 / 随屏幕缩放 + 底部操作按钮。
 * 高级设置内容见 DanmakuAdvancedSettings 组件，由 SettingsPanel 在延伸面板中渲染。
 */
export function DanmakuStylePanel({
  style,
  setStyle,
  resetStyle,
  advancedOpen,
  onAdvancedToggle,
}: DanmakuStylePanelProps) {
  useTranslation()

  return (
    <div className="flex flex-col gap-2">
      {/* 显示Settings */}
      <div className="flex flex-col gap-2">
        <Slider
          label={t('Display area')}
          size="sm"
          value={style.displayArea}
          min={0.25}
          max={1}
          step={0.05}
          valueFormatter={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => setStyle({ displayArea: v })}
        />
        <Slider
          label={t('Opacity')}
          size="sm"
          value={style.opacity}
          min={0.1}
          max={1}
          step={0.05}
          valueFormatter={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => setStyle({ opacity: v })}
        />
      </div>

      {/* Appearance：Font size */}
      <Slider
        label={t('Font size')}
        size="sm"
        value={style.fontSize}
        min={12}
        max={36}
        step={1}
        valueFormatter={(v) => `${v}px`}
        onChange={(v) => setStyle({ fontSize: v })}
      />

      {/* 随屏幕缩放 */}
      <div className="flex items-center justify-between">
        <span
          className="text-xs font-medium"
          style={{ color: 'var(--md-sys-color-on-surface)' }}
        >
          {t('Scale with screen')}
        </span>
        <Switch
          checked={style.scaleWithScreen}
          onChange={(e) => setStyle({ scaleWithScreen: e.target.checked })}
        />
      </div>

      {/* Bottom操作行 */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onAdvancedToggle}
          className={cn(
            'flex flex-1 items-center justify-center gap-1 rounded-md border py-1 text-xs font-medium transition-all active:brightness-95',
            advancedOpen
              ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)] border-transparent'
              : 'text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
          )}
          style={{ borderColor: 'var(--md-sys-color-outline)' }}
        >
          {advancedOpen ? t('Hide advanced settings') : t('Advanced settings')}
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 transition-transform',
              advancedOpen && 'rotate-180'
            )}
          />
        </button>
        <button
          type="button"
          onClick={resetStyle}
          className="flex items-center justify-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-all hover:bg-[var(--md-sys-color-surface-container-highest)] active:brightness-95"
          style={{
            color: 'var(--md-sys-color-on-surface-variant)',
            borderColor: 'var(--md-sys-color-outline)',
          }}
        >
          <RotateCcw className="h-3 w-3" />
          {t('Reset')}
        </button>
      </div>
    </div>
  )
}

interface DanmakuAdvancedSettingsProps {
  style: DanmakuStyleState
  setStyle: (updates: Partial<DanmakuStyleState>) => void
  setFilters: (updates: Partial<DanmakuTypeFilters>) => void
  setAdvancedStyle: (updates: Partial<DanmakuAdvancedStyle>) => void
  /** Open/CloseFont选择延伸面板 */
  onFontPanelToggle?: () => void
}

/**
 * 弹幕高级设置内容（渲染在延伸面板中）：
 * 显示类型 / 速度 / 字体 / 描边 / 阴影 / 密度
 */
export function DanmakuAdvancedSettings({
  style,
  setStyle,
  setFilters,
  setAdvancedStyle,
  onFontPanelToggle,
}: DanmakuAdvancedSettingsProps) {
  useTranslation()

  return (
    <div className="flex flex-col gap-2">
      {/* 标题 */}
      <div
        className="text-xs font-semibold uppercase tracking-wide"
        style={{ color: 'var(--md-sys-color-on-surface)' }}
      >
        {t('Advanced settings')}
      </div>

      {/* 显示类型 */}
      <div>
        <div
          className="mb-1 text-[11px] font-medium uppercase tracking-wide"
          style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
        >
          {t('Comment types')}
        </div>
        <div className="grid grid-cols-4 gap-1">
          {FILTER_BUTTONS.map(({ key, label }) => {
            const active = style.filters[key]
            return (
              <button
                key={key}
                type="button"
                onClick={() => setFilters({ [key]: !active })}
                className={cn(
                  'rounded-md border py-1 text-xs font-medium transition-all',
                  'hover:-translate-y-px hover:shadow-sm active:translate-y-0 active:brightness-95',
                  active
                    ? 'border-transparent bg-[var(--md-sys-color-primary)] text-[var(--md-sys-color-on-primary)] shadow-sm'
                    : 'border-[var(--md-sys-color-outline)] bg-[var(--glass-bg)] text-[var(--md-sys-color-on-surface)]'
                )}
              >
                {t(label)}
              </button>
            )
          })}
        </div>
      </div>

      {/* Speed */}
      <Slider
        label={t('Speed')}
        size="sm"
        value={style.speed}
        min={0.5}
        max={2}
        step={0.1}
        valueFormatter={(v) => `${v}x`}
        onChange={(v) => setStyle({ speed: v })}
      />

      {/* Font（点击OpenFont选择延伸面板） */}
      <div>
        <label
          className="mb-1 block text-[11px] font-medium uppercase tracking-wide"
          style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
        >
          {t('Font')}
        </label>
        <button
          type="button"
          onClick={() => onFontPanelToggle?.()}
          className="zen-input-glow flex w-full items-center justify-between gap-2 rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-high)] px-2 py-1 text-xs text-[var(--md-sys-color-on-surface)] transition-all duration-200 hover:border-[var(--md-sys-color-primary)] hover:shadow-sm focus:border-[var(--md-sys-color-primary)] focus:outline-none"
        >
          <span
            className="truncate"
            style={{ fontFamily: style.advanced.fontFamily || undefined }}
          >
            {style.advanced.fontFamily
              ? style.advanced.fontFamily
                  .replace(/["']/g, '')
                  .split(',')[0]
                  ?.trim() || t('Custom')
              : t('Default')}
          </span>
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--md-sys-color-on-surface-variant)]" />
        </button>
      </div>

      <Slider
        label={t('Outline')}
        size="sm"
        value={style.advanced.strokeWidth}
        min={0}
        max={3}
        step={0.5}
        valueFormatter={(v) => `${v}px`}
        onChange={(v) => setAdvancedStyle({ strokeWidth: v })}
      />
      <Slider
        label={t('Shadow')}
        size="sm"
        value={style.advanced.shadowBlur}
        min={0}
        max={8}
        step={0.5}
        valueFormatter={(v) => `${v}px`}
        onChange={(v) => setAdvancedStyle({ shadowBlur: v })}
      />
      <Slider
        label={t('Display area')}
        size="sm"
        value={style.displayArea}
        min={0.25}
        max={1}
        step={0.05}
        valueFormatter={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => setStyle({ displayArea: v })}
      />
    </div>
  )
}
