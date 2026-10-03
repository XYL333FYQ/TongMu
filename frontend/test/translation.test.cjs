const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
function load(name) {
  const source = fs.readFileSync(
    path.join(__dirname, '../src/i18n', name),
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
const { translateMessage, normalizeLocale } = load('translation.ts')
const dictionary = {
  ...load('core.zh.ts').coreZh,
  ...load('modules.zh.ts').modulesZh,
  ...load('pages.zh.ts').pagesZh,
  ...load('components.zh.ts').componentsZh,
}
test('translation catalogs preserve every interpolation parameter', () => {
  const parameters = (text) =>
    [...text.matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)]
      .map((match) => match[1])
      .sort()
  for (const [english, chinese] of Object.entries(dictionary)) {
    assert.deepEqual(parameters(chinese), parameters(english), english)
    assert.ok(chinese.trim(), english)
  }
})
test('stored translated errors can change language without changing user parameters', () => {
  const catalog = {
    'Could not join {room}. Try again.': '无法加入 {room}，请重试。',
  }
  const room = '我的房间 $& {hello} <script>'
  const chinese = translateMessage(
    'zh',
    'Could not join {room}. Try again.',
    catalog,
    { room }
  )
  assert.equal(chinese, `无法加入 ${room}，请重试。`)
  assert.equal(
    translateMessage('zh', `Could not join ${room}. Try again.`, catalog),
    chinese
  )
  assert.equal(
    translateMessage('en', chinese, catalog),
    `Could not join ${room}. Try again.`
  )
  assert.equal(translateMessage('zh', chinese, catalog), chinese)
  assert.equal(
    translateMessage('en', '用户自己写的内容', catalog),
    '用户自己写的内容'
  )
})
test('language fallback and shared control terminology are predictable', () => {
  assert.equal(normalizeLocale(null), 'zh')
  assert.equal(normalizeLocale('en'), 'en')
  assert.equal(normalizeLocale('unknown'), 'zh')
  assert.equal(translateMessage('zh', 'Hall', dictionary), '大厅')
  assert.equal(translateMessage('en', 'Hall', dictionary), 'Hall')
  assert.equal(translateMessage('zh', 'TongMu', dictionary), 'TongMu')
})
