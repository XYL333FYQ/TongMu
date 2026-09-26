const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function load(relativePath, imports = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', output)(
    (name) => imports[name], loaded, loaded.exports,
  )
  return loaded.exports
}

const { roomPath, featuredRooms } = load('src/lib/roomDirectory.ts')

test('room entry trims IDs, rejects blank IDs and keeps a room ID in one encoded URL segment', () => {
  assert.equal(roomPath('  Ab12Cd34  '), '/room/Ab12Cd34')
  assert.equal(roomPath('  '), null)
  assert.equal(roomPath('a?b#c'), '/room/a%3Fb%23c')
  assert.equal(roomPath('a/b'), '/room/a%2Fb')
  assert.equal(roomPath('房间 1'), '/room/%E6%88%BF%E9%97%B4%201')
})

test('home selects latest active rooms without changing the shared directory order', () => {
  const rooms = [
    { roomId: 'a', status: 'active', lastAccessedAt: '2026-01-01T00:00:00Z' },
    { roomId: 'b', status: 'closed', lastAccessedAt: '2026-01-05T00:00:00Z' },
    { roomId: 'c', status: 'active', lastAccessedAt: '2026-01-03T00:00:00Z' },
    { roomId: 'd', status: 'active', lastAccessedAt: '2026-01-04T00:00:00Z' },
    { roomId: 'e', status: 'active', lastAccessedAt: '2026-01-02T00:00:00Z' },
  ]
  assert.deepEqual(featuredRooms(rooms).map((room) => room.roomId), ['d', 'c', 'e'])
  assert.deepEqual(rooms.map((room) => room.roomId), ['a', 'b', 'c', 'd', 'e'])
})

test('room directory shares an in-flight GET and discards a previous account response', async () => {
  const pending = []
  let state
  const useStore = (selector) => selector(state)
  useStore.setState = (next) => { state = { ...state, ...next } }
  const { useRoomDirectory } = load('src/hooks/useRoomDirectory.ts', {
    react: { useEffect: (effect) => effect() },
    zustand: { create: (initializer) => {
      state = initializer()
      return useStore
    } },
    '@/lib/api': { apiFetch: (_url, options) => new Promise((resolve) => {
      pending.push({ resolve, signal: options.signal })
    }) },
  })

  useRoomDirectory(true, true, 'account-a')
  useRoomDirectory(true, true, 'account-a')
  assert.equal(pending.length, 1)
  useRoomDirectory(true, true, 'account-b')
  assert.equal(pending.length, 2)
  assert.equal(pending[0].signal.aborted, true)
  pending[0].resolve({ ok: true, json: async () => ({ success: true, rooms: [{ roomId: 'old' }] }) })
  pending[1].resolve({ ok: true, json: async () => ({ success: true, rooms: [{ roomId: 'current' }] }) })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(state.rooms.map((room) => room.roomId), ['current'])
  assert.equal(state.loading, false)
})
