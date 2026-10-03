import { t, useTranslation, type TranslationParams } from '@/i18n'
import { useRef, useState } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Check,
  Plus,
  Upload,
  ScanSearch,
  Loader2,
  FolderOpen,
  FileText,
} from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { Switch } from '@/components/ui/Switch'
import { Slider } from '@/components/ui/Slider'
import { Button } from '@/components/ui/Button'
import { FontPickerPanel } from '@/components/ui/FontPicker'
import { cn } from '@/lib/utils'
import type { SubtitleTrack, EmbeddedTrackInfo } from '@/hooks/useSubtitles'
import {
  DanmakuStylePanel,
  DanmakuAdvancedSettings,
} from '@/modules/room/watch-together/DanmakuStylePanel'
import { AnimatedSidePanel } from './AnimatedSidePanel'
import { SubtitleBrowser } from './SubtitleBrowser'
import { DEFAULT_DANMAKU_STYLE } from '@/store/danmakuStore'
import type {
  DanmakuStyleState,
  DanmakuTypeFilters,
  DanmakuAdvancedStyle,
} from '@/store/danmakuStore'

/** On-screen commentsDefaultFont栈（FontPickerPanel 的「Default」 items映射值） */
const DANMAKU_DEFAULT_FONT = DEFAULT_DANMAKU_STYLE.advanced.fontFamily

/** 主面板宽度（固定，副面板据此定位） */
const MAIN_PANEL_WIDTH = 260
/** 副面板宽度 */
const SIDE_PANEL_WIDTH = 200
/** SubtitlesBrowse面板宽度 */
const BROWSER_PANEL_WIDTH = 220
/** Font选择面板宽度 */
const FONT_PANEL_WIDTH = 220
/** 副面板与主面板间距 */
const PANEL_GAP = 8

interface SubtitleNotice {
  key: string
  params?: TranslationParams
}

interface SettingsPanelProps {
  isHost: boolean
  danmakuStyle?: DanmakuStyleState
  subtitleEnabled?: boolean
  subtitleTracks?: SubtitleTrack[]
  activeTrackIndex?: number
  subtitleFontSize?: number
  subtitleOffset?: number
  subtitleShiftX?: number
  subtitleShiftY?: number
  subtitleStrokeWidth?: number
  subtitleShadowBlur?: number
  subtitleFontFamily?: string
  browseMovieId?: number
  onToggleSubtitles?: (enabled: boolean) => void
  onSelectSubtitleTrack?: (index: number) => void
  onAddSubtitleUrl?: (url: string, label?: string) => void
  onAddSubtitleFile?: (file: File) => void
  onAddSubtitleContent?: (
    content: string,
    filename: string,
    format: string
  ) => void
  onChangeSubtitleFontSize?: (size: number) => void
  onChangeSubtitleOffset?: (offset: number) => void
  onChangeSubtitleShiftX?: (shiftX: number) => void
  onChangeSubtitleShiftY?: (shiftY: number) => void
  onChangeSubtitleStrokeWidth?: (strokeWidth: number) => void
  onChangeSubtitleShadowBlur?: (shadowBlur: number) => void
  onChangeSubtitleFontFamily?: (fontFamily: string) => void
  onAutoSearchSubtitles?: () => Promise<number>
  canAutoSearchSubtitles?: boolean
  canLoadEmbeddedSubtitles?: boolean
  /** 列出视频文件的Embedded subtitle tracks（仅探测，不提取）。 */
  onListEmbeddedTracks?: () => Promise<EmbeddedTrackInfo[]>
  /** 提取指定一 commentsEmbedded subtitle tracks并加入Play。 */
  onExtractEmbeddedTrack?: (track: EmbeddedTrackInfo) => Promise<number>
  onDanmakuStyleChange?: (updates: Partial<DanmakuStyleState>) => void
  onDanmakuFilterChange?: (updates: Partial<DanmakuTypeFilters>) => void
  onDanmakuAdvancedChange?: (updates: Partial<DanmakuAdvancedStyle>) => void
  onResetDanmakuStyle?: () => void
}

