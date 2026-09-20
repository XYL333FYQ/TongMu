'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const express = require('express');
const tar = require('tar');

const ROOT = path.resolve(__dirname, '..', '..');
const release = require('../dist/services/updater/release-format.js');
const archive = require('../dist/services/updater/archive.js');
const transaction = require('../dist/services/updater/transaction.js');
const updater = require('../dist/services/updater/index.js');
const updaterRoute = require('../dist/routes/updater.js');

function temporary(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `tongmu-${name}-`));
}

function keyPair() {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
  };
}

function manifest(overrides = {}) {
  const commitSha = overrides.commitSha || '1'.repeat(40);
  const version = overrides.version || '1.2.3';
  const platform = overrides.platform || 'windows';
  return {
    schemaVersion: 1,
    product: 'TongMu',
    version,
    commitSha,
    buildTimestamp: '2026-09-19T00:00:00.000Z',
    platform,
    architecture: 'x64',
    artifact: {
      filename: release.canonicalArtifactFilename(version, platform, 'x64', commitSha),
      size: 123,
      sha256: '2'.repeat(64),
    },
    signature: { algorithm: 'Ed25519', keyId: overrides.keyId || 'current-2026' },
    minimumUpdaterCompatibilityVersion: '1.0.0',
    buildEnvironment: { node: 'v24.18.0', npm: '11.16.0', lockfileSha256: '3'.repeat(64), reproducible: false },
  };
}

function signed(input, key, keyId = input.signature.keyId) {
  const bytes = release.canonicalJson(input);
  return {
    bytes,
    signature: {
      schemaVersion: 1,
      algorithm: 'Ed25519',
      keyId,
      signature: crypto.sign(null, bytes, key.privateKey).toString('base64'),
    },
  };
}

function writeProgramPackage(directory, suffix) {
  fs.mkdirSync(path.join(directory, 'frontend', 'dist', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(directory, 'package.json'), `{"value":"${suffix}"}\n`);
  fs.writeFileSync(path.join(directory, 'build-info.json'), '{}\n');
  fs.writeFileSync(path.join(directory, 'browser-runtime.json'), '{}\n');
  fs.writeFileSync(path.join(directory, 'THIRD-PARTY-NOTICES.md'), 'notices\n');
  fs.writeFileSync(path.join(directory, 'PROVENANCE-INVENTORY.md'), 'provenance\n');
  fs.writeFileSync(path.join(directory, 'frontend', 'dist', 'index.html'), suffix);
  fs.writeFileSync(path.join(directory, 'frontend', 'dist', 'voice-processor.js'), suffix);
  fs.writeFileSync(path.join(directory, 'frontend', 'dist', 'icons.svg'), suffix);
  fs.writeFileSync(path.join(directory, 'frontend', 'dist', 'assets', 'runtime.wasm'), suffix);
  fs.writeFileSync(path.join(directory, 'frontend', 'dist', 'assets', 'runtime-worker.js'), suffix);
  fs.writeFileSync(path.join(directory, 'zviewer-backend'), suffix);
  fs.writeFileSync(path.join(directory, 'start.sh'), suffix);
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else files.push({
        path: path.relative(directory, absolute).replace(/\\/g, '/'),
        size: fs.statSync(absolute).size,
        sha256: crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex'),
      });
    }
  };
  walk(directory);
  fs.writeFileSync(path.join(directory, 'artifact-inventory.json'), `${JSON.stringify({ schemaVersion: 1, algorithm: 'SHA-256', files })}\n`);
}

test('canonical manifest serialization and canonical/legacy artifact identity are stable', () => {
  const value = manifest();
  const first = release.canonicalJson(value);
  const reordered = release.canonicalJson({ ...value, schemaVersion: value.schemaVersion, product: value.product });
  assert.deepEqual(first, reordered);
  assert.equal(value.artifact.filename, `TongMu-1.2.3-windows-x64-${'1'.repeat(12)}.zip`);
  assert.equal(release.legacyArtifactFilename('windows'), 'zviewer-windows-x64.zip');
  assert.throws(() => release.assertSafeArtifactFilename('../evil.zip'), /unsafe/);
  assert.throws(() => release.parseReleaseManifest(release.canonicalJson({ ...value, product: 'ZViewer' })), /product or schema/);
  assert.throws(() => release.parseReleaseManifest(release.canonicalJson({ ...value, platform: 'darwin' })), /platform/);
  assert.throws(() => release.parseReleaseManifest(release.canonicalJson({ ...value, architecture: 'arm64' })), /architecture/);
});

