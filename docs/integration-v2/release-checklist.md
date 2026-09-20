# TongMu V2 release checklist

This is an operator checklist. A checked item requires evidence from the exact
commit being released; an earlier phase result or a successful compile is not
a substitute. Never place a production signing private key in the repository,
logs, artifact, or CI output.

Current worktree evidence (2026-09-20): local source, package, Windows runtime,
Chromium and migration checks pass at the counts recorded in `progress.md`.
Linux executable runtime was not run. Docker is unavailable, so the mandatory
Docker/browser/migration item below is open and the V2 release-candidate status
is **BLOCKED**. These notes do not pre-check an operator item for a future tag.

## Pre-release

- [ ] Working tree and submittable diff reviewed; `references/` unchanged.
- [ ] Release commit SHA is immutable and the SemVer tag exactly matches root
  `package.json`.
- [ ] `npm ci` succeeds from a clean tracked-source export with no local
  `dist/`, `.env`, config, fixture-evidence, or untracked-file dependency.
- [ ] Phase 6A migration matrix and restore smoke pass, including unknown-schema
  fail-closed and automatic pre-migration backup evidence.
- [ ] Backend, frontend, Chromium, updater/package, observability and focused
  secret/provenance tests pass at the recorded counts.
- [ ] `THIRD-PARTY-NOTICES.md` and `PROVENANCE-INVENTORY.md` cover every
  standalone asset, vendored source, WASM, Worker and binary in the artifact.
- [ ] No provenance row is `UNKNOWN`; otherwise stop the release.
- [ ] The production Ed25519 signing key is supplied only by the authorized
  release environment and its configured key ID is active.

## Release

- [ ] Build the Windows and Linux inputs and run `scripts/release/package-release.js`
  in release mode from the tag checkout.
- [ ] Verify the canonical archive, byte-identical compatibility alias, signed
  canonical manifest, archive SHA-256, `build-info.json`, and signed
  `artifact-inventory.json` digest with `verify-release-output.js`.
- [ ] Independently extract each archive to a Unicode + spaces path and verify
  the per-file inventory, notices, provenance, frontend, launcher and backend.
- [ ] Scan extracted contents for forbidden persistent data, secrets, signing
  key material, local absolute config paths and test-only credentials.
- [ ] Run Windows launcher/health/frontend/BrowserResolver/config-isolation
  smoke with an external Chromium executable.
- [ ] Run Linux standalone smoke when a Linux runner is available.
- [ ] Run the real `Dockerfile.linux-browser` / `docker-compose.yml` smoke:
  fresh volume, historical migration + backup, health/build identity,
  persistence after recreate, Chromium launch, controlled BrowserResolver
  fallback, and Direct/HLS/DASH runtime probes. A missing Docker run blocks the
  V2 release candidate.
- [ ] Attach only immutable archives, their manifests and signatures to the
  release. Do not mutate or replace an existing version/SHA artifact.

## Post-release

- [ ] Verify a clean installation starts and reports the released version and
  full commit SHA through `/health`.
- [ ] Upgrade one supported historical database, confirm data/credentials are
  preserved, and retain its automatic backup.
- [ ] Confirm updater check accepts the published signature/checksum and refuses
  downgrade, same-version SHA replacement, revoked/unknown keys and tampering.
- [ ] Confirm documented Docker source-build/redeploy plus `/app/config` volume
  preservation; in-container self-update remains unsupported.
- [ ] Confirm rollback instructions in `docs/updating.md` and
  `docs/upgrade-v2.md` match the released launcher and database backup format.
