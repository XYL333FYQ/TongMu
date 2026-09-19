#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const releaseFormat = require(path.join(ROOT, 'backend', 'dist', 'services', 'updater', 'release-format.js'));
const { inspectAndExtractArchive } = require(path.join(ROOT, 'backend', 'dist', 'services', 'updater', 'archive.js'));

function fail(message) { throw new Error(message); }

function privateKey() {
  const value = process.env.TONGMU_RELEASE_SIGNING_PRIVATE_KEY;
  if (!value) fail('TONGMU_RELEASE_SIGNING_PRIVATE_KEY is required for verification');
  try { return crypto.createPrivateKey(value); }
  catch { return crypto.createPrivateKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'pkcs8' }); }
}

async function main() {
  const output = path.resolve(process.argv[2] || '');
  if (!fs.existsSync(output) || !fs.statSync(output).isDirectory()) fail('release output directory is missing');
  const names = fs.readdirSync(output).sort();
  const manifests = names.filter((name) => name.endsWith('.manifest.json'));
  if (manifests.length !== 1) fail('release output must contain exactly one manifest');
  const manifestName = manifests[0];
  const manifestBytes = fs.readFileSync(path.join(output, manifestName));
  const manifest = releaseFormat.parseReleaseManifest(manifestBytes);
  const signatureName = `${manifestName}.sig`;
  const signature = releaseFormat.parseReleaseSignature(fs.readFileSync(path.join(output, signatureName)));
  const publicKey = crypto.createPublicKey(privateKey()).export({ format: 'pem', type: 'spki' }).toString();
  releaseFormat.verifyReleaseSignature(manifestBytes, manifest, signature, [{
    keyId: signature.keyId,
    algorithm: 'Ed25519',
    publicKey,
    status: 'active',
  }]);
  const canonical = path.join(output, manifest.artifact.filename);
  if (!fs.existsSync(canonical)) fail('canonical artifact is missing');
  if (fs.statSync(canonical).size !== manifest.artifact.size) fail('artifact size mismatch');
  if (releaseFormat.sha256File(canonical) !== manifest.artifact.sha256) fail('artifact SHA-256 mismatch');
  const legacyName = releaseFormat.legacyArtifactFilename(manifest.platform);
  const legacy = path.join(output, legacyName);
  if (!fs.existsSync(legacy) || releaseFormat.sha256File(legacy) !== manifest.artifact.sha256) {
    fail('legacy compatibility alias is not byte-identical');
  }
  const expected = [manifest.artifact.filename, legacyName, manifestName, signatureName].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) fail(`unexpected release output files: ${names.join(', ')}`);
  const extraction = fs.mkdtempSync(path.join(os.tmpdir(), 'tongmu-release-verify-'));
  const destination = path.join(extraction, 'package');
  try {
    await inspectAndExtractArchive(canonical, destination, manifest.platform);
  } finally {
    fs.rmSync(extraction, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify({ ok: true, artifact: manifest.artifact.filename, sha256: manifest.artifact.sha256, signatureKeyId: signature.keyId })}\n`);
}

main().catch((error) => {
  process.stderr.write(`[release-verify] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
