const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
let locale = 'en'

function load(relativePath) {
  const source = fs.readFileSync(
    path.join(__dirname, '../src', relativePath),
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
      if (name === '@/i18n')
        return {
          t: (source, params) =>
            translateMessage(locale, source, dictionary, params),
          canonicalProductMessage: (source) =>
            translateMessage('en', source, dictionary),
          getLocale: () => locale,
        }
      if (name === '@/i18n/core.zh') return { coreZh }
      if (name === '@/lib/errorMessage') return { englishErrorMessage }
      if (name === '@/modules/player/services/media-redaction')
        return load('modules/player/services/media-redaction.ts')
      if (name === 'clsx' || name === 'tailwind-merge') return require(name)
      throw new Error(`Unexpected import: ${name}`)
    },
    loaded,
    loaded.exports
  )
  return loaded.exports
}
const { translateMessage } = load('i18n/translation.ts')
const { coreZh } = load('i18n/core.zh.ts')
const { modulesZh } = load('i18n/modules.zh.ts')
const dictionary = { ...coreZh, ...modulesZh }
const { englishErrorMessage } = load('lib/errorMessage.ts')

test('known legacy failures explain recovery in English and unknown private diagnostics remain bounded', () => {
  assert.match(englishErrorMessage('密码错误'), /Incorrect password/)
  assert.match(
    englishErrorMessage('当前房间授权已失效'),
    /Return to the room to reconnect/
  )
  const original = new Error(
    '解析 https://user:password@private.example/file?token=secret 失败'
  )
  assert.equal(
    englishErrorMessage(original, 'Unable to open this source. Try again.'),
    'Unable to open this source. Try again.'
  )
  assert.match(original.message, /password/)
})

test('English failure diagnostics retain useful reasons without revealing credentials or media capabilities', () => {
  const result = englishErrorMessage(
    'Source refused access at https://user:password@media.example/clip?token=secret authorization=Bearer abc roomGrant=grant /api/stream/media/private-capability'
  )
  assert.match(result, /Source refused access/)
  assert.match(result, /media\.example\/clip/)
  assert.doesNotMatch(
    result,
    /password|secret|\babc\b|private-capability|roomGrant=grant/
  )
  assert.equal(
    englishErrorMessage(undefined, 'Reconnect and try again.'),
    'Reconnect and try again.'
  )
})

test('server failures and room codes follow the current language while unknown private errors stay bounded', () => {
  const { roomErrorMessage } = load('modules/room/roomErrors.ts')
  locale = 'zh'
  try {
    assert.equal(englishErrorMessage('密码错误'), '密码错误，请检查后重试。')
    assert.equal(
      roomErrorMessage(undefined, 'NICKNAME_REQUIRED'),
      '加入前请填写昵称。'
    )
    assert.equal(
      roomErrorMessage('影片不存在'),
      '此内容已不可用，请刷新待播列表。'
    )
    assert.equal(
      englishErrorMessage('Failed to fetch'),
      '连接失败，请检查网络后重试。'
    )
    const original = new Error(
      '解析 https://user:password@private.example/file?token=secret 失败'
    )
    assert.equal(
      englishErrorMessage(original),
      coreZh['Unable to complete this action. Please try again.']
    )
    assert.doesNotMatch(
      roomErrorMessage(original.message),
      /password|private\.example|secret/
    )
    locale = 'en'
    assert.match(
      englishErrorMessage('密码错误，请检查后重试。'),
      /Incorrect password/
    )
    assert.equal(
      roomErrorMessage(undefined, 'NICKNAME_REQUIRED'),
      'Choose a nickname before joining.'
    )
    assert.equal(
      original.message.includes('password'),
      true,
      'UI localization must not modify the original error'
    )
  } finally {
    locale = 'en'
  }
})

