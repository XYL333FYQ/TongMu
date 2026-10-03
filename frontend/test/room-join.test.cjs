const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function createHarness(initialOptions = {}) {
  const hooks = []
  let cursor = 0
  let dirty = false
  let effects = []
  let result
  let locale = 'en'
  let mounted = true
  const requests = []
  const notices = []
  const grants = []
  const storage = []
  const timers = new Map()
  const listeners = new Map()
  const windowListeners = new Map()
  const approved = []
  const roomState = {
    activeRoomId: null,
    setMode: () => {},
    setShareMethod: () => {},
    setStreamKey: () => {},
    setActiveRoomId: (roomId) => {
      roomState.activeRoomId = roomId
    },
    reset: () => {
      roomState.activeRoomId = null
    },
  }
  const store = (selector) => selector(roomState)
  store.getState = () => roomState
  const same = (left, right) =>
    left &&
    right &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]))
  const react = {
    useState: (initial) => {
      const index = cursor++
      if (!hooks[index]) {
        const slot = {
          value: typeof initial === 'function' ? initial() : initial,
        }
        slot.set = (next) => {
          const value = typeof next === 'function' ? next(slot.value) : next
          if (!Object.is(value, slot.value)) {
            slot.value = value
            dirty = true
          }
        }
        hooks[index] = slot
      }
      return [hooks[index].value, hooks[index].set]
    },
    useRef: (value) => {
      const index = cursor++
      hooks[index] ??= { current: value }
      return hooks[index]
    },
    useCallback: (callback, dependencies) => {
      const index = cursor++
      if (!hooks[index] || !same(hooks[index].dependencies, dependencies))
        hooks[index] = { value: callback, dependencies }
      return hooks[index].value
    },
    useEffect: (effect, dependencies) => {
      const index = cursor++
      const previous = hooks[index]
      if (!previous || !same(previous.dependencies, dependencies)) {
        hooks[index] = { dependencies, cleanup: previous?.cleanup }
        effects.push(() => {
          hooks[index].cleanup?.()
          hooks[index].cleanup = effect()
        })
      }
    },
  }
  const socket = {
    id: 'socket-1',
    connected: true,
    on: (event, callback) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(callback)
    },
    off: (event, callback) => listeners.get(event)?.delete(callback),
    emit: (event, payload, acknowledge) => {
      if (event === 'request-join') requests.push({ payload, acknowledge })
    },
  }
  const window = {
    location: {
      reload: () => {
        storage.push(['reload'])
      },
    },
    addEventListener: (event, callback) => {
      if (!windowListeners.has(event)) windowListeners.set(event, new Set())
      windowListeners.get(event).add(callback)
    },
    removeEventListener: (event, callback) =>
      windowListeners.get(event)?.delete(callback),
  }
  let nickname = 'Room guest'
  const source = fs.readFileSync(
    path.join(__dirname, '../src/modules/screen-sharing/hooks/useJoinRoom.ts'),
    'utf8'
  )
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const loaded = { exports: {} }
  const imports = {
    react,
    '@/i18n': {
      t: (copy) => (locale === 'zh' ? `中文：${copy}` : copy),
      useTranslation: () => ({ locale }),
    },
    '@/store/roomStore': { useRoomStore: store },
    '@/store/authStore': {
      useAuthStore: { getState: () => ({ user: { role: 'guest' } }) },
    },
    '@/components/ui/message': {
      message: {
        success: (copy) => notices.push(copy),
        warning: (copy) => notices.push(copy),
      },
    },
    '@/modules/media/roomMediaGrant': {
      storeRoomMediaGrant: (roomId, grant) => grants.push({ roomId, grant }),
    },
    '@/modules/room/guestNickname': {
      getGuestNickname: () => nickname,
      saveGuestNickname: (value) => {
        nickname = value
        storage.push(['nickname', value])
      },
    },
    '@/modules/room/roomErrors': { roomErrorMessage: (message) => message },
    '@/lib/mediaTeardown': {
      ROOM_MEDIA_TEARDOWN_EVENT: 'tongmu:room-media-teardown',
    },
  }
  new Function(
    'require',
    'module',
    'exports',
    'window',
    'sessionStorage',
    'setTimeout',
    'clearTimeout',
    output
  )(
    (name) => {
      if (!(name in imports)) throw new Error(`Unexpected import: ${name}`)
      return imports[name]
    },
    loaded,
    loaded.exports,
    window,
    { setItem: (key, value) => storage.push([key, value]) },
    (callback) => {
      const timer = {}
      timers.set(timer, callback)
      return timer
    },
    (timer) => timers.delete(timer)
  )
  let options = {
    socket,
    roomId: 'room-a',
    connected: true,
    autoJoin: false,
    onApprovedWatchTogether: () => approved.push('watch-together'),
    ...initialOptions,
  }
  const render = (next = {}) => {
    options = { ...options, ...next }
    for (let pass = 0; pass < 20; pass++) {
      dirty = false
      cursor = 0
      effects = []
      result = loaded.exports.useJoinRoom(options)
      effects.forEach((effect) => effect())
      if (!dirty) return result
    }
    throw new Error('The hook did not settle')
  }
  const fire = (event, payload) =>
    [...(listeners.get(event) ?? [])].forEach((callback) => callback(payload))
  render()
  return {
    socket,
    requests,
    notices,
    grants,
    storage,
    timers,
    approved,
    roomState,
    render,
    get result() {
      return result
    },
    acknowledge: (index, response) => {
      requests[index].acknowledge(response)
      if (mounted) render()
    },
    disconnect: () => {
      socket.connected = false
      fire('disconnect', 'transport error')
      render({ connected: false })
    },
    reconnect: () => {
      socket.connected = true
      socket.id = `socket-${Number(socket.id.split('-')[1]) + 1}`
      fire('connect')
      render({ connected: true })
    },
    recoverBeforeRender: () => {
      socket.connected = false
      fire('disconnect', 'transport error')
      socket.connected = true
      socket.id = `socket-${Number(socket.id.split('-')[1]) + 1}`
      fire('connect')
      render({ connected: true })
    },
    fire: (event, payload) => {
      fire(event, payload)
      render()
    },
    setLocale: (value) => {
      locale = value
      render()
    },
    teardown: (full) => {
      ;[...(windowListeners.get('tongmu:room-media-teardown') ?? [])].forEach(
        (callback) => callback({ detail: { full } })
      )
      render()
    },
    advanceTimers: () => {
      const callbacks = [...timers.values()]
      timers.clear()
      callbacks.forEach((callback) => callback())
      render()
    },
    unmount: () => {
      mounted = false
      hooks.forEach((hook) => hook?.cleanup?.())
    },
  }
}

