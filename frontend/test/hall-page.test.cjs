const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const source = fs.readFileSync(
  path.join(__dirname, '../src/pages/HallPage.tsx'),
  'utf8'
)
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText
let loads = 0
let query = ''
let role = 'user'
let creationMode = 'all-users'
let locale = 'en'
function loadTranslation(relative) {
  const loaded = { exports: {} }
  const output = ts.transpileModule(
    fs.readFileSync(path.join(__dirname, '../src/i18n', relative), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } }
  ).outputText
  new Function('module', 'exports', output)(loaded, loaded.exports)
  return loaded.exports
}
const { translateMessage } = loadTranslation('translation.ts')
const zh = {
  ...loadTranslation('components.zh.ts').componentsZh,
  ...loadTranslation('core.zh.ts').coreZh,
  ...loadTranslation('modules.zh.ts').modulesZh,
  ...loadTranslation('pages.zh.ts').pagesZh,
}
const directory = {
  rooms: [
    {
      roomId: 'shared',
      name: 'Movie night',
      status: 'active',
      mode: 'watch-together',
      viewerCount: 2,
      maxViewers: 10,
    },
    {
      roomId: 'closed',
      name: 'Closed room',
      status: 'closed',
      mode: 'watch-together',
    },
  ],
  loading: false,
  error: '',
  refresh() {},
}
const loaded = { exports: {} }
const icon = () => React.createElement('svg', { 'aria-hidden': true })
new Function('require', 'module', 'exports', output)(
  (name) => {
    if (name === 'react' || name === 'react/jsx-runtime') return require(name)
    if (name === 'react-router-dom')
      return {
        useNavigate: () => () => {},
        useSearchParams: () => [new URLSearchParams(query), () => {}],
      }
    if (name === 'lucide-react') return new Proxy({}, { get: () => icon })
    if (name === '@/i18n')
      return {
        t: (copy, params) => translateMessage(locale, copy, zh, params),
        canonicalProductMessage: (copy) => translateMessage('en', copy, zh),
        getLocale: () => locale,
        useTranslation: () => ({ locale }),
      }
    if (name === '@/store/authStore')
      return {
        useAuthStore: () => ({
          authResolved: true,
          isAuthenticated: true,
          user: { id: 1, role },
        }),
      }
    if (name === '@/store/systemSettingsStore')
      return {
        useSystemSettingsStore: (selector) =>
          selector({ roomCreationMode: creationMode }),
      }
    if (name === '@/hooks/useRoomDirectory')
      return {
        useRoomDirectory: () => {
          loads++
          return directory
        },
      }
    if (name === '@/components/ui/Button')
      return {
        Button: ({ children, icon, variant, size, ...props }) =>
          React.createElement('button', props, icon, children),
      }
    if (name === '@/components/ui/Spinner') return { Spinner: () => null }
    if (name === '@/components/JoinRoomDialog')
      return { JoinRoomDialog: () => null }
    if (name === '@/components/RoomCoverImage')
      return {
        RoomCoverImage: ({ coverUrl }) =>
          React.createElement('img', {
            src: coverUrl || '/room-covers/cinema.webp',
            alt: '',
          }),
      }
    if (name === '@/lib/roomDirectory')
      return { roomPath: (id) => `/room/${encodeURIComponent(id)}` }
    throw new Error(`Unexpected import: ${name}`)
  },
  loaded,
  loaded.exports
)
const render = (mode) =>
  renderToStaticMarkup(React.createElement(loaded.exports.default, { mode }))

test('legacy hall URLs show the same real directory with one create and join entry', () => {
  loads = 0
  query = ''
  role = 'user'
  creationMode = 'all-users'
  for (const mode of ['home', 'discover']) {
    const html = render(mode)
    assert.match(html, /Movie night/)
    assert.doesNotMatch(html, /Closed room/)
    assert.equal((html.match(/>Create room<\/button>/g) || []).length, 1)
    assert.equal((html.match(/>Join by ID<\/button>/g) || []).length, 1)
    assert.doesNotMatch(html, /data-view="home"|data-view="discover"/)
  }
  assert.equal(loads, 2)
})
test('URL search filters real rooms and keeps the empty-state recovery guidance', () => {
  query = 'q=missing'
  const html = render('home')
  assert.doesNotMatch(html, /Movie night/)
  assert.match(html, /No matching rooms/)
  assert.match(html, /Try another name, room ID, or activity/)
  query = ''
})
test('creation entry follows the platform creation rule and never grants guests creation', () => {
  creationMode = 'admins-only'
  role = 'user'
  assert.doesNotMatch(render('home'), />Create room<\/button>/)
  role = 'admin'
  assert.match(render('home'), />Create room<\/button>/)
  creationMode = 'all-users'
  role = 'guest'
  assert.doesNotMatch(render('home'), />Create room<\/button>/)
})

test('hall language changes labels and counts while preserving room data and search', () => {
  const previousName = directory.rooms[0].name
  directory.rooms[0].name = '朋友 Alice · Movie night'
  role = 'user'
  creationMode = 'all-users'
  query = 'q=Alice'
  try {
    locale = 'zh'
    const chinese = render('home')
    assert.match(chinese, /房间大厅/)
    assert.match(chinese, /创建房间/)
    assert.match(chinese, /共有 1 个房间/)
    assert.match(chinese, /朋友 Alice · Movie night/)
    assert.match(chinese, /placeholder="搜索名称或房间号"/)
    assert.match(chinese, /tm-room-art--watch/)

    locale = 'en'
    const english = render('home')
    assert.match(english, /Room hall/)
    assert.match(english, /1 room available/)
    assert.match(english, /朋友 Alice · Movie night/)
    assert.match(english, /placeholder="Search name or room ID"/)
    assert.doesNotMatch(english, /房间大厅|共有 1 个房间/)

    locale = 'zh'
    query = 'q=missing'
    assert.match(render('home'), /没有匹配的房间/)
  } finally {
    directory.rooms[0].name = previousName
    locale = 'en'
    query = ''
  }
})
