const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function load(relativePath, imports = {}) {
  const source = fs.readFileSync(
    path.join(__dirname, '..', relativePath),
    'utf8'
  )
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const loaded = { exports: {} }
  new Function('require', 'module', 'exports', output)(
    (name) => {
      if (Object.hasOwn(imports, name)) return imports[name]
      throw new Error(`Unexpected music test import: ${name}`)
    },
    loaded,
    loaded.exports
  )
  return loaded.exports
}

const versions = load('src/modules/music/realtime-version.ts')
const translation = load('src/i18n/translation.ts')
const modulesZh = load('src/i18n/modules.zh.ts').modulesZh
let locale = 'en'
const i18n = {
  t: (source, params) =>
    translation.translateMessage(locale, source, modulesZh, params),
}
const domain = load('src/modules/music/domain.ts', { '@/i18n': i18n })
const lifecycle = load('src/modules/music/audio-lifecycle.ts')
const { useMusicStore } = load('src/modules/music/store.ts', {
  zustand: require('zustand'),
  './realtime-version': versions,
})
const { updateArtLocale } = load('src/modules/art-player/artLocale.ts')

test('module translation switches music controls and keeps user template values intact', () => {
  assert.equal(domain.modeLabel('repeat-one'), 'Repeat one')
  locale = 'zh'
  try {
    assert.equal(domain.modeLabel('repeat-one'), '单曲循环')
    assert.equal(domain.modeLabel('shuffle'), '随机播放')
    assert.equal(
      i18n.t('Room {id}', { id: 'My English Room' }),
      '房间My English Room'
    )
    assert.equal(
      i18n.t('Add {value1} to queue', { value1: 'Play' }),
      '将Play加入待播列表'
    )
  } finally {
    locale = 'en'
  }
  assert.equal(domain.modeLabel('repeat-one'), 'Repeat one')
})

test('native player language switches existing labels without touching playback', () => {
  const attributes = new Map([
    ['data-title', '播放'],
    ['aria-label', 'My English Room'],
  ])
  const element = {
    getAttribute: (key) => attributes.get(key) ?? null,
    setAttribute: (key, value) => attributes.set(key, value),
  }
  const art = {
    option: { lang: 'zh-cn' },
    i18n: {
      languages: { 'zh-cn': { Play: '播放' } },
      init() {},
      get(key) {
        return art.option.lang === 'zh-cn'
          ? (this.languages['zh-cn'][key] ?? key)
          : key
      },
    },
    template: {
      $bottom: { querySelectorAll: () => [element] },
      $state: { querySelectorAll: () => [] },
      $player: {
        querySelectorAll() {
          throw new Error('React/user content must not be scanned')
        },
      },
    },
    video: {
      src: 'https://media.example/original-4k.mp4',
      currentTime: 42,
      paused: false,
    },
  }
  updateArtLocale(art, 'en')
  assert.equal(attributes.get('data-title'), 'Play')
  assert.equal(attributes.get('aria-label'), 'My English Room')
  updateArtLocale(art, 'zh')
  assert.equal(attributes.get('data-title'), '播放')
  assert.deepEqual(art.video, {
    src: 'https://media.example/original-4k.mp4',
    currentTime: 42,
    paused: false,
  })
})

test('music authority comparison rejects old generation/version but accepts a fresh snapshot', () => {
  const current = { musicGeneration: 3, version: 12 }
  assert.equal(
    versions.shouldApplyMusicEvent(current, {
      musicGeneration: 3,
      version: 12,
    }),
    false
  )
  assert.equal(
    versions.shouldApplyMusicEvent(current, {
      musicGeneration: 3,
      version: 11,
    }),
    false
  )
  assert.equal(
    versions.shouldApplyMusicEvent(current, {
      musicGeneration: 2,
      version: 99,
    }),
    false
  )
  assert.equal(
    versions.shouldApplyMusicEvent(current, { musicGeneration: 4, version: 1 }),
    true
  )
  assert.equal(
    versions.shouldApplyMusicHeartbeat(current, {
      musicGeneration: 3,
      version: 12,
    }),
    true
  )
  assert.equal(
    versions.shouldApplyMusicHeartbeat(current, {
      musicGeneration: 3,
      version: 11,
    }),
    false
  )
})