const joined = (mediaGrant = 'grant') => ({
  success: true,
  message: '已加入房间',
  data: { mode: 'watch-together', mediaGrant },
})

test('manual private-room password survives a transport race and subsequent reconnects without extra locale joins', () => {
  const room = createHarness()
  room.result.requestJoin('room-a', 'wrong-password')
  room.render()
  room.disconnect()
  room.result.requestJoin('room-a', 'correct-password', 'A guest')
  room.render()
  room.reconnect()
  assert.equal(room.requests.length, 2)
  assert.equal(room.requests[1].payload.password, 'correct-password')
  room.acknowledge(0, { success: false, message: '密码错误' })
  assert.equal(room.result.joinStatus, 'joining')
  room.acknowledge(1, joined())
  assert.equal(room.result.joinStatus, 'approved')
  assert.equal(room.roomState.activeRoomId, 'room-a')
  room.setLocale('zh')
  room.setLocale('en')
  assert.equal(room.requests.length, 2)
  room.disconnect()
  room.reconnect()
  assert.equal(room.requests.length, 3)
  assert.equal(room.requests[2].payload.password, 'correct-password')
  assert.equal(room.requests[2].payload.nickname, 'A guest')
  assert.doesNotMatch(
    JSON.stringify(room.storage),
    /wrong-password|correct-password/
  )
  assert.doesNotMatch(JSON.stringify(room.grants), /password/)
  room.unmount()
})

test('late failures and ownership acknowledgements cannot override a newer manual join', () => {
  const room = createHarness()
  room.result.requestJoin('room-a', 'first-password')
  room.result.requestJoin('room-a', 'latest-password')
  room.render()
  room.acknowledge(1, joined('latest-grant'))
  room.acknowledge(0, { success: false, message: '密码错误' })
  room.acknowledge(0, {
    success: true,
    data: { isHost: true, mediaGrant: 'stale-grant' },
  })
  assert.equal(room.result.joinStatus, 'approved')
  assert.deepEqual(room.grants, [{ roomId: 'room-a', grant: 'latest-grant' }])
  assert.deepEqual(room.storage, [])
  room.disconnect()
  room.reconnect()
  assert.equal(room.requests.at(-1).payload.password, 'latest-password')
  room.unmount()
})

test('a rapid disconnect and reconnect in one render still joins once with the remembered password', () => {
  const room = createHarness()
  room.result.requestJoin('room-a', 'remembered-password')
  room.render()
  room.acknowledge(0, joined())
  room.recoverBeforeRender()
  assert.equal(room.requests.length, 2)
  assert.equal(room.requests[1].payload.password, 'remembered-password')
  room.acknowledge(1, joined('reconnected-grant'))
  assert.equal(room.result.joinStatus, 'approved')
  room.unmount()
})

