const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const source = fs.readFileSync(
  path.join(__dirname, '../src/modules/admin/adminPermissions.ts'),
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
const { canCloseAdminRoom } = loaded.exports

test('room close affordance matches the backend owner rule', () => {
  assert.equal(canCloseAdminRoom('root', '1', 9), true)
  assert.equal(canCloseAdminRoom('admin', '9', 9), true)
  assert.equal(canCloseAdminRoom('admin', '8', 9), false)
  assert.equal(canCloseAdminRoom('admin', '9', null), false)
  assert.equal(canCloseAdminRoom('user', '9', 9), false)
  assert.equal(canCloseAdminRoom('guest', '9', 9), false)
})
