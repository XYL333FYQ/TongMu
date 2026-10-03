const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function load(relative, imports, globals) {
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
      throw new Error(`Unexpected server-file motion import: ${name}`)
    },
    loaded,
    loaded.exports,
    ...Object.values(globals)
  )
  return loaded.exports
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

let nextHarnessId = 0

function harness(
  relative,
  exported,
  {
    reduced = false,
    props = {},
    entries = [],
    document: providedDocument,
    mount = () => {},
  } = {}
) {
  const harnessId = ++nextHarnessId
  const slots = []
  const pendingEffects = []
  const timers = new Map()
  const listeners = new Map()
  let cursor = 0
  let timerId = 0
  let now = 0
  const same = (left, right) =>
    left &&
    right &&
    left.length === right.length &&
    left.every((v, i) => Object.is(v, right[i]))
  const react = {
    useId() {
      const index = cursor++
      if (!(index in slots))
        slots[index] = { value: `:server-file-${harnessId}-${index}:` }
      return slots[index].value
    },
    useState(initial) {
      const index = cursor++
      if (!(index in slots))
        slots[index] = {
          value: typeof initial === 'function' ? initial() : initial,
        }
      return [
        slots[index].value,
        (next) => {
          slots[index].value =
            typeof next === 'function' ? next(slots[index].value) : next
        },
      ]
    },
    useRef(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = { value: { current: initial } }
      return slots[index].value
    },
    useMemo(factory, deps) {
      const index = cursor++
      if (!same(slots[index]?.deps, deps))
        slots[index] = { value: factory(), deps }
      return slots[index].value
    },
    useCallback(callback, deps) {
      return react.useMemo(() => callback, deps)
    },
    useEffect(effect, deps) {
      const index = cursor++
      if (same(slots[index]?.deps, deps)) return
      pendingEffects.push(() => {
        slots[index]?.cleanup?.()
        slots[index] = { deps, cleanup: effect() }
      })
    },
  }
  const globals = {
    document: providedDocument ?? {
      body: { dataset: { reducedMotion: String(reduced) } },
    },
    window: {
      matchMedia: () => ({ matches: reduced }),
      addEventListener(name, callback) {
        if (!listeners.has(name)) listeners.set(name, new Set())
        listeners.get(name).add(callback)
      },
      removeEventListener: (name, callback) =>
        listeners.get(name)?.delete(callback),
    },
    setTimeout(callback, delay) {
      const id = ++timerId
      timers.set(id, { callback, deadline: now + delay })
      return id
    },
    clearTimeout: (id) => timers.delete(id),
  }
  const motion = load('src/components/ui/motion.ts', {}, globals)
  const disclosure = load(
    'src/components/ui/useDisclosureMotion.ts',
    { react, './motion': motion },
    globals
  )
  const ui = new Proxy({}, { get: () => () => null })
  const roots = [
    { key: 'uploads', name: 'Uploads', exists: true, absPath: '/uploads' },
    {
      key: 'custom:1',
      name: 'Movies',
      exists: true,
      absPath: '/movies',
      readonly: true,
    },
    {
      key: 'custom:2',
      name: 'Unavailable folder',
      exists: false,
      absPath: '/missing',
    },
  ]
  const imports = {
    react,
    'react/jsx-runtime': require('react/jsx-runtime'),
    'react-dom': { createPortal: (children) => children },
    'lucide-react': ui,
    '@/i18n': { t: (source) => source, useTranslation: () => ({}) },
    '@/components/ui/motion': motion,
    '@/components/ui/useDisclosureMotion': disclosure,
    '@/components/ui/message': {
      message: { error() {}, success() {}, warning() {} },
    },
    '@/lib/utils': {
      cn: (...values) => values.filter(Boolean).join(' '),
      formatFileSize: String,
    },
    '@/modules/bilibili/bilibiliApi': {
      resolveBilibili: async () => ({
        title: 'Fixture video',
        acceptQuality: [{ id: 64, label: '720P' }],
      }),
    },
    './serverFilesApi': {
      listServerRoots: async () => roots,
      browseServerFiles: async (currentPath = 'uploads:/') => ({
        entries,
        currentPath,
      }),
      extractRootKey: (value) =>
        value.startsWith('custom:')
          ? value.split(':').slice(0, 2).join(':')
          : 'uploads',
    },
    './DirPickerSidePanel': ui,
  }
  for (const name of [
    'Button',
    'Input',
    'Modal',
    'Spinner',
    'Switch',
    'Typography',
  ]) {
    imports[`@/components/ui/${name}`] = ui
  }
  const component = load(relative, imports, globals)[exported]
  const render = () => {
    cursor = 0
    const result = component(props)
    mount(result)
    for (const effect of pendingEffects.splice(0)) effect()
    return result
  }
  return {
    props,
    timers,
    render,
    async ready() {
      render()
      await new Promise((resolve) => setImmediate(resolve))
      return render()
    },
    tick(elapsed) {
      now += elapsed
      for (const [id, timer] of [...timers]) {
        if (timer.deadline > now) continue
        timers.delete(id)
        timer.callback()
      }
    },
    outsideClick() {
      for (const callback of listeners.get('click') ?? []) callback()
    },
    unmount() {
      for (const slot of slots) slot?.cleanup?.()
      assert.equal(timers.size, 0, 'unmount must clear all disclosure timers')
      assert.ok(
        [...listeners.values()].every((callbacks) => callbacks.size === 0)
      )
    },
  }
}