test('music timing compensates bounded network delay and avoids seeking every small heartbeat', () => {
  const expected = domain.expectedMusicPosition(10, true, 1, 1000, 3000, 100)
  assert.equal(expected, 11.9)
  assert.equal(domain.shouldCorrectMusicDrift(11, expected), false)
  assert.equal(domain.shouldCorrectMusicDrift(8, expected), true)
})

class FakeAudio {
  constructor() {
    this.src = ''
    this.currentTime = 0
    this.playbackRate = 1
    this.paused = true
    this.duration = 4
    this.listeners = new Map()
    this.loadCount = 0
  }
  addEventListener(type, listener) {
    const list = this.listeners.get(type) || []
    list.push(listener)
    this.listeners.set(type, list)
  }
  removeEventListener(type, listener) {
    this.listeners.set(
      type,
      (this.listeners.get(type) || []).filter((entry) => entry !== listener)
    )
  }
  removeAttribute(name) {
    if (name === 'src') this.src = ''
  }
  pause() {
    this.paused = true
  }
  play() {
    this.paused = false
    return Promise.resolve()
  }
  load() {
    this.loadCount += 1
  }
  fire(type) {
    for (const listener of this.listeners.get(type) || [])
      listener(new Event(type))
  }
}

test('playback errors distinguish browser permission, interrupted playback and unavailable media', () => {
  assert.equal(lifecycle.classifyMusicPlaybackError({ name: 'NotAllowedError' }), 'blocked')
  assert.equal(lifecycle.classifyMusicPlaybackError({ name: 'AbortError' }), 'aborted')
  assert.equal(lifecycle.classifyMusicPlaybackError({ name: 'NotSupportedError' }), 'unavailable')
  assert.equal(lifecycle.classifyMusicPlaybackError(new Error('upstream failed')), 'unavailable')
})

test('room heartbeats and unchanged control snapshots preserve a track load error', () => {
  useMusicStore.getState().reset('fixture-room')
  const snapshot = {
    roomId: 'fixture-room', session: { sessionId: 'fixture-session' },
    queue: [], currentItem: null, currentQueueItemId: 1, currentIndex: 0,
    currentSourceRef: 'music://ncm/track/101', isPlaying: false,
    positionSec: 0, playbackRate: 1, playMode: 'sequential',
    musicGeneration: 1, version: 1, serverTimestamp: 100,
    host: { socketId: 'host', userId: 1, online: true }, hostOffline: false,
  }
  useMusicStore.getState().applySnapshot(snapshot, true)
  useMusicStore.getState().setError('Track request failed')
  useMusicStore.getState().applyHeartbeat({ ...snapshot, serverTimestamp: 200 })
  assert.equal(useMusicStore.getState().error, 'Track request failed')
  useMusicStore.getState().applySnapshot({ ...snapshot, version: 2 })
  assert.equal(useMusicStore.getState().error, 'Track request failed')
  useMusicStore.getState().applySnapshot({ ...snapshot, version: 3, musicGeneration: 2, currentSourceRef: 'music://ncm/track/102' })
  assert.equal(useMusicStore.getState().error, null)
})

test('audio lifecycle unloads sources idempotently and ignores stale callbacks', () => {
  const audio = new FakeAudio()
  const controller = new lifecycle.MusicAudioLifecycle(audio)
  let oldReady = 0
  let currentReady = 0
  controller.attach('/old.wav', 1, {
    onReady: () => {
      oldReady += 1
    },
  })
  const oldListener = [...(audio.listeners.get('loadedmetadata') || [])]
  controller.attach('/new.wav', 2, {
    onReady: () => {
      currentReady += 1
    },
  })
  for (const listener of oldListener) listener(new Event('loadedmetadata'))
  audio.fire('loadedmetadata')
  assert.equal(oldReady, 0)
  assert.equal(currentReady, 1)
  controller.unload()
  controller.unload()
  assert.equal(audio.src, '')
  assert.equal(controller.generation, null)
  assert.equal(audio.loadCount >= 4, true)
})
