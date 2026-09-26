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
const directory = { rooms: [{ roomId: 'shared' }], loading: false, error: '' }
const loaded = { exports: {} }
new Function('require', 'module', 'exports', output)(
  (name) => {
    if (name === 'react/jsx-runtime') return require('react/jsx-runtime')
    if (name === '@/store/authStore') {
      return { useAuthStore: () => ({ authResolved: true, isAuthenticated: true, user: { id: 'guest' } }) }
    }
    if (name === '@/hooks/useRoomDirectory') {
      return { useRoomDirectory: () => { loads += 1; return directory } }
    }
    if (name === './HomePage') {
      return { default: ({ directory: value }) => React.createElement('div', { 'data-view': 'home' }, value.rooms[0].roomId) }
    }
    if (name === './RoomsListPage') {
      return { default: ({ directory: value }) => React.createElement('div', { 'data-view': 'discover' }, value.rooms[0].roomId) }
    }
    throw new Error(`Unexpected import: ${name}`)
  },
  loaded,
  loaded.exports
)

test('both hall modes receive the same directory through one route-level hook', () => {
  const HallPage = loaded.exports.default
  const home = renderToStaticMarkup(React.createElement(HallPage, { mode: 'home' }))
  const discover = renderToStaticMarkup(React.createElement(HallPage, { mode: 'discover' }))
  assert.match(home, /data-view="home">shared/)
  assert.match(discover, /data-view="discover">shared/)
  assert.equal(loads, 2)
})