test('changing rooms fences old acknowledgements and room events and never sends the previous password', () => {
  const room = createHarness()
  room.result.requestJoin('room-a', 'private-a-password')
  room.render({ roomId: 'room-b', autoJoin: true })
  assert.equal(room.requests.length, 2)
  assert.deepEqual(room.requests[1].payload, {
    roomId: 'room-b',
    password: '',
    nickname: 'Room guest',
  })
  room.acknowledge(0, joined('old-room-grant'))
  room.fire('join-approved', {
    roomId: 'room-a',
    mode: 'watch-together',
    mediaGrant: 'old-event-grant',
  })
  room.fire('join-rejected', { roomId: 'room-a' })
  assert.equal(room.result.joinStatus, 'joining')
  assert.deepEqual(room.grants, [])
  assert.equal(room.roomState.activeRoomId, null)
  room.acknowledge(1, joined('room-b-grant'))
  room.disconnect()
  room.reconnect()
  assert.equal(room.requests.at(-1).payload.password, '')
  assert.equal(room.requests.at(-1).payload.roomId, 'room-b')
  room.unmount()
})

test('definitive password failures stop automatic attempts until a corrected manual submission', () => {
  const room = createHarness({ autoJoin: true })
  room.acknowledge(0, { success: false, message: '密码错误' })
  assert.equal(room.result.joinStatus, 'password-required')
  room.setLocale('zh')
  room.disconnect()
  room.reconnect()
  assert.equal(room.requests.length, 1)
  room.result.requestJoin('room-a', 'corrected')
  room.render()
  assert.equal(room.requests.length, 2)
  room.acknowledge(1, joined())
  assert.equal(room.result.joinStatus, 'approved')
  room.unmount()
})

test('same-room approval events still admit a waiting member and retain the password for recovery', () => {
  const room = createHarness()
  room.result.requestJoin('room-a', 'approval-password')
  room.render()
  room.acknowledge(0, {
    success: true,
    message: '等待房主确认',
    data: { mode: 'watch-together' },
  })
  assert.equal(room.result.joinStatus, 'waiting')
  room.fire('join-approved', {
    roomId: 'room-a',
    mode: 'watch-together',
    mediaGrant: 'approved-grant',
  })
  assert.equal(room.result.joinStatus, 'approved')
  assert.equal(room.roomState.activeRoomId, 'room-a')
  assert.deepEqual(room.approved, ['watch-together'])
  room.disconnect()
  room.reconnect()
  assert.equal(room.requests[1].payload.password, 'approval-password')
  room.unmount()
})

test('existing account-session recovery remains bounded and reuses the same room password', () => {
  const room = createHarness()
  room.result.requestJoin('room-a', 'retry-password')
  room.render()
  for (let index = 0; index < 4; index++) {
    assert.equal(room.requests[index].payload.password, 'retry-password')
    room.acknowledge(index, { success: false, code: 'ALREADY_IN_ROOM' })
    if (index < 3) {
      assert.equal(room.timers.size, 1)
      room.advanceTimers()
    }
  }
  assert.equal(room.result.joinStatus, 'rejected')
  assert.equal(room.timers.size, 0)
  room.advanceTimers()
  assert.equal(room.requests.length, 4)
  room.unmount()
})

test('reset, explicit teardown and unmount clear pending retry intentions and reject late responses', () => {
  const room = createHarness({ autoJoin: true })
  room.result.requestJoin('room-a', 'reset-password')
  room.render()
  room.acknowledge(1, { success: false, code: 'ALREADY_IN_ROOM' })
  assert.equal(room.timers.size, 1)
  room.result.resetJoinState()
  room.render()
  room.advanceTimers()
  room.disconnect()
  room.reconnect()
  assert.equal(room.requests.length, 2)
  room.acknowledge(1, joined('ignored-after-reset'))
  assert.equal(room.result.joinStatus, 'idle')
  assert.deepEqual(room.grants, [])
  room.result.requestJoin('room-a', 'leave-password')
  room.render()
  room.teardown(false)
  room.disconnect()
  room.reconnect()
  assert.equal(room.requests.at(-1).payload.password, 'leave-password')
  room.teardown(true)
  room.acknowledge(3, joined('ignored-after-leave'))
  room.disconnect()
  room.reconnect()
  assert.equal(room.requests.length, 4)
  assert.equal(room.result.joinStatus, 'idle')
  room.result.requestJoin('room-a', 'unmount-password')
  room.render()
  room.unmount()
  room.acknowledge(4, joined('ignored-after-unmount'))
  assert.deepEqual(room.grants, [])
  assert.doesNotMatch(JSON.stringify(room.storage), /password/)
})
