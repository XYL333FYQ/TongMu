const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function load(relativePath) {
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
  new Function('module', 'exports', output)(loaded, loaded.exports)
  return loaded.exports
}

const versions = load('src/modules/music/realtime-version.ts')
const domain = load('src/modules/music/domain.ts')
const lifecycle = load('src/modules/music/audio-lifecycle.ts')

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
