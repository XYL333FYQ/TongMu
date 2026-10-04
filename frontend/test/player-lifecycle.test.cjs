const test = require('node:test')
const assert = require('node:assert/strict')
const ts = require('typescript')
const fs = require('node:fs')
const path = require('node:path')

function load(file, imports = {}, directory) {
  const source = fs.readFileSync(path.join(directory, file), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', output)(
    (name) => imports[name] ?? {},
    module,
    module.exports
  )
  return module.exports
}

const src = path.join(__dirname, '../src')
test('standard DASH seeking leaves native scheduling intact while dual tracks use their controller', async () => {
  const strategy = load(
    'modules/sync-playback/services/seek-strategy.ts',
    {
      '../constants': { SEEK_FOLLOW_THRESHOLD: 3 },
    },
    src
  )
  const service = load(
    'modules/sync-playback/services/seek-service.ts',
    {
      './seek-strategy': strategy,
      '@/store/roomStore': {
        useRoomStore: { getState: () => ({ setReloadingState() {} }) },
      },
      '@/modules/player/services/media-redaction': {
        redactMediaError: (value) => value,
      },
    },
    src
  )
  let writes = 0
  let managedSeeks = 0
  const video = {
    buffered: { length: 0 },
    dispatchEvent() {},
    get currentTime() {
      return 120
    },
    set currentTime(_value) {
      writes += 1
    },
  }
  const params = {
    video,
    targetTime: 120,
    state: { sourceUrl: '/movie.mpd', format: 'dash' },
    seekTo: async () => {
      managedSeeks += 1
      return { success: true }
    },
    suppressEventsRef: { current: false },
    isReloadingRef: { current: false },
  }
  assert.equal(await service.executeSeek(params), false)
  assert.equal(
    writes,
    0,
    'the seeking event must not reassign currentTime and cancel the fragment'
  )
  assert.equal(managedSeeks, 0)
  assert.equal(
    await service.executeSeek({
      ...params,
      state: { ...params.state, audioUrl: '/audio.m4s' },
    }),
    true
  )
  assert.equal(managedSeeks, 1)
})
const lifecycle = load('modules/player/lifecycle.ts', {}, src)
const subtitles = load('lib/subtitleParser.ts', {}, src)
const mkv = load(
  'modules/subtitles/mkv-embedded.ts',
  {
    '@/lib/mkv/matroska-demuxer': {
      MatroskaDemuxer: class {},
    },
    '@/lib/mkv/ebml': { TRACK_TYPE: { SUBTITLE: 17, AUDIO: 2 } },
  },
  src
)

test('source generations abort stale work and keep resource release idempotent', () => {
  lifecycle.resetPlayerResourceInstrumentation()
  const first = lifecycle.createPlayerGeneration(1, 10)
  const second = lifecycle.createPlayerGeneration(2, 11)
  assert.equal(lifecycle.isCurrentPlayerGeneration(first, first), true)
  lifecycle.disposePlayerGeneration(first)
  assert.equal(first.abortController.signal.aborted, true)
  assert.equal(lifecycle.isCurrentPlayerGeneration(first, first), false)
  assert.equal(lifecycle.isCurrentPlayerGeneration(second, second), true)
  second.releaseFetchController()
  second.releaseFetchController()
  assert.deepEqual(lifecycle.getPlayerResourceSnapshot(), {
    activeEngines: 0,
    activeWorkers: 0,
    activeObjectUrls: 0,
    activeMediaSources: 0,
    registeredListeners: 0,
    activePlayerFetchControllers: 0,
    activeTimers: 0,
  })
})

