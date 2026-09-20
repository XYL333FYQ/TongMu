#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const tar = require('tar');

const ROOT = path.resolve(__dirname, '..', '..');
const REQUIRED = {
  windows: ['package.json', 'browser-runtime.json', 'frontend/dist/index.html', 'frontend/dist/voice-processor.js', 'frontend/dist/icons.svg', 'zviewer-backend.exe', 'zviewer-cert.exe', 'start.bat', 'start.ps1', 'THIRD-PARTY-NOTICES.md', 'PROVENANCE-INVENTORY.md'],
  linux: ['package.json', 'browser-runtime.json', 'frontend/dist/index.html', 'frontend/dist/voice-processor.js', 'frontend/dist/icons.svg', 'zviewer-backend', 'zviewer-cert', 'start.sh', 'THIRD-PARTY-NOTICES.md', 'PROVENANCE-INVENTORY.md'],
};
const ALLOWED_TOP_LEVEL = new Set([
  'frontend', 'package.json', 'build-info.json', 'start.bat', 'start.ps1', 'start.sh',
  'zviewer-backend.exe', 'zviewer-cert.exe', 'zviewer-backend', 'zviewer-cert',
  'THIRD-PARTY-NOTICES.md', 'PROVENANCE-INVENTORY.md', 'artifact-inventory.json',
  'LICENSE', 'browser-runtime.json',
]);
const FORBIDDEN_NAMES = /^(?:config|uploads|media|backups?|logs?|\.env|dev\.sqlite|secret-vault\.json|jwt-secrets\.json)$/i;

function fail(message) { throw new Error(message); }

function argumentsMap(argv) {
  const result = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) fail(`unexpected argument: ${item}`);
    if (item === '--release-mode') result.set(item, true);
    else {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) fail(`missing value for ${item}`);
      result.set(item, value);
      index += 1;
    }
  }
  return result;
}

function canonicalValue(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalValue).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`).join(',')}}`;
  }
  fail('manifest contains a non-JSON value');
}

function canonicalJson(value) { return Buffer.from(`${canonicalValue(value)}\n`, 'utf8'); }
function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function git(...args) { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim(); }

function copyTree(source, destination) {
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) fail(`release input contains symlink: ${from}`);
    if (entry.isDirectory()) copyTree(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
    else fail(`release input contains special file: ${from}`);
  }
}

function inspectTree(root) {
  for (const name of fs.readdirSync(root)) {
    if (!ALLOWED_TOP_LEVEL.has(name)) fail(`unexpected top-level release entry: ${name}`);
  }
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (FORBIDDEN_NAMES.test(entry.name)) fail(`release contains forbidden persistent-data entry: ${path.join(directory, entry.name)}`);
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail(`release contains symlink: ${absolute}`);
      if (entry.isDirectory()) walk(absolute);
      else if (!entry.isFile()) fail(`release contains special file: ${absolute}`);
    }
  };
  walk(root);
}

function ensureRequired(root, platform) {
  for (const relative of REQUIRED[platform]) {
    const absolute = path.join(root, ...relative.split('/'));
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) fail(`release input is missing: ${relative}`);
  }
  const assets = fs.readdirSync(path.join(root, 'frontend', 'dist', 'assets'));
  if (!assets.some((name) => name.endsWith('.wasm'))) fail('release input is missing a runtime WASM asset');
  if (!assets.some((name) => /worker.*\.js$/i.test(name))) fail('release input is missing a runtime Worker asset');
}

function artifactInventory(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        if (path.relative(root, absolute).replace(/\\/g, '/') === 'artifact-inventory.json') continue;
        files.push({
          path: path.relative(root, absolute).replace(/\\/g, '/'),
          size: fs.statSync(absolute).size,
          sha256: sha256File(absolute),
        });
      }
    }
  };
  walk(root);
  return { schemaVersion: 1, algorithm: 'SHA-256', files };
}

async function makeArchive(packageDirectory, archivePath, platform) {
  if (platform === 'windows') {
    const escapedSource = packageDirectory.replace(/'/g, "''");
    const escapedDest = archivePath.replace(/'/g, "''");
    execFileSync('powershell', ['-NoProfile', '-Command',
      `$ErrorActionPreference='Stop'; Compress-Archive -Path '${escapedSource}\\*' -DestinationPath '${escapedDest}' -CompressionLevel Optimal`],
      { cwd: ROOT, stdio: 'inherit' });
  } else {
    const entries = fs.readdirSync(packageDirectory).sort();
    await tar.c({ file: archivePath, cwd: packageDirectory, gzip: true, portable: true, strict: true }, entries);
  }
}

function privateKeyFromEnvironment() {
  const value = process.env.TONGMU_RELEASE_SIGNING_PRIVATE_KEY;
  if (!value) fail('TONGMU_RELEASE_SIGNING_PRIVATE_KEY is required');
  try { return crypto.createPrivateKey(value); }
  catch {
    try { return crypto.createPrivateKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'pkcs8' }); }
    catch { fail('release signing private key is invalid'); }
  }
}

function promote(source, destination) {
  if (fs.existsSync(destination)) {
    if (sha256File(source) === sha256File(destination)) { fs.rmSync(source, { force: true }); return; }
    fail(`immutable release output already exists with different bytes: ${destination}`);
  }
  fs.renameSync(source, destination);
}

