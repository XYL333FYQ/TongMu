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

const domain = load('src/modules/music/catalog-domain.ts')

function catalogTrack(overrides = {}) {
  return {
    provider: 'ncm',
    trackId: '1001',
    sourceRef: 'music://ncm/track/1001',
    title: 'Fixture',
    artist: 'Artist',
    album: 'Album',
    artworkUrl: null,
    durationMs: 1000,
    availability: 'available',
    availableQualities: ['standard', 'exhigh'],
    availableMaximum: 'exhigh',
    liked: null,
    ...overrides,
  }
}

test('catalog normalization keeps only a stable NCM track identity', () => {
  const normalized = domain.normalizeCatalogTrack(
    catalogTrack({ url: 'https://secret.example/audio' })
  )
  assert.equal(normalized.sourceRef, 'music://ncm/track/1001')
  assert.equal(Object.prototype.hasOwnProperty.call(normalized, 'url'), false)
  assert.equal(
    domain.normalizeCatalogTrack(
      catalogTrack({ sourceRef: 'https://provider.example/raw' })
    ),
    null
  )
})

test('quality preference never silently falls back to another available quality', () => {
  const track = catalogTrack()
  assert.equal(domain.isQualityAvailable(track, 'exhigh'), true)
  assert.equal(domain.isQualityAvailable(track, 'lossless'), false)
  assert.deepEqual(domain.qualityOptions(track), ['standard', 'exhigh'])
  assert.match(
    domain.formatQualityFacts('lossless', null, track.availableQualities),
    /请求：无损/
  )
})

test('catalog errors map to bounded user-facing messages', () => {
  assert.equal(
    domain.catalogErrorMessage('NCM_NOT_LOGGED_IN'),
    '请先登录网易云音乐'
  )
  assert.equal(
    domain.catalogErrorMessage('NCM_QUALITY_UNAVAILABLE'),
    '请求的音质不可用，未自动切换到其他音质'
  )
})
