const test = require('node:test')
const assert = require('node:assert/strict')
const ts = require('typescript')
const fs = require('node:fs')
const path = require('node:path')
const source = fs.readFileSync(
  path.join(__dirname, '../src/lib/movieSubmission.ts'),
  'utf8'
)
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const mod = { exports: {} }
new Function('require', 'module', 'exports', output)(
  (name) => {
    if (name === '@/i18n') return { t: (source) => source }
    throw new Error(`Unexpected import: ${name}`)
  },
  mod,
  mod.exports
)
const { createMovieSubmitter, MovieSubmissionError } = mod.exports

test('concurrent callers share one POST; lost response retries the same key and successful repetition gets a new key', async () => {
  let keys = 0
  let count = 0
  let release
  const seen = []
  const submit = createMovieSubmitter(
    async (body, key) => {
      count++
      seen.push(key)
      if (count === 1) {
        await new Promise((resolve) => {
          release = resolve
        })
        throw new Error('response lost')
      }
      return { id: 42, title: 'Selected video' }
    },
    () => `request-${++keys}`
  )
  const first = submit('user1:room', { url: 'a' })
  const duplicate = submit('user1:room', { url: 'a' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(count, 1)
  release()
  await Promise.all([assert.rejects(first), assert.rejects(duplicate)])
  assert.deepEqual(await submit('user1:room', { url: 'a' }), {
    id: 42,
    title: 'Selected video',
  })
  await submit('user1:room', { url: 'a' })
  assert.deepEqual(seen, ['request-1', 'request-1', 'request-2'])
})

test('changed payload and another user/room have independent request keys', async () => {
  let keys = 0
  const seen = []
  const submit = createMovieSubmitter(
    async (body, key) => {
      seen.push(key)
      throw new Error('offline')
    },
    () => `request-${++keys}`
  )
  for (const [scope, body] of [
    ['u:r', { url: 'a' }],
    ['u:r', { url: 'b' }],
    ['v:r', { url: 'a' }],
    ['u:s', { url: 'a' }],
    ['u:r', { url: 'a' }],
  ]) {
    await assert.rejects(submit(scope, body))
  }
  assert.deepEqual(seen, [
    'request-1',
    'request-2',
    'request-3',
    'request-4',
    'request-1',
  ])
})

test('a definitive conflict permits a new explicit attempt, while uncertain server failure keeps the key', async () => {
  let keys = 0
  let attempts = 0
  const seen = []
  const submit = createMovieSubmitter(
    async (_body, key) => {
      seen.push(key)
      attempts++
      if (attempts === 1) throw new MovieSubmissionError(500, 'uncertain')
      if (attempts === 2) throw new MovieSubmissionError(409, 'deleted')
    },
    () => `request-${++keys}`
  )
  await assert.rejects(submit('u:r', {}))
  await assert.rejects(submit('u:r', {}))
  await submit('u:r', {})
  assert.deepEqual(seen, ['request-1', 'request-1', 'request-2'])
})