async function main() {
  const args = argumentsMap(process.argv.slice(2));
  const platform = args.get('--platform');
  const architecture = args.get('--arch');
  const input = path.resolve(String(args.get('--input-dir') || ''));
  const output = path.resolve(String(args.get('--output-dir') || ''));
  const tag = args.get('--tag');
  if (!['windows', 'linux'].includes(platform)) fail('--platform must be windows or linux');
  if (architecture !== 'x64') fail('--arch must be x64');
  if (!fs.existsSync(input) || !fs.statSync(input).isDirectory()) fail('--input-dir must be a directory');
  if (!output || output === path.parse(output).root) fail('--output-dir is unsafe');

  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = packageJson.version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) fail('root package.json version is not valid SemVer');
  if (tag && String(tag).replace(/^v/, '') !== version) fail(`tag ${tag} does not match package version ${version}`);
  const commitSha = git('rev-parse', 'HEAD').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commitSha)) fail('git HEAD is not a full commit SHA');
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA.toLowerCase() !== commitSha) fail('GITHUB_SHA does not match checkout HEAD');
  if (args.has('--release-mode') && git('status', '--porcelain', '--untracked-files=normal')) fail('release-mode packaging requires a clean checkout');

  const keyId = process.env.TONGMU_RELEASE_SIGNING_KEY_ID;
  if (!keyId || !/^[A-Za-z0-9._-]{1,96}$/.test(keyId)) fail('TONGMU_RELEASE_SIGNING_KEY_ID is required and invalid');
  const privateKey = privateKeyFromEnvironment();
  if (privateKey.asymmetricKeyType !== 'ed25519') fail('release signing key must be Ed25519');

  const extension = platform === 'windows' ? '.zip' : '.tar.gz';
  const canonicalName = `TongMu-${version}-${platform}-${architecture}-${commitSha.slice(0, 12)}${extension}`;
  const legacyName = platform === 'windows' ? 'zviewer-windows-x64.zip' : 'zviewer-linux-x64.tar.gz';
  const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tongmu-release-'));
  const packageDirectory = path.join(stagingRoot, 'package');
  const incoming = path.join(stagingRoot, 'incoming');
  fs.mkdirSync(incoming);
  try {
    copyTree(input, packageDirectory);
    inspectTree(packageDirectory);
    ensureRequired(packageDirectory, platform);
    const buildTimestamp = git('show', '-s', '--format=%cI', 'HEAD');
    const buildInfo = { schemaVersion: 1, product: 'TongMu', version, commitSha, buildTimestamp, platform, architecture };
    fs.writeFileSync(path.join(packageDirectory, 'build-info.json'), `${JSON.stringify(buildInfo, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
    const inventoryPath = path.join(packageDirectory, 'artifact-inventory.json');
    fs.writeFileSync(inventoryPath, `${JSON.stringify(artifactInventory(packageDirectory), null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
    inspectTree(packageDirectory);

    const archivePath = path.join(incoming, canonicalName);
    await makeArchive(packageDirectory, archivePath, platform);
    const artifactSize = fs.statSync(archivePath).size;
    const artifactSha256 = sha256File(archivePath);
    const lockfileSha256 = sha256File(path.join(ROOT, 'package-lock.json'));
    const npmVersion = process.platform === 'win32'
      ? execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm --version'], { encoding: 'utf8' }).trim()
      : execFileSync('npm', ['--version'], { encoding: 'utf8' }).trim();
    const manifest = {
      schemaVersion: 1,
      product: 'TongMu',
      version,
      commitSha,
      buildTimestamp,
      platform,
      architecture,
      artifact: { filename: canonicalName, size: artifactSize, sha256: artifactSha256 },
      inventory: { filename: 'artifact-inventory.json', sha256: sha256File(inventoryPath) },
      signature: { algorithm: 'Ed25519', keyId },
      minimumUpdaterCompatibilityVersion: '1.0.0',
      buildEnvironment: { node: process.version, npm: npmVersion, lockfileSha256, reproducible: false },
    };
    const manifestBytes = canonicalJson(manifest);
    const manifestPath = path.join(incoming, `${canonicalName}.manifest.json`);
    fs.writeFileSync(manifestPath, manifestBytes, { mode: 0o644 });
    const signature = crypto.sign(null, manifestBytes, privateKey).toString('base64');
    const signaturePath = path.join(incoming, `${canonicalName}.manifest.json.sig`);
    fs.writeFileSync(signaturePath, canonicalJson({ schemaVersion: 1, algorithm: 'Ed25519', keyId, signature }), { mode: 0o644 });
    fs.copyFileSync(archivePath, path.join(incoming, legacyName));
    if (sha256File(path.join(incoming, legacyName)) !== artifactSha256) fail('legacy alias is not byte-identical');

    fs.mkdirSync(output, { recursive: true });
    for (const name of [canonicalName, legacyName, `${canonicalName}.manifest.json`, `${canonicalName}.manifest.json.sig`]) {
      promote(path.join(incoming, name), path.join(output, name));
    }
    process.stdout.write(`${JSON.stringify({ canonicalName, legacyName, version, commitSha, artifactSize, artifactSha256, manifest: `${canonicalName}.manifest.json`, signature: `${canonicalName}.manifest.json.sig` })}\n`);
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`[release-package] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
