// Phase 6A intentionally creates many isolated TypeORM DataSources in one
// process. Reuse one initialized sql.js WASM module so Node/Windows does not
// register duplicate WASM cleanup hooks for every fixture.
const sharedSqlJs = require('sql.js')();

module.exports = { sharedSqlJs };