test('twenty source replacements return lifecycle resources to baseline', () => {
  lifecycle.resetPlayerResourceInstrumentation()
  for (let index = 0; index < 20; index++) {
    const generation = lifecycle.createPlayerGeneration(index + 1, index + 100)
    const releaseEngine = lifecycle.trackPlayerResource('engines')
    const releaseListener = lifecycle.trackPlayerResource('listeners')
    const releaseTimer = lifecycle.trackPlayerResource('timers')
    releaseEngine()
    releaseListener()
    releaseTimer()
    lifecycle.disposePlayerGeneration(generation)
  }
  assert.deepEqual(lifecycle.getPlayerResourceSnapshot(), {
    activeEngines: 0,
    activeWorkers: 0,
    activeObjectUrls: 0,
    activeMediaSources: 0,
    registeredListeners: 0,
    activePlayerFetchControllers: 0,
    activeTimers: 0,
  })
})

test('subtitle parser preserves same-start different-text cues and escapes markup', () => {
  const content =
    '\uFEFF1\r\n00:00:01,000 --> 00:00:03,000\r\n<a onclick="bad()">one</a>\r\n\r\n2\n00:00:01,000 --> 00:00:04,000\ntwo'
  const cues = subtitles.parseSubtitle(content, 'srt')
  assert.equal(cues.length, 2)
  assert.notEqual(cues[0].text, cues[1].text)
  assert.match(cues[0].text, /&lt;a onclick=&quot;bad\(\)&quot;&gt;/)
  assert.equal(subtitles.dedupeSubtitleCues(cues, 'track-a').length, 2)
  assert.equal(
    subtitles.dedupeSubtitleCues([...cues, cues[0]], 'track-a').length,
    2
  )
})

test('subtitle format matrix handles BOM VTT, ASS, SMI, and MicroDVD', () => {
  assert.equal(
    subtitles.parseSubtitle(
      '\uFEFFWEBVTT\n\n00:01.000 --> 00:02.000\nhello',
      'vtt'
    )[0].start,
    1
  )
  assert.equal(
    subtitles.parseSubtitle(
      '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,,0,0,0,,<unsafe>',
      'ass'
    ).length,
    1
  )
  assert.equal(
    subtitles.parseSubtitle(
      '<SAMI><SYNC Start=1000>hello</SYNC><SYNC Start=2000>world</SYNC>',
      'smi'
    ).length,
    2
  )
  assert.equal(
    subtitles.parseSubtitle('{24}{48}<unsafe>|line', 'sub')[0].text,
    '&lt;unsafe&gt;\nline'
  )
})

test('MKV extraction refuses a probe beyond its byte budget', async () => {
  const previousFetch = global.fetch
  let requests = 0
  global.fetch = async () => {
    requests += 1
    throw new Error('fetch should not start')
  }
  try {
    await assert.rejects(
      mkv.extractMkvSubtitleTracks('https://media.invalid/movie.mkv', [3], {
        maxBytesProbed: 1024,
        maxRanges: 1,
      }),
      /字节上限/
    )
    assert.equal(requests, 0)
  } finally {
    global.fetch = previousFetch
  }
})

test('standard DASH starts loading at the room position and disposes its listeners', async () => {
  const initialized = []
  let resets = 0
  const listeners = new Set()
  const player = {
    updateSettings() {},
    on(event, listener) {
      listeners.add(listener)
    },
    off(event, listener) {
      listeners.delete(listener)
    },
    initialize(...args) {
      initialized.push(args)
    },
    reset() {
      resets += 1
    },
  }
  const { dashEngine } = load(
    'modules/player/engines/dash-engine.ts',
    {
      dashjs: {
        default: {
          MediaPlayer: Object.assign(() => ({ create: () => player }), {
            events: { STREAM_INITIALIZED: 'initialized', ERROR: 'error' },
          }),
        },
      },
      '../utils': { resetVideoElement() {}, waitForMetadata: async () => {} },
      '../services/url-proxy': { resolveProxyUrl: (url) => url },
    },
    src
  )
  const video = {}
  const result = await dashEngine.attach(video, {
    url: '/api/stream/media/room-handle',
    format: 'dash',
    startTime: 120,
  })
  assert.deepEqual(initialized[0], [
    video,
    '/api/stream/media/room-handle',
    false,
    120,
  ])
  result.cleanup()
  result.cleanup()
  assert.equal(resets, 1)
  assert.equal(listeners.size, 0)
})