test('Ed25519 verification accepts active and retired keys and rejects every fail-open case', () => {
  const current = keyPair();
  const old = keyPair();
  const value = manifest();
  const currentSigned = signed(value, current);
  const keys = [
    { keyId: 'current-2026', algorithm: 'Ed25519', publicKey: current.publicKey, status: 'active' },
    { keyId: 'old-2025', algorithm: 'Ed25519', publicKey: old.publicKey, status: 'retired' },
  ];
  assert.doesNotThrow(() => release.verifyReleaseSignature(currentSigned.bytes, value, currentSigned.signature, keys));
  const oldValue = manifest({ keyId: 'old-2025' });
  const oldSigned = signed(oldValue, old);
  assert.doesNotThrow(() => release.verifyReleaseSignature(oldSigned.bytes, oldValue, oldSigned.signature, keys));
  assert.throws(() => release.verifyReleaseSignature(currentSigned.bytes, value, currentSigned.signature, []), /unknown key/);
  assert.throws(() => release.verifyReleaseSignature(currentSigned.bytes, value, currentSigned.signature,
    [{ ...keys[0], status: 'revoked' }]), /revoked/);
  assert.throws(() => release.verifyReleaseSignature(currentSigned.bytes, value,
    { ...currentSigned.signature, signature: Buffer.alloc(64).toString('base64') }, keys), /failed/);
  assert.throws(() => release.verifyReleaseSignature(release.canonicalJson({ ...value, artifact: { ...value.artifact, sha256: '4'.repeat(64) } }), value,
    currentSigned.signature, keys), /canonical serialization/);
  assert.throws(() => release.parseReleaseSignature('{}'), /unsupported/);
  assert.throws(() => release.parseReleaseSignature(JSON.stringify({ schemaVersion: 1, algorithm: 'RSA', keyId: 'x', signature: 'x' })), /unsupported/);
});

test('trusted key configuration is bounded, unique, and never silently optional', () => {
  const saved = process.env.TONGMU_UPDATE_TRUSTED_KEYS;
  try {
    delete process.env.TONGMU_UPDATE_TRUSTED_KEYS;
    assert.throws(() => release.loadTrustedUpdateKeys(), /no trusted/);
    const pair = keyPair();
    process.env.TONGMU_UPDATE_TRUSTED_KEYS = JSON.stringify([
      { keyId: 'one', algorithm: 'Ed25519', publicKey: pair.publicKey, status: 'active' },
      { keyId: 'one', algorithm: 'Ed25519', publicKey: pair.publicKey, status: 'retired' },
    ]);
    assert.throws(() => release.loadTrustedUpdateKeys(), /unique/);
  } finally {
    if (saved === undefined) delete process.env.TONGMU_UPDATE_TRUSTED_KEYS;
    else process.env.TONGMU_UPDATE_TRUSTED_KEYS = saved;
  }
});

test('archive path policy rejects traversal, absolute, UNC, drive, reserved, forbidden, links, and collisions', () => {
  const policy = archive.archivePolicyForTests;
  for (const unsafe of ['../evil', '/absolute', '//server/share', 'C:/evil', 'frontend\\evil', 'frontend/../evil', 'frontend/CON', 'config/dev.sqlite', 'frontend/a:stream']) {
    assert.throws(() => policy.validateArchivePath(unsafe, false), /unsafe|forbidden/);
  }
  assert.throws(() => policy.assertRegularArchiveType('SymbolicLink', 'frontend/link'), /links/);
  assert.throws(() => policy.assertRegularArchiveType('Link', 'frontend/hardlink'), /links/);
  assert.throws(() => policy.validateEntrySet([
    { archivePath: 'frontend/A.js', normalized: 'frontend/A.js', directory: false, size: 1 },
    { archivePath: 'frontend/a.js', normalized: 'frontend/a.js', directory: false, size: 1 },
  ]), /colliding/);
});