function click(tree, caption) {
  const button = nodes(tree).find(
    (node) => node.props?.onClick && text(node) === caption
  )
  assert.ok(button, `missing action ${caption}`)
  button.props.onClick({ stopPropagation() {} })
}

const menu = (tree) =>
  nodes(tree).find((node) =>
    /zen-dropdown-(enter|exit)/.test(node.props?.className ?? '')
  )

for (const [file, exported] of [
  ['ServerFilesBrowser', 'default'],
  ['ServerFileManager', 'default'],
  ['BilibiliDownloadModal', 'BilibiliDownloadModal'],
]) {
  test(`${file} retains the closing roots menu, cancels stale close on reopen and cleans up on unmount`, async () => {
    const h = harness(`src/modules/server-files/${file}.tsx`, exported, {
      props: { open: true },
    })
    let tree = await h.ready()
    if (file === 'BilibiliDownloadModal') {
      nodes(tree)
        .find((node) => node.props?.placeholder?.includes('bilibili.com'))
        .props.onChange({
          target: { value: 'https://www.bilibili.com/video/BVfixture' },
        })
      click(h.render(), 'Resolve')
      tree = await h.ready()
    }
    click(tree, 'Uploads')
    tree = h.render()
    const unavailable = nodes(menu(tree)).find(
      (node) =>
        node.props?.disabled && text(node).startsWith('Unavailable folder')
    )
    assert.ok(unavailable, 'unavailable roots must remain disabled')
    h.outsideClick()
    tree = h.render()
    assert.match(menu(tree).props.className, /zen-dropdown-exit/)
    h.tick(159)
    assert.ok(menu(h.render()), 'menu must remain mounted during exit')
    click(h.render(), 'Uploads')
    assert.match(menu(h.render()).props.className, /zen-dropdown-enter/)
    h.tick(1)
    assert.ok(menu(h.render()), 'old close must not unmount reopened menu')
    h.outsideClick()
    h.render()
    h.tick(160)
    assert.equal(menu(h.render()), undefined)
    click(h.render(), 'Uploads')
    h.render()
    h.outsideClick()
    h.render()
    h.unmount()
  })
}

test('Add server folder keeps its draft during exit and cancels old close when reopened', async () => {
  const h = harness('src/modules/server-files/ServerFileManager.tsx', 'default')
  click(await h.ready(), 'Add folder')
  let tree = h.render()
  nodes(tree)
    .find((node) => node.props?.label === 'Name')
    .props.onChange({ target: { value: 'My retained draft' } })
  click(h.render(), 'Cancel')
  tree = h.render()
  assert.ok(
    nodes(tree).some((node) =>
      /zen-modal-content-exit/.test(node.props?.className ?? '')
    )
  )
  assert.equal(
    nodes(tree).find((node) => node.props?.label === 'Name').props.value,
    'My retained draft'
  )
  h.tick(159)
  click(h.render(), 'Add folder')
  h.render()
  h.tick(1)
  assert.ok(
    nodes(h.render()).some((node) =>
      /zen-modal-content-enter/.test(node.props?.className ?? '')
    )
  )
  click(h.render(), 'Cancel')
  h.render()
  h.unmount()
})

test('controlled Bilibili popup honors reduced exit time and cancels a close on quick reopen', async () => {
  const h = harness(
    'src/modules/server-files/BilibiliDownloadModal.tsx',
    'BilibiliDownloadModal',
    { reduced: true, props: { open: true } }
  )
  await h.ready()
  h.props.open = false
  h.render()
  assert.ok(h.render())
  h.props.open = true
  h.render()
  h.tick(1)
  assert.ok(h.render(), 'cancelled close must not hide the popup')
  h.props.open = false
  h.render()
  h.tick(1)
  assert.equal(h.render(), null, 'reduced-motion close must not wait 220ms')
  h.unmount()
})

