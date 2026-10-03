const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function load(relative, imports = {}, globals = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', relative), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', ...Object.keys(globals), output)(
    (name) => {
      if (Object.hasOwn(imports, name)) return imports[name]
      throw new Error(`Unexpected player notice import: ${name}`)
    },
    loaded,
    loaded.exports,
    ...Object.values(globals)
  )
  return loaded.exports
}

const { translateMessage } = load('src/i18n/translation.ts')
const dictionary = {
  ...load('src/i18n/core.zh.ts').coreZh,
  ...load('src/i18n/modules.zh.ts').modulesZh,
  ...load('src/i18n/components.zh.ts').componentsZh,
}

function nodes(value) {
  if (!value || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(nodes)
  return [value, ...nodes(value.props?.children)]
}

function text(value) {
  if (value == null || typeof value === 'boolean') return ''
  if (Array.isArray(value)) return value.map(text).join('')
  if (typeof value === 'object') return text(value.props?.children)
  return String(value)
}

test('subtitle results change language without rerunning extraction or clearing input', async () => {
  let locale = 'zh'
  const t = (copy, params) => translateMessage(locale, copy, dictionary, params)
  const state = []
  let cursor = 0
  const component = () => null
  const ui = new Proxy({}, { get: () => component })
  const timers = []
  const { SettingsPanel } = load(
    'src/components/VideoPlayer/SettingsPanel.tsx',
    {
      react: {
        useState(initial) {
          const index = cursor++
          if (!(index in state)) state[index] = initial
          return [
            state[index],
            (next) => {
              state[index] =
                typeof next === 'function' ? next(state[index]) : next
            },
          ]
        },
        useRef: (value) => ({ current: value }),
      },
      'react/jsx-runtime': require('react/jsx-runtime'),
      'lucide-react': ui,
      '@/i18n': { t, useTranslation: () => ({ locale }) },
      '@/components/ui/Input': ui,
      '@/components/ui/Switch': ui,
      '@/components/ui/Slider': ui,
      '@/components/ui/Button': ui,
      '@/components/ui/FontPicker': ui,
      '@/lib/utils': { cn: (...values) => values.filter(Boolean).join(' ') },
      '@/modules/room/watch-together/DanmakuStylePanel': ui,
      './AnimatedSidePanel': ui,
      './SubtitleBrowser': ui,
      '@/store/danmakuStore': {
        DEFAULT_DANMAKU_STYLE: { advanced: { fontFamily: 'sans-serif' } },
      },
    },
    { setTimeout: (callback) => timers.push(callback) }
  )
  const track = {
    index: 7,
    label: '导演版 "字幕" $& {title}',
    codecName: 'ASS',
  }
  let searches = 0
  let extractions = 0
  const props = {
    isHost: true,
    subtitleEnabled: true,
    canAutoSearchSubtitles: true,
    canLoadEmbeddedSubtitles: true,
    onAutoSearchSubtitles: async () => {
      searches++
      return 2
    },
    onListEmbeddedTracks: async () => [track],
    onExtractEmbeddedTrack: async (selected) => {
      assert.equal(selected, track)
      extractions++
      return 1
    },
  }
  const render = () => {
    cursor = 0
    return SettingsPanel(props)
  }
  const button = (tree, label) => {
    const result = nodes(tree).find(
      (node) => node.props?.onClick && text(node) === label
    )
    assert.ok(result, label)
    return result
  }
  button(render(), t('Load subtitles')).props.onClick()
  const input = nodes(render()).find((node) =>
    node.props?.placeholder?.startsWith('https://')
  )
  input.props.onChange({
    target: { value: 'https://example.test/my-subtitles.srt' },
  })
  await button(render(), t('Find subtitles')).props.onClick()
  assert.ok(text(render()).includes('找到 2 条字幕轨道'))
  locale = 'en'
  assert.ok(text(render()).includes('Found 2 subtitle tracks'))
  await button(render(), t('Embedded subtitle tracks')).props.onClick()
  await button(render(), track.label + track.codecName).props.onClick()
  assert.ok(text(render()).includes(`Extracted subtitle track: ${track.label}`))
  assert.ok(!text(render()).includes('」'))
  locale = 'zh'
  assert.ok(text(render()).includes(`已提取字幕轨道：${track.label}`))
  const retainedInput = nodes(render()).find((node) =>
    node.props?.placeholder?.startsWith('https://')
  )
  assert.equal(
    retainedInput.props.value,
    'https://example.test/my-subtitles.srt'
  )
  assert.equal(searches, 1)
  assert.equal(extractions, 1)
  assert.equal(timers.length, 2)
})

function toastHarness({ reduced = false, stagger = '50ms' } = {}) {
  let locale = 'zh'
  let nextTimer = 0
  const timers = new Map()
  const subscribers = new Set()
  const elements = []
  class Element {
    constructor(tagName) {
      this.tagName = tagName
      this.children = []
      this.attributes = new Map()
      this.dataset = {}
      this.style = {
        setProperty: (key, value) => {
          this.style[key] = value
        },
      }
      this.classList = { add() {}, remove() {} }
      this.offsetHeight = 40
    }
    appendChild(child) {
      this.children.push(child)
    }
    setAttribute(name, value) {
      this.attributes.set(name, value)
    }
    addEventListener() {}
    remove() {
      this.removed = true
    }
  }
  const body = new Element('body')
  body.dataset.reducedMotion = String(reduced)
  const document = {
    body,
    documentElement: new Element('html'),
    getElementById: (id) =>
      elements.find((element) => element.id === id) ?? null,
    createElement: (tag) => {
      const element = new Element(tag)
      elements.push(element)
      return element
    },
  }
  const globals = {
    document,
    window: { matchMedia: () => ({ matches: reduced }) },
    getComputedStyle: (element) => ({
      getPropertyValue: () => (element === body ? stagger : '50ms'),
    }),
    Date: { now: () => 1000 },
    setTimeout: (callback, delay) => {
      const id = ++nextTimer
      timers.set(id, { callback, delay })
      return id
    },
    clearTimeout: (id) => timers.delete(id),
  }
  const motion = load('src/components/ui/motion.ts', {}, globals)
  const t = (copy, params) => translateMessage(locale, copy, dictionary, params)
  const { message } = load(
    'src/components/ui/message.ts',
    {
      './motion': motion,
      '@/i18n': {
        t,
        useLocaleStore: {
          subscribe(listener) {
            subscribers.add(listener)
            return () => subscribers.delete(listener)
          },
        },
      },
    },
    globals
  )
  return {
    message,
    timers,
    subscribers,
    body,
    setLocale(next) {
      const previous = locale
      locale = next
      for (const listener of subscribers)
        listener({ locale }, { locale: previous })
    },
  }
}

test('visible notifications change language without resetting their lifetime and unsubscribe on close', () => {
  const harness = toastHarness()
  const label = '字幕 "English" $& {title}'
  harness.message.success(`Extracted subtitle track: ${label}`)
  const toast = harness.body.children[0].children[0]
  const content = toast.children[1]
  const close = toast.children[2]
  assert.equal(content.textContent, `已提取字幕轨道：${label}`)
  assert.equal(close.attributes.get('aria-label'), '关闭通知')
  const initialTimers = [...harness.timers]
  harness.setLocale('en')
  assert.equal(content.textContent, `Extracted subtitle track: ${label}`)
  assert.equal(close.attributes.get('aria-label'), 'Dismiss notification')
  assert.deepEqual([...harness.timers], initialTimers)
  close.onclick()
  assert.equal(harness.subscribers.size, 0)
  const cleanup = [...harness.timers.values()].find(
    (timer) => timer.delay === 160
  )
  assert.ok(cleanup)
  cleanup.callback()
  assert.equal(toast.removed, true)
})

test('notifications bound stagger delays and honor reduced-motion exit cleanup', () => {
  const normal = toastHarness()
  for (let index = 0; index < 8; index++) normal.message.info('Saved.')
  const toasts = normal.body.children[0].children
  assert.equal(toasts[1].style.animationDelay, '50ms')
  assert.equal(toasts[7].style.animationDelay, '250ms')
  const reduced = toastHarness({ reduced: true, stagger: '0ms' })
  reduced.message.info('Saved.')
  reduced.message.info('Saved.')
  const second = reduced.body.children[0].children[1]
  assert.equal(second.style.animationDelay, undefined)
  second.children[2].onclick()
  assert.ok([...reduced.timers.values()].some((timer) => timer.delay === 1))
})