test('time and media format helpers localize parameters without changing format identifiers', () => {
  const { formatRecentTime } = load('lib/formatTime.ts')
  const { getUnsupportedFormatMessage, detectMediaFormat } =
    load('lib/mediaFormat.ts')
  const created = new Date(Date.now() - 5 * 60_000).toISOString()
  locale = 'zh'
  try {
    assert.equal(formatRecentTime(created), '5分钟前')
    assert.match(getUnsupportedFormatMessage('avi'), /无法原生播放 AVI/)
    assert.equal(detectMediaFormat('movie.avi'), 'avi')
    locale = 'en'
    assert.equal(formatRecentTime(created), '5m ago')
    assert.match(getUnsupportedFormatMessage('avi'), /cannot play AVI natively/)
  } finally {
    locale = 'en'
  }
})

test('older room dates follow the selected language while comment times retain a 24-hour clock', () => {
  const { formatRecentTime } = load('lib/formatTime.ts')
  const { formatIsoTime } = load('lib/utils.ts')
  const created = '2020-02-03T20:14:15.000Z'
  const date = new Date(created)
  try {
    for (const [selected, expected] of [
      ['zh', 'zh-CN'],
      ['en', 'en-US'],
    ]) {
      locale = selected
      assert.equal(formatRecentTime(created), date.toLocaleString(expected))
      assert.equal(
        formatIsoTime(created),
        date.toLocaleTimeString(expected, {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
        })
      )
      assert.match(formatIsoTime(created), /^\d{2}:\d{2}:\d{2}$/)
    }
  } finally {
    locale = 'en'
  }
})

test('core recovery copy retains every dynamic parameter in both languages', () => {
  const placeholders = (copy) =>
    [...copy.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)]
      .map((match) => match[1])
      .sort()
  for (const [source, translated] of Object.entries(coreZh)) {
    assert.ok(translated.trim(), `Missing Chinese copy for ${source}`)
    assert.deepEqual(
      placeholders(translated),
      placeholders(source),
      `Translation must retain parameters for ${source}`
    )
  }
  const parameters = { status: 503 }
  assert.equal(
    translateMessage(
      'zh',
      'Local CLI connection failed (HTTP {status}).',
      coreZh,
      parameters
    ),
    '本地 CLI 连接失败（HTTP 503）。'
  )
  assert.equal(
    translateMessage('en', '本地 CLI 连接失败（HTTP 503）。', coreZh),
    'Local CLI connection failed (HTTP 503).'
  )
  assert.deepEqual(parameters, { status: 503 })
})

test('already localized module failures retain their recovery reason when the language changes', () => {
  const canonical = 'Unable to load Jellyfin sources.'
  const translated = modulesZh[canonical]
  assert.ok(translated)
  try {
    locale = 'zh'
    assert.equal(englishErrorMessage(canonical), translated)
    locale = 'en'
    assert.equal(englishErrorMessage(translated), canonical)
    assert.equal(
      englishErrorMessage('未知错误：token=secret'),
      'Unable to complete this action. Please try again.'
    )
  } finally {
    locale = 'en'
  }
})

test('recognized translated error templates still redact credentials before returning the chosen language', () => {
  const source = translateMessage(
    'zh',
    'Unable to load this media at the selected quality: {value1}',
    dictionary,
    {
      value1:
        'Source refused https://user:password@media.example/clip?token=secret authorization=Bearer abc roomGrant=grant',
    }
  )
  try {
    locale = 'en'
    const english = englishErrorMessage(source)
    assert.match(english, /Unable to load this media at the selected quality/)
    assert.match(english, /Source refused/)
    assert.doesNotMatch(english, /password|secret|\babc\b|roomGrant=grant/)
    locale = 'zh'
    const chinese = englishErrorMessage(source)
    assert.match(chinese, /无法按所选画质加载媒体/)
    assert.doesNotMatch(chinese, /password|secret|\babc\b|roomGrant=grant/)
    assert.match(source, /password/, 'The original diagnostic is retained')
  } finally {
    locale = 'en'
  }
})