test('archive inspection extracts a valid package and removes a corrupted extraction', async () => {
  const root = temporary('archive');
  try {
    const source = path.join(root, 'source');
    const output = path.join(root, 'package.tar.gz');
    const extracted = path.join(root, 'extracted');
    writeProgramPackage(source, 'new');
    await tar.c({ gzip: true, file: output, cwd: source }, fs.readdirSync(source).sort());
    await archive.inspectAndExtractArchive(output, extracted, 'linux');
    assert.equal(fs.readFileSync(path.join(extracted, 'frontend', 'dist', 'index.html'), 'utf8'), 'new');
    assert.equal(fs.existsSync(path.join(extracted, 'PROVENANCE-INVENTORY.md')), true);
    assert.equal(fs.existsSync(path.join(extracted, 'THIRD-PARTY-NOTICES.md')), true);
    const inventory = JSON.parse(fs.readFileSync(path.join(extracted, 'artifact-inventory.json'), 'utf8'));
    assert.equal(inventory.files.some((item) => item.path === 'PROVENANCE-INVENTORY.md'), true);
    const unlisted = path.join(root, 'unlisted.tar.gz');
    fs.writeFileSync(path.join(source, 'LICENSE'), 'added after inventory');
    await tar.c({ gzip: true, file: unlisted, cwd: source }, fs.readdirSync(source).sort());
    await assert.rejects(() => archive.inspectAndExtractArchive(unlisted, path.join(root, 'unlisted-out'), 'linux'), /inventory/);
    const corrupt = path.join(root, 'corrupt.tar.gz');
    fs.writeFileSync(corrupt, 'not an archive');
    await assert.rejects(() => archive.inspectAndExtractArchive(corrupt, path.join(root, 'corrupt-out'), 'linux'));
    assert.equal(fs.existsSync(path.join(root, 'corrupt-out')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('staged swap preserves config, verifies rollback, and only cleans previous after health', () => {
  const root = temporary('transaction');
  try {
    const install = path.join(root, 'install');
    const config = path.join(install, 'config');
    fs.mkdirSync(config, { recursive: true });
    fs.writeFileSync(path.join(config, 'dev.sqlite'), 'user-data');
    fs.writeFileSync(path.join(install, 'package.json'), 'old');
    fs.writeFileSync(path.join(install, 'removed-in-new.txt'), 'old-only');
    const value = manifest({ platform: 'linux' });
    const marker = transaction.createUpdateMarker(config, value, { version: '1.0.0', commitSha: '0'.repeat(40) });
    assert.doesNotMatch(JSON.stringify(marker), /token|cookie|credential|privateKey|signing/i);
    fs.mkdirSync(marker.packageDirectory, { recursive: true });
    fs.writeFileSync(path.join(marker.packageDirectory, 'package.json'), 'new');
    fs.writeFileSync(path.join(marker.packageDirectory, 'added-in-new.txt'), 'new-only');
    transaction.setUpdateStage(config, marker, 'ready-to-apply');
    transaction.applyPendingUpdate(config, install);
    assert.equal(fs.readFileSync(path.join(install, 'package.json'), 'utf8'), 'new');
    assert.equal(fs.readFileSync(path.join(config, 'dev.sqlite'), 'utf8'), 'user-data');
    assert.equal(fs.existsSync(path.join(install, 'removed-in-new.txt')), false);
    assert.equal(fs.readFileSync(path.join(install, 'added-in-new.txt'), 'utf8'), 'new-only');
    transaction.rollbackPendingUpdate(config, install, 'simulated health failure');
    assert.equal(fs.readFileSync(path.join(install, 'package.json'), 'utf8'), 'old');
    assert.equal(fs.readFileSync(path.join(install, 'removed-in-new.txt'), 'utf8'), 'old-only');
    assert.equal(fs.existsSync(path.join(install, 'added-in-new.txt')), false);
    assert.equal(transaction.readUpdateMarker(config).databaseRestoreRequired, true);

    const second = transaction.createUpdateMarker(config, value, { version: '1.0.0', commitSha: '0'.repeat(40) });
    fs.mkdirSync(second.packageDirectory, { recursive: true });
    fs.writeFileSync(path.join(second.packageDirectory, 'package.json'), 'new-healthy');
    transaction.setUpdateStage(config, second, 'ready-to-apply');
    transaction.applyPendingUpdate(config, install);
    assert.equal(fs.existsSync(second.backupDirectory), true);
    transaction.finalizeHealthyUpdate(config, value.version, value.commitSha);
    assert.equal(fs.existsSync(second.backupDirectory), false);
    assert.equal(transaction.readUpdateMarker(config).stage, 'healthy');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('interrupted apply is idempotently completed and interrupted download is failed closed', () => {
  const root = temporary('interruption');
  try {
    const install = path.join(root, 'install');
    const config = path.join(root, 'config');
    fs.mkdirSync(install);
    fs.writeFileSync(path.join(install, 'package.json'), 'old');
    const value = manifest({ platform: 'linux' });
    const marker = transaction.createUpdateMarker(config, value, { version: '1.0.0', commitSha: '0'.repeat(40) });
    fs.mkdirSync(marker.packageDirectory, { recursive: true });
    fs.mkdirSync(marker.backupDirectory, { recursive: true });
    fs.writeFileSync(path.join(marker.packageDirectory, 'package.json'), 'new');
    fs.renameSync(path.join(install, 'package.json'), path.join(marker.backupDirectory, 'package.json'));
    transaction.setUpdateStage(config, marker, 'applying');
    transaction.recoverInterruptedUpdate(config, install);
    assert.equal(fs.readFileSync(path.join(install, 'package.json'), 'utf8'), 'new');
    assert.equal(transaction.readUpdateMarker(config).stage, 'swapped');

    transaction.rollbackPendingUpdate(config, install, 'reset');
    const downloadMarker = transaction.createUpdateMarker(config, value, { version: '1.0.0', commitSha: '0'.repeat(40) });
    fs.mkdirSync(path.dirname(downloadMarker.packageDirectory), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(downloadMarker.packageDirectory), 'partial'), 'partial');
    transaction.recoverInterruptedUpdate(config, install);
    assert.equal(transaction.readUpdateMarker(config).stage, 'failed');

    const extractMarker = transaction.createUpdateMarker(config, value, { version: '1.0.0', commitSha: '0'.repeat(40) });
    fs.mkdirSync(extractMarker.packageDirectory, { recursive: true });
    fs.writeFileSync(path.join(extractMarker.packageDirectory, 'partial-extract'), 'partial');
    transaction.setUpdateStage(config, extractMarker, 'extracting');
    transaction.recoverInterruptedUpdate(config, install);
    assert.equal(transaction.readUpdateMarker(config).stage, 'failed');
    assert.equal(fs.existsSync(extractMarker.packageDirectory), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('program update lock excludes concurrency and active database lifecycle blocks swap', () => {
  const root = temporary('locks');
  try {
    const config = path.join(root, 'config');
    const first = transaction.acquireProgramUpdateLock(config);
    assert.throws(() => transaction.acquireProgramUpdateLock(config), /another program update/);
    first.release();
    const install = path.join(root, 'install');
    fs.mkdirSync(install);
    const value = manifest({ platform: 'linux' });
    const marker = transaction.createUpdateMarker(config, value, { version: '1.0.0', commitSha: '0'.repeat(40) });
    fs.mkdirSync(marker.packageDirectory, { recursive: true });
    fs.writeFileSync(path.join(marker.packageDirectory, 'package.json'), 'new');
    transaction.setUpdateStage(config, marker, 'ready-to-apply');
    fs.writeFileSync(path.join(config, 'database-migration.lock'), JSON.stringify({
      formatVersion: 1, pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString(), nonce: 'active',
    }));
    assert.throws(() => transaction.applyPendingUpdate(config, install), /database migration\/restore is active/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('source policy rejects missing and historical ZViewer repositories', () => {
  const saved = process.env.TONGMU_UPDATE_REPOSITORY;
  try {
    delete process.env.TONGMU_UPDATE_REPOSITORY;
    assert.throws(() => updater.updaterInternalsForTests.configuredRepository(), /disabled/);
    process.env.TONGMU_UPDATE_REPOSITORY = 'zero-wyc/ZViewer';
    assert.throws(() => updater.updaterInternalsForTests.configuredRepository(), /refuses/);
    process.env.TONGMU_UPDATE_REPOSITORY = 'example/TongMu';
    assert.deepEqual(updater.updaterInternalsForTests.configuredRepository(), { owner: 'example', name: 'TongMu' });
  } finally {
    if (saved === undefined) delete process.env.TONGMU_UPDATE_REPOSITORY;
    else process.env.TONGMU_UPDATE_REPOSITORY = saved;
  }
});

test('network and version policy reject unsafe schemes, private addresses, downgrade and same-version SHA replacement', async () => {
  await assert.rejects(() => updater.updaterInternalsForTests.validateNetworkUrl('file:///tmp/release'), /HTTPS/);
  await assert.rejects(() => updater.updaterInternalsForTests.validateNetworkUrl('http://github.com/release'), /HTTPS/);
  assert.equal(updater.updaterInternalsForTests.isPrivateAddress('127.0.0.1'), true);
  assert.equal(updater.updaterInternalsForTests.isPrivateAddress('192.168.1.1'), true);
  const remote = { manifest: manifest({ version: '1.0.0', commitSha: 'f'.repeat(40) }) };
  assert.throws(() => updater.updaterInternalsForTests.updateDecision(remote), /same-version/);
  const lower = { manifest: manifest({ version: '0.9.0', commitSha: 'f'.repeat(40) }) };
  assert.equal(updater.updaterInternalsForTests.updateDecision(lower).hasUpdate, false);
});

test('bounded updater fetch supports loopback fixtures without weakening production HTTPS policy', async () => {
  const savedNodeEnvironment = process.env.NODE_ENV;
  const savedLocalhostPolicy = process.env.TONGMU_UPDATE_ALLOW_LOCALHOST;
  process.env.NODE_ENV = 'test';
  process.env.TONGMU_UPDATE_ALLOW_LOCALHOST = 'true';
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.notEqual(address, null);
    const bytes = await updater.updaterInternalsForTests.boundedGet(`http://127.0.0.1:${address.port}/fixture`, {
      maxBytes: 64,
      timeoutMs: 2_000,
      expectedJson: true,
    });
    assert.deepEqual(JSON.parse(bytes.toString('utf8')), { ok: true });
    await assert.rejects(
      () => updater.updaterInternalsForTests.validateNetworkUrl(`http://user:secret@127.0.0.1:${address.port}/fixture`),
      /must not contain credentials/,
    );
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (savedNodeEnvironment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnvironment;
    if (savedLocalhostPolicy === undefined) delete process.env.TONGMU_UPDATE_ALLOW_LOCALHOST;
    else process.env.TONGMU_UPDATE_ALLOW_LOCALHOST = savedLocalhostPolicy;
  }
});

test('legacy archive upload cannot bypass signed release verification', async () => {
  await assert.rejects(() => updater.applyUpdateFromFile(Buffer.from('zip'), 'zviewer-windows-x64.zip'), /Unsigned archive upload is disabled/);
});

test('release packager produces signed canonical bytes and a byte-identical legacy alias', async () => {
  const root = temporary('packager');
  try {
    const input = path.join(root, 'input');
    const output = path.join(root, 'output');
    writeProgramPackage(input, 'release');
    fs.writeFileSync(path.join(input, 'zviewer-cert'), 'cert');
    const pair = keyPair();
    const environment = {
      ...process.env,
      TONGMU_RELEASE_SIGNING_KEY_ID: 'test-only-dynamic',
      TONGMU_RELEASE_SIGNING_PRIVATE_KEY: pair.privateKey,
    };
    const packaged = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'release', 'package-release.js'),
      '--platform', 'linux', '--arch', 'x64', '--input-dir', input, '--output-dir', output,
    ], { cwd: ROOT, env: environment, encoding: 'utf8' });
    assert.equal(packaged.status, 0, packaged.stderr);
    const metadata = JSON.parse(packaged.stdout.trim().split(/\r?\n/).at(-1));
    assert.match(metadata.canonicalName, /^TongMu-1\.0\.0-linux-x64-[0-9a-f]{12}\.tar\.gz$/);
    assert.equal(release.sha256File(path.join(output, metadata.canonicalName)), release.sha256File(path.join(output, metadata.legacyName)));
    const manifestBytes = fs.readFileSync(path.join(output, metadata.manifest));
    const parsed = release.parseReleaseManifest(manifestBytes);
    assert.equal(parsed.inventory.filename, 'artifact-inventory.json');
    assert.match(parsed.inventory.sha256, /^[0-9a-f]{64}$/);
    const signature = release.parseReleaseSignature(fs.readFileSync(path.join(output, metadata.signature)));
    release.verifyReleaseSignature(manifestBytes, parsed, signature, [{ keyId: signature.keyId, algorithm: 'Ed25519', publicKey: pair.publicKey, status: 'active' }]);
    const extracted = path.join(root, 'verified');
    await archive.inspectAndExtractArchive(path.join(output, metadata.canonicalName), extracted, 'linux');
    assert.equal(fs.existsSync(path.join(extracted, 'config')), false);

    const verified = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'release', 'verify-release-output.js'), output,
    ], { cwd: ROOT, env: environment, encoding: 'utf8' });
    assert.equal(verified.status, 0, verified.stderr);

    const tagMismatch = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'release', 'package-release.js'),
      '--platform', 'linux', '--arch', 'x64', '--input-dir', input,
      '--output-dir', path.join(root, 'tag-mismatch'), '--tag', 'v9.9.9',
    ], { cwd: ROOT, env: environment, encoding: 'utf8' });
    assert.notEqual(tagMismatch.status, 0);
    assert.match(tagMismatch.stderr, /does not match package version/);

    const wrongSha = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'release', 'package-release.js'),
      '--platform', 'linux', '--arch', 'x64', '--input-dir', input,
      '--output-dir', path.join(root, 'wrong-sha'),
    ], { cwd: ROOT, env: { ...environment, GITHUB_SHA: '0'.repeat(40) }, encoding: 'utf8' });
    assert.notEqual(wrongSha.status, 0);
    assert.match(wrongSha.stderr, /GITHUB_SHA does not match/);

    const dirtyRelease = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'release', 'package-release.js'),
      '--platform', 'linux', '--arch', 'x64', '--input-dir', input,
      '--output-dir', path.join(root, 'dirty-release'), '--release-mode',
    ], { cwd: ROOT, env: environment, encoding: 'utf8' });
    assert.notEqual(dirtyRelease.status, 0);
    assert.match(dirtyRelease.stderr, /clean checkout/);

    fs.appendFileSync(path.join(output, metadata.canonicalName), 'tampered');
    const tampered = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'release', 'verify-release-output.js'), output,
    ], { cwd: ROOT, env: environment, encoding: 'utf8' });
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /size mismatch|SHA-256 mismatch/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('release workflow is read-only, immutable, tag-validated, npm-ci based, and does not auto-publish', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build.yml'), 'utf8');
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /npm ci/);
  assert.match(workflow, /tag .* does not match package\.json/);
  assert.match(workflow, /TongMu-\$\{\{ steps\.package_meta\.outputs\.version \}\}-\$\{\{ matrix\.platform \}\}-\$\{\{ matrix\.arch \}\}-\$\{\{ steps\.package_meta\.outputs\.sha_short \}\}/);
  assert.doesNotMatch(workflow, /softprops|contents: write|action-gh-release/);
  assert.doesNotMatch(workflow, /^    env:\s*\n\s+TONGMU_RELEASE_SIGNING_PRIVATE_KEY:/m);
  assert.equal((workflow.match(/TONGMU_RELEASE_SIGNING_PRIVATE_KEY: \$\{\{ secrets\./g) || []).length, 1);
  const route = fs.readFileSync(path.join(ROOT, 'backend', 'src', 'routes', 'updater.ts'), 'utf8');
  assert.match(route, /router\.use\(authenticateToken, requireRoot\)/);
  assert.match(route, /requireUpdateMutationOrigin/);
});

