const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const source = fs.readFileSync(
  path.join(__dirname, '../src/modules/sync-playback/realtime-version.ts'),
  'utf8',
);
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loadedModule = { exports: {} };
new Function('module', 'exports', output)(loadedModule, loadedModule.exports);
const { shouldApplyAuthoritativeEvent, shouldApplySnapshot } = loadedModule.exports;

test('frontend ignores duplicate/reordered events and cross-generation stale events', () => {
  const current = { version: 12, sourceGeneration: 3 };
  assert.equal(shouldApplyAuthoritativeEvent(current, { version: 12, sourceGeneration: 3 }), false);
  assert.equal(shouldApplyAuthoritativeEvent(current, { version: 11, sourceGeneration: 3 }), false);
  assert.equal(shouldApplyAuthoritativeEvent(current, { version: 13, sourceGeneration: 3 }), true);
  assert.equal(shouldApplyAuthoritativeEvent(current, { version: 99, sourceGeneration: 2 }), false);
  assert.equal(shouldApplyAuthoritativeEvent(current, { version: 1, sourceGeneration: 4 }), true);
});

test('snapshot recovery accepts equal authority but rejects older authority', () => {
  const current = { version: 12, sourceGeneration: 3 };
  assert.equal(shouldApplySnapshot(current, { version: 12, sourceGeneration: 3 }), true);
  assert.equal(shouldApplySnapshot(current, { version: 11, sourceGeneration: 3 }), false);
  assert.equal(shouldApplySnapshot(current, { version: 2, sourceGeneration: 2 }), false);
  assert.equal(shouldApplySnapshot({}, { version: 1, sourceGeneration: 1 }), true);
});
