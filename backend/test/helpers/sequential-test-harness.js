const assert = require('node:assert/strict');

function createSequentialTestHarness() {
  const tests = [];
  let passed = 0;
  let failed = 0;

  async function runTest(name, body, indent = '') {
    const afterCallbacks = [];
    const context = {
      after(callback) {
        afterCallbacks.push(callback);
      },
      async test(childName, childBody) {
        return runTest(childName, childBody, `${indent}  `);
      },
    };
    let error;
    const started = Date.now();
    try {
      await body(context);
    } catch (currentError) {
      error = currentError;
    } finally {
      for (const callback of afterCallbacks.reverse()) {
        try {
          await callback();
        } catch (cleanupError) {
          error ||= cleanupError;
        }
      }
    }
    if (error) {
      failed += 1;
      console.error(`${indent}✖ ${name} (${Date.now() - started}ms)`);
      console.error(error?.stack || error);
      return false;
    }
    passed += 1;
    console.log(`${indent}✔ ${name} (${Date.now() - started}ms)`);
    return true;
  }

  function test(name, body) {
    assert.equal(typeof body, 'function');
    tests.push({ name, body });
  }

  setImmediate(async () => {
    for (const current of tests) await runTest(current.name, current.body);
    console.log(`Phase 6A migration suite: ${passed} PASS / ${failed} FAIL`);
    if (failed > 0) process.exitCode = 1;
  });

  return test;
}

module.exports = { createSequentialTestHarness };