test('updater route rejects unauthenticated callers and enforces cookie-origin CSRF policy', async () => {
  const app = express();
  app.use('/updater', updaterRoute.default);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/updater/state`);
    assert.equal(response.status, 401);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  const invokeOrigin = (headers) => new Promise((resolve) => {
    const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    const req = { protocol: 'https', get: (name) => normalized[name.toLowerCase()] };
    const result = { status: 200, next: false };
    const res = {
      status(code) { result.status = code; return this; },
      json() { resolve(result); },
    };
    updaterRoute.requireUpdateMutationOrigin(req, res, () => {
      result.next = true;
      resolve(result);
    });
  });
  assert.deepEqual(await invokeOrigin({ host: 'tongmu.example' }), { status: 403, next: false });
  assert.deepEqual(await invokeOrigin({ host: 'tongmu.example', origin: 'https://evil.example' }), { status: 403, next: false });
  assert.deepEqual(await invokeOrigin({ host: 'tongmu.example', origin: 'https://tongmu.example' }), { status: 200, next: true });
  assert.deepEqual(await invokeOrigin({ host: 'tongmu.example', origin: 'https://evil.example', authorization: 'Bearer automation-token' }), { status: 200, next: true });
});

test('updater error boundary redacts a secret corpus and strips URL queries', () => {
  const fallback = 'bounded update failure';
  for (const secret of [
    'Authorization: Bearer release-secret',
    'Cookie=session-secret',
    'providerCredential=provider-secret',
    'signing_private_key=private-secret',
    '-----BEGIN PRIVATE KEY-----',
    'ghp_abcdefghijklmnopqrstuvwxyz012345',
  ]) {
    assert.equal(updaterRoute.safeUpdateErrorMessage(new Error(secret), fallback), fallback);
  }
  const sanitized = updaterRoute.safeUpdateErrorMessage(
    new Error('fetch https://github.com/example/TongMu/releases?token=do-not-log failed'),
    fallback,
  );
  assert.equal(sanitized, 'fetch https://github.com/example/TongMu/releases failed');
  assert.doesNotMatch(sanitized, /do-not-log|token=/);
});
