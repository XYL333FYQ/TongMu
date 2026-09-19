# TongMu release artifacts

## Identity and version source

`package.json` at the repository root is the only release version source. A tag
build accepts `v<version>` only when it exactly matches that value. The release
script reads the actual checkout with `git rev-parse HEAD`; neither a workflow
input nor an artifact filename can supply the provenance SHA.

Canonical archives are:

- `TongMu-<version>-windows-x64-<sha12>.zip`
- `TongMu-<version>-linux-x64-<sha12>.tar.gz`

The release candidate also contains the byte-identical compatibility aliases
`zviewer-windows-x64.zip` or `zviewer-linux-x64.tar.gz`. New manifests,
documentation and updater selection use only the canonical name. The alias is
not built independently and is retained only for the ZViewer compatibility
window.

## Manifest and provenance

Every canonical archive has `<archive>.manifest.json` and
`<archive>.manifest.json.sig`. The manifest is UTF-8 canonical JSON with
recursively sorted keys and one trailing LF. It records:

- schema and product (`TongMu`);
- SemVer version, full 40-character checkout SHA and commit timestamp;
- platform and architecture;
- canonical filename, byte size and SHA-256;
- Ed25519 algorithm and `keyId`;
- minimum updater compatibility version;
- Node/npm versions, lockfile SHA-256 and the explicit fact that strict
  bit-for-bit reproducibility is **not claimed**.

`build-info.json` inside the archive carries the same product, version, SHA,
timestamp and target identity. `/health` reports its version and SHA so the
launcher can confirm that the process which started is the process that was
signed.

## Signing and rotation

The detached signature is Ed25519 over the exact canonical manifest bytes.
The private key is read only from `TONGMU_RELEASE_SIGNING_PRIVATE_KEY` in the
release job; its identifier is `TONGMU_RELEASE_SIGNING_KEY_ID`. The workflow
checks only whether those secrets are present and never prints their values.

The updater accepts a bounded `TONGMU_UPDATE_TRUSTED_KEYS` JSON set. Each public
key has a unique `keyId` and status:

- `active`: current signing key;
- `retired`: still verifies older immutable releases;
- `revoked`: always rejected.

An unknown, revoked, malformed, missing or wrong-algorithm signature fails
closed. A repository test key is not shipped or trusted; focused tests generate
ephemeral Ed25519 keypairs.

## Package inventory

The packager builds in a temporary staging directory, validates the entire
tree, then promotes completed outputs. Required runtime content includes the
backend and certificate executables, platform launcher, `package.json`,
`build-info.json`, notices, frontend entry, Voice worklet, icons, at least one
WASM asset and at least one Worker asset. Unexpected top-level content,
symlinks, `.env`, `config/`, databases, backups, uploads, logs and secret files
are rejected.

Single-file archives contain the Playwright resolver code but intentionally do
not redistribute a browser binary. `browser-runtime.json` records this fact.
Operators must set `PLAYWRIGHT_EXECUTABLE_PATH` to a compatible installed
Chromium/Chrome executable. The recommended Docker image remains the path that
bundles Chromium; its real smoke is deferred to Phase 6B-2.

## CI flow

Normal `ci.yml` runs on push and pull requests with read-only contents
permission. `build.yml` runs only for tags or explicit `workflow_dispatch`,
uses a ref-specific concurrency group, exact Node/npm tool versions and
`npm ci`, rejects lockfile drift, validates tag/version/SHA, signs in the
platform job and uploads an immutable Actions artifact name containing
version/platform/architecture/SHA.

The workflow does not create a GitHub Release and does not use `contents:
write`. A separately authorized publish operation may attach the already
verified output. The updater consumes signed GitHub Release assets, never the
30-day transient Actions artifact.