/**
 * 设置面板（精简版）：字幕（启用 / 轨道 / 加载 URL·文件 / 字号）与弹幕样式两个 Tab。
 * 仅房主可编辑字幕；观众端展示「字幕由房主控制」。
 * 高级设置展开时向左延伸出独立面板，主面板高度保持不变。
 */
export function SettingsPanel(props: SettingsPanelProps) {
  useTranslation()

  const {
    isHost,
    danmakuStyle,
    subtitleEnabled,
    subtitleTracks,
    activeTrackIndex,
    subtitleFontSize,
    subtitleOffset,
    subtitleShiftX,
    subtitleShiftY,
    subtitleStrokeWidth,
    subtitleShadowBlur,
    subtitleFontFamily,
    browseMovieId,
    onToggleSubtitles,
    onSelectSubtitleTrack,
    onAddSubtitleUrl,
    onAddSubtitleFile,
    onAddSubtitleContent,
    onChangeSubtitleFontSize,
    onChangeSubtitleOffset,
    onChangeSubtitleShiftX,
    onChangeSubtitleShiftY,
    onChangeSubtitleStrokeWidth,
    onChangeSubtitleShadowBlur,
    onChangeSubtitleFontFamily,
    onAutoSearchSubtitles,
    canAutoSearchSubtitles,
    canLoadEmbeddedSubtitles,
    onListEmbeddedTracks,
    onExtractEmbeddedTrack,
    onDanmakuStyleChange,
    onDanmakuFilterChange,
    onDanmakuAdvancedChange,
    onResetDanmakuStyle,
  } = props

  const [settingsTab, setSettingsTab] = useState<'subtitle' | 'danmaku'>(
    'danmaku'
  )
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [fontPanelOpen, setFontPanelOpen] = useState(false)
  const [showSubtitleLoader, setShowSubtitleLoader] = useState(false)
  const [subtitleUrlInput, setSubtitleUrlInput] = useState('')
  const [autoSearching, setAutoSearching] = useState(false)
  const [autoSearchMsg, setAutoSearchMsg] = useState<SubtitleNotice | null>(
    null
  )
  const [embeddedLoading, setEmbeddedLoading] = useState(false)
  const [embeddedMsg, setEmbeddedMsg] = useState<SubtitleNotice | null>(null)
  const [embeddedTracks, setEmbeddedTracks] = useState<EmbeddedTrackInfo[]>([])
  const [embeddedListLoading, setEmbeddedListLoading] = useState(false)
  const [extractingIndex, setExtractingIndex] = useState<number | null>(null)
  const [browserOpen, setBrowserOpen] = useState(false)
  const subtitleFileInputRef = useRef<HTMLInputElement>(null)

  // 弹幕/字幕视图由 Tab 决定（观众同样拥有字幕设置 Tab，仅少加载类功能）
  const isDanmakuView = !!danmakuStyle && settingsTab === 'danmaku'
  const isSubtitleView = settingsTab === 'subtitle' || !danmakuStyle
  // 高级设置侧面板：弹幕与字幕各自的内容，复用同一个展开状态
  const showAdvancedPanel = advancedOpen && (isDanmakuView || isSubtitleView)
  // 字体面板与高级设置面板互斥（同为向右侧滑出的延伸面板）；
  // 字幕/弹幕 Tab 各自渲染对应的字体选择内容（Tab 切换时已关闭）
  const showFontPanel = fontPanelOpen
  const showBrowserPanel =
    browserOpen && isSubtitleView && browseMovieId != null

  const handleAddSubtitleUrl = () => {
    const url = subtitleUrlInput.trim()
    if (!url) return
    onAddSubtitleUrl?.(url)
    setSubtitleUrlInput('')
  }

  const handleSubtitleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    onAddSubtitleFile?.(file)
    e.target.value = ''
  }

  const handleAutoSearch = async () => {
    if (autoSearching || !onAutoSearchSubtitles) return
    setAutoSearching(true)
    setAutoSearchMsg(null)
    try {
      const count = await onAutoSearchSubtitles()
      setAutoSearchMsg(
        count > 0
          ? { key: 'Found {count} subtitle tracks', params: { count } }
          : { key: 'No subtitles found.' }
      )
    } catch {
      setAutoSearchMsg({ key: 'Search failed.' })
    } finally {
      setAutoSearching(false)
      setTimeout(() => setAutoSearchMsg(null), 3000)
    }
  }

  const handleListEmbedded = async () => {
    if (embeddedListLoading || !onListEmbeddedTracks) return
    setEmbeddedListLoading(true)
    setEmbeddedMsg(null)
    try {
      const tracks = await onListEmbeddedTracks()
      setEmbeddedTracks(tracks)
      if (tracks.length === 0)
        setEmbeddedMsg({ key: 'No embedded subtitles were found.' })
    } catch {
      setEmbeddedMsg({ key: 'Detection failed.' })
    } finally {
      setEmbeddedListLoading(false)
    }
  }

  const handleExtractEmbedded = async (track: EmbeddedTrackInfo) => {
    if (embeddedLoading || !onExtractEmbeddedTrack) return
    setEmbeddedLoading(true)
    setEmbeddedMsg(null)
    setExtractingIndex(track.index)
    try {
      const count = await onExtractEmbeddedTrack(track)
      setEmbeddedMsg(
        count > 0
          ? {
              key: 'Extracted subtitle track: {label}',
              params: { label: track.label },
            }
          : { key: 'Extraction failed.' }
      )
    } catch {
      setEmbeddedMsg({ key: 'Extraction failed.' })
    } finally {
      setEmbeddedLoading(false)
      setExtractingIndex(null)
      setTimeout(() => setEmbeddedMsg(null), 3000)
    }
  }

  return (
    <div className="absolute bottom-full right-2 z-[200] mb-1">
      {/* 延伸面板：Advanced settings（独立动画组件，absolute 定位不影响主面板）
          On-screen comments与Subtitles各有独立的高级内容，复用同一个展开状态 */}
      <AnimatedSidePanel
        open={showAdvancedPanel}
        width={SIDE_PANEL_WIDTH}
        gap={PANEL_GAP}
        mainPanelWidth={MAIN_PANEL_WIDTH}
        maxHeight={520}
      >
        {isDanmakuView ? (
          <DanmakuAdvancedSettings
            style={danmakuStyle!}
            setStyle={onDanmakuStyleChange ?? (() => {})}
            setFilters={onDanmakuFilterChange ?? (() => {})}
            setAdvancedStyle={onDanmakuAdvancedChange ?? (() => {})}
            onFontPanelToggle={() => {
              setAdvancedOpen(false)
              setFontPanelOpen((v) => !v)
            }}
          />
        ) : (
          <div className="flex flex-col gap-2">
            <div
              className="text-xs font-semibold uppercase tracking-wide"
              style={{ color: 'var(--md-sys-color-on-surface)' }}
            >
              {t('Advanced settings')}
            </div>
            <Slider
              label={t('Font size')}
              size="sm"
              value={subtitleFontSize ?? 20}
              min={12}
              max={50}
              step={1}
              valueFormatter={(v) => `${v}px`}
              onChange={(v) => onChangeSubtitleFontSize?.(v)}
            />
            <Slider
              label={t('Outline')}
              size="sm"
              value={subtitleStrokeWidth ?? 0}
              min={0}
              max={4}
              step={0.5}
              valueFormatter={(v) => (v > 0 ? `${v}px` : t('None'))}
              onChange={(v) => onChangeSubtitleStrokeWidth?.(v)}
            />
            <Slider
              label={t('Shadow')}
              size="sm"
              value={subtitleShadowBlur ?? 4}
              min={0}
              max={12}
              step={1}
              valueFormatter={(v) => (v > 0 ? `${v}px` : t('None'))}
              onChange={(v) => onChangeSubtitleShadowBlur?.(v)}
            />
            <Slider
              label={t('Time offset')}
              size="sm"
              value={subtitleOffset ?? 0}
              min={-5}
              max={5}
              step={0.1}
              valueFormatter={(v) =>
                v > 0 ? `+${v.toFixed(1)}s` : `${v.toFixed(1)}s`
              }
              onChange={(v) => onChangeSubtitleOffset?.(v)}
            />
            <Slider
              label={t('Horizontal offset')}
              size="sm"
              value={subtitleShiftX ?? 0}
              min={-50}
              max={50}
              step={1}
              valueFormatter={(v) =>
                v > 0
                  ? t('Right {amount}%', { amount: v })
                  : v < 0
                    ? t('Left {amount}%', { amount: -v })
                    : t('Centered')
              }
              onChange={(v) => onChangeSubtitleShiftX?.(v)}
            />
            <Slider
              label={t('Vertical offset')}
              size="sm"
              value={subtitleShiftY ?? 0}
              min={-50}
              max={50}
              step={1}
              valueFormatter={(v) =>
                v > 0
                  ? t('Down {amount}%', { amount: v })
                  : v < 0
                    ? t('Up {amount}%', { amount: -v })
                    : t('Original position')
              }
              onChange={(v) => onChangeSubtitleShiftY?.(v)}
            />
            <div>
              <div
                className="mb-1 text-[11px] font-medium uppercase tracking-wide"
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              >
                {t('Font')}
              </div>
              <button
                type="button"
                onClick={() => {
                  setAdvancedOpen(false)
                  setFontPanelOpen((v) => !v)
                }}
                className="zen-input-glow flex w-full items-center justify-between gap-2 rounded-[var(--md-sys-shape-corner)] border border-[var(--md-sys-color-outline)] bg-[var(--md-sys-color-surface-container-high)] px-2 py-1 text-xs text-[var(--md-sys-color-on-surface)] transition-all duration-200 hover:border-[var(--md-sys-color-primary)] hover:shadow-sm focus:border-[var(--md-sys-color-primary)] focus:outline-none"
              >
                <span
                  className="truncate"
                  style={{ fontFamily: subtitleFontFamily || undefined }}
                >
                  {subtitleFontFamily
                    ? subtitleFontFamily
                        .replace(/["']/g, '')
                        .split(',')[0]
                        ?.trim() || t('Custom')
                    : t('Default')}
                </span>
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[var(--md-sys-color-on-surface-variant)]" />
              </button>
            </div>
          </div>
        )}
      </AnimatedSidePanel>

      {/* 延伸面板：Font选择（Subtitles/On-screen comments Tab 各自的内容） */}
      <AnimatedSidePanel
        open={showFontPanel}
        width={FONT_PANEL_WIDTH}
        gap={PANEL_GAP}
        mainPanelWidth={MAIN_PANEL_WIDTH}
        maxHeight={280}
      >
        {isDanmakuView ? (
          <FontPickerPanel
            value={
              danmakuStyle?.advanced.fontFamily === DANMAKU_DEFAULT_FONT
                ? ''
                : (danmakuStyle?.advanced.fontFamily ?? '')
            }
            onChange={(v) =>
              onDanmakuAdvancedChange?.({
                fontFamily: v || DANMAKU_DEFAULT_FONT,
              })
            }
          />
        ) : (
          <FontPickerPanel
            value={subtitleFontFamily ?? ''}
            onChange={(v) => onChangeSubtitleFontFamily?.(v)}
          />
        )}
      </AnimatedSidePanel>

      {/* 延伸面板：Subtitles目录Browse */}
      <AnimatedSidePanel
        open={showBrowserPanel}
        width={BROWSER_PANEL_WIDTH}
        gap={PANEL_GAP}
        mainPanelWidth={MAIN_PANEL_WIDTH}
        maxHeight={300}
      >
        {browseMovieId != null && onAddSubtitleContent && (
          <SubtitleBrowser
            movieId={browseMovieId}
            onSelect={(content, filename, format) => {
              onAddSubtitleContent(content, filename, format)
            }}
          />
        )}
      </AnimatedSidePanel>

      {/* 主面板（位置固定，不受副面板展开/Collapse影响） */}
      <div
        className="glass-strong relative overflow-y-auto rounded-xl border border-[var(--glass-border)] p-2.5 shadow-lg"
        style={{
          width: MAIN_PANEL_WIDTH,
          maxHeight: 420,
          boxShadow:
            '0 8px 24px -8px color-mix(in srgb, var(--md-sys-color-shadow) 40%, transparent)',
        }}
      >
        {/* Tab 切换（房主与Members均显示；Members同样有SubtitlesSettings Tab） */}
        {danmakuStyle ? (
          <div
            className="mb-1.5 grid grid-cols-2 gap-1.5 rounded-lg border p-1"
            style={{
              backgroundColor: 'var(--glass-bg)',
              borderColor: 'var(--md-sys-color-outline)',
            }}
          >
            {(['subtitle', 'danmaku'] as const).map((tab) => {
              const active = settingsTab === tab
              return (
                <button
                  key={tab}
                  type="button"
                  onClick={() => {
                    setSettingsTab(tab)
                    setAdvancedOpen(false)
                    setBrowserOpen(false)
                    setFontPanelOpen(false)
                  }}
                  className={cn(
                    'rounded-md py-1 text-xs font-medium transition-all',
                    active
                      ? 'bg-[var(--md-sys-color-primary)] text-[var(--md-sys-color-on-primary)] shadow-sm'
                      : 'text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-highest)] hover:text-[var(--md-sys-color-on-surface)]'
                  )}
                >
                  {tab === 'subtitle'
                    ? t('Subtitles')
                    : t('On-screen comments')}
                </button>
              )
            })}
          </div>
        ) : (
          <div
            className="mb-1.5 text-xs font-semibold"
            style={{ color: 'var(--md-sys-color-on-surface)' }}
          >
            {t('Subtitles')}
          </div>
        )}

        {/* 内容：房主与Members均显示SubtitlesSettings（Members少加载类功能） */}
        {settingsTab === 'subtitle' || !danmakuStyle ? (
          <>
            <div className="flex items-center justify-between py-0.5">
              <span
                className="text-xs"
                style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
              >
                {t('Enable subtitles')}
              </span>
              <Switch
                checked={!!subtitleEnabled}
                onChange={(e) => onToggleSubtitles?.(e.target.checked)}
              />
            </div>
            {subtitleEnabled && subtitleTracks && subtitleTracks.length > 0 && (
              <div className="mt-1">
                <div
                  className="mb-1 text-[11px] font-medium uppercase tracking-wide"
                  style={{ color: 'var(--md-sys-color-on-surface-variant)' }}
                >
                  {t('Subtitle track')}
                </div>
                <div className="flex flex-col gap-0.5">
                  {subtitleTracks.map((track, i) => {
                    const active = i === (activeTrackIndex ?? -1)
                    return (
                      <button
                        key={i}
                        type="button"
                        onClick={() => onSelectSubtitleTrack?.(i)}
                        className={cn(
                          'flex items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                          active
                            ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                            : 'text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
                        )}
                      >
                        <span className="truncate">{track.label}</span>
                        {active && <Check className="h-3 w-3 shrink-0" />}
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
            {subtitleEnabled && (
              <>
                {/* Load subtitles（URL / 文件 / 自动识别 / 内嵌提取 / 目录Browse）：
                    仅房主可见。Members的Subtitles数据来自房主广播，无需也无权加载，
                    其中「Browse folder」明确不向Members开放 */}
                {isHost && (
                  <div
                    className="mt-1 border-t pt-1"
                    style={{
                      borderColor:
                        'color-mix(in srgb, var(--md-sys-color-outline) 30%, transparent)',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setShowSubtitleLoader((v) => !v)
                        setBrowserOpen(false)
                      }}
                      className="flex w-full items-center justify-between rounded-md px-1 py-0.5 text-xs transition-colors hover:bg-[var(--md-sys-color-surface-container-highest)]"
                      style={{
                        color: 'var(--md-sys-color-on-surface-variant)',
                      }}
                    >
                      <span>{t('Load subtitles')}</span>
                      <ChevronDown
                        className={cn(
                          'h-3 w-3 transition-transform',
                          showSubtitleLoader && 'rotate-180'
                        )}
                      />
                    </button>
                    {showSubtitleLoader && (
                      <div className="mt-1 space-y-1">
                        <div className="flex items-center gap-1">
                          <Input
                            size="sm"
                            value={subtitleUrlInput}
                            onChange={(e) =>
                              setSubtitleUrlInput(e.target.value)
                            }
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                handleAddSubtitleUrl()
                              }
                            }}
                            placeholder={t('https://…/sub.vtt, .srt or .ass')}
                            className="flex-1"
                          />
                          <Button
                            variant="primary"
                            size="sm"
                            className="h-7 w-7 shrink-0 p-0"
                            disabled={!subtitleUrlInput.trim()}
                            onClick={handleAddSubtitleUrl}
                            aria-label={t('Add subtitle URL')}
                            icon={<Plus className="h-3.5 w-3.5" />}
                          />
                        </div>
                        <input
                          ref={subtitleFileInputRef}
                          type="file"
                          accept=".vtt,.srt,.ass,.ssa,.smi,.sami,.sub"
                          className="hidden"
                          onChange={handleSubtitleFileChange}
                        />
                        <Button
                          variant="secondary"
                          size="sm"
                          className="h-7 w-full justify-center gap-1 text-xs"
                          icon={<Upload className="h-3 w-3" />}
                          onClick={() => subtitleFileInputRef.current?.click()}
                        >
                          {t('Upload files')}
                        </Button>
                        {canAutoSearchSubtitles && onAutoSearchSubtitles && (
                          <>
                            <div
                              className="border-t pt-1"
                              style={{
                                borderColor:
                                  'color-mix(in srgb, var(--md-sys-color-outline) 20%, transparent)',
                              }}
                            />
                            <Button
                              variant="secondary"
                              size="sm"
                              className="h-7 w-full justify-center gap-1 text-xs"
                              disabled={autoSearching}
                              icon={
                                autoSearching ? (
                                  <Loader2 className="h-3 w-3 animate-spin" />
                                ) : (
                                  <ScanSearch className="h-3 w-3" />
                                )
                              }
                              onClick={handleAutoSearch}
                            >
                              {autoSearching
                                ? t('Searching…')
                                : t('Find subtitles')}
                            </Button>
                            {autoSearchMsg && (
                              <div
                                className="text-center text-[10px]"
                                style={{
                                  color:
                                    autoSearchMsg.key === 'Search failed.'
                                      ? 'var(--md-sys-color-error)'
                                      : 'var(--md-sys-color-on-surface-variant)',
                                }}
                              >
                                {t(autoSearchMsg.key, autoSearchMsg.params)}
                              </div>
                            )}
                          </>
                        )}
                        {canLoadEmbeddedSubtitles &&
                          onListEmbeddedTracks &&
                          onExtractEmbeddedTrack && (
                            <>
                              <div
                                className="border-t pt-1"
                                style={{
                                  borderColor:
                                    'color-mix(in srgb, var(--md-sys-color-outline) 20%, transparent)',
                                }}
                              />
                              <Button
                                variant="secondary"
                                size="sm"
                                className="h-7 w-full justify-center gap-1 text-xs"
                                disabled={
                                  embeddedListLoading || embeddedLoading
                                }
                                icon={
                                  embeddedListLoading ? (
                                    <Loader2 className="h-3 w-3 animate-spin" />
                                  ) : (
                                    <FileText className="h-3 w-3" />
                                  )
                                }
                                onClick={handleListEmbedded}
                              >
                                {embeddedListLoading
                                  ? t('Detecting…')
                                  : t('Embedded subtitle tracks')}
                              </Button>
                              {embeddedTracks.length > 0 && (
                                <div className="mt-1 flex flex-col gap-0.5">
                                  <div
                                    className="text-[11px] font-medium uppercase tracking-wide"
                                    style={{
                                      color:
                                        'var(--md-sys-color-on-surface-variant)',
                                    }}
                                  >
                                    {t('Available tracks')}
                                  </div>
                                  {embeddedTracks.map((t) => {
                                    const extracting =
                                      extractingIndex === t.index
                                    return (
                                      <button
                                        key={t.index}
                                        type="button"
                                        disabled={embeddedLoading}
                                        onClick={() => handleExtractEmbedded(t)}
                                        className={cn(
                                          'flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors',
                                          extracting
                                            ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)]'
                                            : 'text-[var(--md-sys-color-on-surface)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
                                        )}
                                      >
                                        <span className="truncate">
                                          {t.label}
                                        </span>
                                        <span className="ml-auto shrink-0 text-[10px] text-[var(--md-sys-color-on-surface-variant)]">
                                          {t.codecName}
                                        </span>
                                        {extracting && (
                                          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
                                        )}
                                      </button>
                                    )
                                  })}
                                </div>
                              )}
                              {embeddedMsg && (
                                <div
                                  className="text-center text-[10px]"
                                  style={{
                                    color:
                                      embeddedMsg.key ===
                                        'Extraction failed.' ||
                                      embeddedMsg.key === 'Detection failed.'
                                        ? 'var(--md-sys-color-error)'
                                        : 'var(--md-sys-color-on-surface-variant)',
                                  }}
                                >
                                  {t(embeddedMsg.key, embeddedMsg.params)}
                                </div>
                              )}
                            </>
                          )}
                        {canAutoSearchSubtitles &&
                          browseMovieId != null &&
                          onAddSubtitleContent && (
                            <Button
                              variant={browserOpen ? 'primary' : 'secondary'}
                              size="sm"
                              className="h-7 w-full justify-center gap-1 text-xs"
                              icon={<FolderOpen className="h-3 w-3" />}
                              onClick={() => {
                                setBrowserOpen((v) => !v)
                                setAdvancedOpen(false)
                                setFontPanelOpen(false)
                              }}
                            >
                              {browserOpen
                                ? t('Close browser')
                                : t('Browse folder')}
                            </Button>
                          )}
                      </div>
                    )}
                  </div>
                )}
                {/* Advanced settings入口（Font size / Time offset / Horizontal offset / Font在延伸面板中） */}
                {(onChangeSubtitleFontSize ||
                  onChangeSubtitleOffset ||
                  onChangeSubtitleShiftX ||
                  onChangeSubtitleFontFamily) && (
                  <button
                    type="button"
                    onClick={() => {
                      setAdvancedOpen((v) => !v)
                      setBrowserOpen(false)
                      setFontPanelOpen(false)
                    }}
                    className={cn(
                      'mt-1 flex w-full items-center justify-center gap-1 rounded-md border py-1 text-xs font-medium transition-all active:brightness-95',
                      advancedOpen
                        ? 'bg-[var(--md-sys-color-primary-container)] text-[var(--md-sys-color-on-primary-container)] border-transparent'
                        : 'text-[var(--md-sys-color-on-surface-variant)] hover:bg-[var(--md-sys-color-surface-container-highest)]'
                    )}
                    style={{ borderColor: 'var(--md-sys-color-outline)' }}
                  >
                    {advancedOpen
                      ? t('Hide advanced settings')
                      : t('Advanced settings')}
                    <ChevronRight
                      className={cn(
                        'h-3.5 w-3.5 transition-transform',
                        advancedOpen && 'rotate-180'
                      )}
                    />
                  </button>
                )}
              </>
            )}
          </>
        ) : (
          <DanmakuStylePanel
            style={danmakuStyle!}
            setStyle={onDanmakuStyleChange ?? (() => {})}
            resetStyle={onResetDanmakuStyle ?? (() => {})}
            advancedOpen={advancedOpen}
            onAdvancedToggle={() => {
              setAdvancedOpen((v) => !v)
              setBrowserOpen(false)
              setFontPanelOpen(false)
            }}
          />
        )}
      </div>
    </div>
  )
}