test('embedded server files hide only their headings and name row actions', async () => {
  const h = harness(
    'src/modules/server-files/ServerFileManager.tsx',
    'default',
    {
      entries: [
        { name: '用户影片.mp4', path: 'uploads:/用户影片.mp4', type: 'file' },
      ],
    }
  )
  let tree = await h.ready()
  assert.ok(text(tree).includes('Server filesSERVER FILES'))
  h.props.showHeading = false
  tree = h.render()
  assert.ok(!text(tree).includes('Server filesSERVER FILES'))
  for (const caption of ['Refresh', 'Add folder', 'New folder', 'Upload files'])
    assert.ok(nodes(tree).some((node) => text(node) === caption))
  assert.ok(text(tree).includes('用户影片.mp4'))
  assert.ok(nodes(tree).some((node) => node.props?.['aria-label'] === 'Rename'))
  assert.ok(nodes(tree).some((node) => node.props?.['aria-label'] === 'Delete'))
  h.unmount()
})

test('Add server folder traps focus without resetting drafts and restores its opener after exit', async () => {
  const keyListeners = new Set()
  let mounted = false
  let nestedDialog = null
  const document = {
    body: { dataset: { reducedMotion: 'false' } },
    activeElement: null,
    addEventListener(name, callback) {
      if (name === 'keydown') keyListeners.add(callback)
    },
    removeEventListener(name, callback) {
      if (name === 'keydown') keyListeners.delete(callback)
    },
    querySelectorAll(selector) {
      if (selector === '[data-tongmu-modal]')
        return mounted ? [dialog, ...(nestedDialog ? [nestedDialog] : [])] : []
      return []
    },
  }
  const element = (hidden = false) => ({
    isConnected: true,
    disabled: false,
    focus() {
      document.activeElement = this
    },
    getClientRects: () => [{}],
    closest: () => (hidden ? { inert: true } : null),
  })
  const opener = element()
  const close = element()
  const name = element()
  const path = element()
  const cancel = element()
  const add = element()
  const hiddenPickerAction = element(true)
  const items = [close, name, path, cancel, add, hiddenPickerAction]
  const dialog = {
    ...element(),
    contains: (active) => active === dialog || items.includes(active),
    querySelectorAll: () => items.filter((item) => !item.disabled),
  }
  opener.focus()
  const h = harness(
    'src/modules/server-files/ServerFileManager.tsx',
    'default',
    {
      document,
      mount(tree) {
        const node = nodes(tree).find(
          (node) => node.props?.['data-tongmu-modal']
        )
        mounted = Boolean(node)
        if (node) node.ref.current = dialog
      },
    }
  )
  const keyDown = (key, shiftKey = false) => {
    const event = {
      key,
      shiftKey,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true
      },
      stopPropagation() {},
    }
    for (const listener of keyListeners) listener(event)
    return event
  }
  click(await h.ready(), 'Add folder')
  let tree = h.render()
  assert.equal(document.activeElement, close)
  add.focus()
  assert.equal(keyDown('Tab').defaultPrevented, true)
  assert.equal(
    document.activeElement,
    close,
    'hidden picker must not enter the Tab loop'
  )
  assert.equal(keyDown('Tab', true).defaultPrevented, true)
  assert.equal(document.activeElement, add)
  add.disabled = true
  cancel.focus()
  keyDown('Tab')
  assert.equal(document.activeElement, close, 'disabled Add must be excluded')
  name.focus()
  nodes(tree)
    .find((node) => node.props?.label === 'Name')
    .props.onChange({ target: { value: 'Retained keyboard draft' } })
  tree = h.render()
  assert.equal(document.activeElement, name, 'typing must not reset focus')
  nestedDialog = element()
  assert.equal(keyDown('Escape').defaultPrevented, false)
  assert.ok(mounted, 'a topmost nested dialog owns Escape')
  nestedDialog = null
  assert.equal(keyDown('Escape').defaultPrevented, true)
  tree = h.render()
  assert.equal(
    nodes(tree).find((node) => node.props?.label === 'Name').props.value,
    'Retained keyboard draft'
  )
  assert.ok(mounted, 'dialog remains mounted throughout its exit')
  h.tick(159)
  h.render()
  assert.equal(document.activeElement, name)
  h.tick(1)
  h.render()
  assert.equal(mounted, false)
  assert.equal(document.activeElement, opener)
  assert.equal(keyListeners.size, 0)
  h.unmount()
})
