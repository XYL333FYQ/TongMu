# TongMu V2 integration progress

## Purpose and status

This file is the persistent checkpoint for the TongMu V2 integration program. Phase 0 is an audit and design phase only: no product code, dependency, database, configuration, CI, or reference source was changed.

Current state: **Phase 2, Phase 3A, Phase 3B, Phase 4A, Phase 4B Voice, Phase 5A RealtimeSyncCore/Permissions, and Phase 5B-1 MusicSyncDomain/Together Listen are complete within their approved boundaries. The Phase 5B-1 final acceptance gate is closed after the Voice fake-media Chromium regression was diagnosed and minimally fixed; Phase 5B-2 NCM and the Phase 6 migration/release gate remain open.**

Phase 2 has a working core checkpoint: the versioned client profile, server
viability filter, client-owned planner path, provider contract/registry, and
deterministic tamper coverage are implemented. Phase 2B additionally converges
Local/server files, WebDAV, FTP, and OpenList/Alist playback resolution through
the Media Core. Phase 2C-1 now converges Emby and Jellyfin playback through the
same path, including profile viability, private credentials, representation
facts, and provider session cleanup. Phase 2C-2 now converges AniSubs, Kazumi,
configured anime sources, public HLS/HTTP-FLV live inputs, and Bilibili DASH
exact codec/profile filtering through the same Media Core entrypoint. Provider-
specific catalog/browse routes remain compatibility surfaces; Phase 3 manifest
typing and Phase 6 release/migration work remain open.

Phase 1 restored the declared dependency baseline, closed the scoped credential and
token-revocation P0/P1 defects, introduced the shared ByteRange core, and added a
tested migration foundation. It did not perform provider/profile convergence or
the historical-database work reserved for Phase 6.

## Baseline

### Repository identity

- TongMu branch: `main`
- TongMu audited commit: `cfec6909f271d6fe433c9a5e980a918be9ab5980`
- Initial Phase 1 worktree: the Phase 0 audit documents were present as untracked
  `docs/integration-v2/`; no tracked product changes were overwritten.
- Main project: repository root only
- Reference trees are read-only and are nested under extracted archive directories:
  - `references/ZViewer-main/ZViewer-main`
  - `references/synctv-main/synctv-main`
- No `synctv-app` source tree is present.

The extracted reference trees contain no `.git` metadata, so their exact snapshot commits cannot be proven locally. On the audit date, remote HEAD lookup returned:

- ZViewer: `9890f7cda739912f4f6167a0ddea510eafec7160`
- SyncTV: `7f3e625b4ecad588bc1c7d773ffb337661cac95d`
- synctv-app: `c18c737aa0ee5e9e1194b3762c66ba73e6d5d5e2` (source absent locally; not audited)

These remote values identify the upstream state observed on 2026-09-13; they do not prove that the extracted folders are byte-for-byte identical to those commits.

### Current TongMu architecture baseline

- Media Core already separates `PrivateMediaSource`, public `MediaDescriptor`, `PlaybackCandidate`, server-issued media handles/grants, client `localPlanner`, and player engines.
- The server owns secrets, authorization, source resolution, and safety/viability facts. The client owns the final `PlaybackPlan` choice.
- Rooms share media facts/descriptors and source generation, not a device-specific playback plan.
- Bilibili, Direct URL, Generic Web, and BrowserResolver are substantially integrated with the new core.
- Emby and Jellyfin playback now use separate Media Core providers; their
  browse/manage APIs and legacy playback routes remain compatibility surfaces.
  Anime/Kazumi/AniSubs catalog paths and live publishing/ingest remain
  provider-specific compatibility surfaces. Their playable source resolution
  now enters Media Core; storage browse/manage APIs remain provider-specific by
  design.
- Safe Fetch and BrowserResolver provide meaningful SSRF and network-policy defenses, but every proxy/resolver path must continue to use the same policy boundary.
- SQLite/config persistence remains rooted at `/app/config`; the root Docker entry retains Playwright/Chromium and `shm_size` expectations.

## Known issues

Severity here describes what must be addressed before treating TongMu V2 as a safe, migration-ready release. It is not a claim that every item is remotely exploitable today.

### Phase 1-scoped P0 status

The Phase 1-scoped credential exposure, reversible credential storage, and Range
correctness blockers are closed. The remaining database item is a deliberate
release gate rather than an untested quick change: startup still retains
`synchronize: true` until Phase 6 has representative historical fixtures and can
prove a safe `synchronize: false` rollout. Phase 1 now has the migration harness,
fresh/existing detection, retry behavior, and documented backup expectation needed
to do that work safely.

### P1 — high-priority integration and reliability gaps

1. Phase 3A typed HLS/DASH resource mapping and its Chromium browser exit gate are complete; the fixture's Inspector/client-blocked diagnostics are intentional route aborts used to verify fallback.
2. Live publishing/ingest lifecycle (RTMP/WHIP/WHEP) remains outside public HLS/HTTP-FLV source convergence and is explicitly deferred.
3. Phase 3A's typed DASH mapper covers `SegmentBase`, representation indexes, bitstream-switching resources, `Location`, xlink, timing URLs, and bounded recursion in unit/backend tests; nested fixture MPD playback is covered by the completed Chromium suite.
4. Realtime video and music synchronization now share the documented `RealtimeSyncCore` primitives while keeping independent clocks and state. Phase 5B-1 MusicSyncDomain, queue state, and Together Listen are complete; its final acceptance gate is closed. The historical Voice fake-media Chromium blocker and its auth-refresh race fix are recorded in the Phase 5B-1 closure below. NCM remains Phase 5B-2.
5. Voice lifecycle, identity, reconnect replacement, decoder ownership, ghost cleanup, and voice-local moderation remain Phase 4B behavior; Phase 5A now supplies the shared permission decision boundary.
6. Phase 4A player/subtitle lifetime hardening and Phase 4B Voice are complete within their scoped boundaries.
7. Release artifacts still retain historical ZViewer-era names for compatibility; full TongMu renaming, checksum/signature verification, staged extraction, and rollback remain Phase 6 work.
8. Third-party provenance is incomplete for fonts, images, icons, wasm/binaries, bundled JavaScript, and media fixtures. Upstream assets must not be copied until license and attribution are recorded.
9. Docker and ffmpeg are unavailable on this host, so browser-enabled container and transcoding-specific validation remain environment-dependent.

### P2 — valuable hardening and product maturity

1. Add structured request/component logs, stable request IDs, response bytes/latency, and bounded metric labels without importing cluster-oriented observability infrastructure.
2. Consolidate responsive/mobile primitives (`useMediaQuery`, safe-area, `dvh`, coarse-pointer and hover fallbacks) as features are adapted.
3. Phase 4A protects subtitle track identity, sparse-probe race guards, late-join synchronization, extraction cleanup, and source-generation cleanup; broader product subtitle UX remains separate.
4. Introduce bounded, validator-aware range slice caching only after Range correctness and authorization are proven.
5. Normalize product/release artifact naming while preserving database, API, and updater compatibility aliases.
6. Consider playback history, privacy/blocking, and user-resource lifecycle only after the media/security foundation is stable.

## Phase checklist

- [x] Phase 0 — inspect TongMu architecture, ZViewer, SyncTV, licenses, tests, CI, packaging, and extracted reference identity.
- [x] Phase 0 — record capability-level decisions in the adoption matrix.
- [x] Phase 0 — define target architecture and executable implementation phases.
- [x] Phase 1 — security and correctness foundation: secret boundary, credentials, Range, migration foundation, baseline restoration, updater/CI safety stopgap.
- [x] Phase 2 — Media Core + Provider convergence.
- [x] Phase 3 — Manifest / Proxy / Slice Cache.
- [x] Phase 4A — Player / Subtitle lifecycle.
- [x] Phase 4B — Voice lifecycle / identity / moderation.
- [x] Phase 5A — `RealtimeSyncCore` / VideoSyncDomain / Room Permissions.
- [x] Phase 5B-1 — `MusicSyncDomain` / persistent queue / Together Listen (implementation and final regression gate complete within the approved boundary).
- [ ] Phase 5B-2 — NCM provider and product surface.
- [ ] Phase 6 — Historical migrations / Packaging / CI / Observability / release gate.

See `implementation-plan.md` for dependencies, file targets, tests, exit criteria, and risks.

## Baseline validation and Phase 1 verification

The declared dependency environment was restored before product changes with
`npm ci`. It installed 879 packages and applied the repository's existing
`patch-package` patch without changing package manifests or the lockfile.

| Check | Command | Result | Evidence / limitation |
|---|---|---:|---|
| Dependency restore | `npm ci` | PASS | 879 packages; no package or lockfile diff |
| Backend typecheck | `npm run lint -w backend` | PASS | TypeScript `--noEmit` |
| Backend tests | `npm test -w backend` | PASS | 60/60, including 13 Phase 1 foundation tests |
| Frontend tests | `npm test -w frontend` | PASS | 5/5 |
| Frontend production build | `npm run build -w frontend` | PASS | Existing dynamic-import/chunk-size warnings remain; no build failure |
| Critical media E2E | `npm run test:e2e -- --reporter=line` | PASS | 12/12 using the repository's Node Playwright runner |
| Docker Compose config | `docker compose config --quiet` | NOT RUN | Docker CLI is unavailable on this host |

Recorded tool versions:

- Node `v24.18.0`
- npm `11.16.0`
- local Node Playwright `1.62.0`
- ffmpeg: **NOT FOUND**
- Docker: **NOT FOUND**

The baseline and Phase 1 checks cover direct/gateway playback, HLS/DASH,
source generation, room grants, BrowserResolver, credential boundaries, auth
revocation, Range semantics, and updater-source safety. Docker image startup,
ffmpeg-dependent transcoding, and live third-party provider accounts remain
environment-dependent.

## Phase 2 core checkpoint validation (pre-Phase 2B snapshot)

| Check | Command | Result | Evidence / limitation |
| --- | --- | ---: | --- |
| Backend lint | `npm run lint -w backend` | PASS | TypeScript typecheck after profile/provider/cancellation changes |
| Backend tests | `npm test -w backend` | PASS | 65/65, including V1 profile, viability, provider context, route-boundary, and repeated tamper coverage |
| Frontend tests | `npm test -w frontend` | PASS | 8/8, including tuple matching, empty profile, collector bounds, and stable fingerprint |
| Frontend production build | `npm run build -w frontend` | PASS | Existing MediaBunny dynamic-import and large-chunk warnings remain |
| Frontend ESLint | `npm run lint -w frontend` | BASELINE BLOCKED | Existing repository/vendor formatting and rule/plugin findings; the full run reported 7,193 problems and the focused changed-file run reported 4,246, with no lint rule weakened |
| Chromium media E2E | `npm run test:e2e -- --reporter=dot` | PASS | 13/13; real direct/HLS/DASH, room grants, fallback, private DTO, mobile overflow, and real V1 browser collector |
| Diff whitespace check | `git diff --check` | PASS | Only Git's existing LF/CRLF normalization warnings were reported |

This is a **core checkpoint**, not a full Phase 2 exit: provider compatibility
ledger entries for Emby, Jellyfin, AniSubs/Kazumi/anime, and live routes remain
temporary adapters or legacy surfaces. Docker and ffmpeg were not available
for this validation run.

## Phase 2B storage convergence validation

| Check | Command | Result | Evidence / limitation |
| --- | --- | ---: | --- |
| Backend lint | `npm run lint -w backend` | PASS | LocalFile, WebDAV, FTP and OpenList providers plus gateway compile/typecheck |
| Backend tests | `npm test -w backend` | PASS with 1 skip | 70 passing; Windows symlink-escape case skipped because this environment does not permit creating a symlink |
| Frontend tests | `npm test -w frontend` | PASS | 9/9, including storage-reference encoding and existing Phase 2 profile/planner coverage |
| Frontend lint | `npm run lint -w frontend` | BASELINE BLOCKED | Existing repository/vendor CRLF, formatting, and React-compiler findings remain; no lint rule or assertion was weakened |
| Frontend production build | `npm run build -w frontend` | PASS | Existing dynamic-import/chunk-size warnings remain |
| Provider contract coverage | backend fixture suite | PASS | Four providers exercise validation/normalization/resolve/private source/candidates/cancellation/redaction; FTP real-server E2E not run |
| Chromium storage fixture E2E | `npx playwright test e2e/media-playback.spec.ts -g "storage providers resolve" --reporter=line` | PASS | Local File, credentialed WebDAV, and credentialed/private-URL OpenList resolve through `mediaApi` and play through the scoped gateway |
| Chromium media E2E | `npm run test:e2e -- --reporter=dot` | PASS | 14/14; existing 13 tests plus the storage fixture flow |
| Diff whitespace check | `git diff --check` | PASS | No whitespace errors |

The storage providers preserve provider-specific browse APIs but route new
playback through `mediaApi` and the client Local Planner. A legacy server-file
fallback remains for old movie records that have no `storage://` source or
Media Core descriptor; it is documented as compatibility debt, not a new path.

### Phase 2B secret storage boundary

- New WebDAV, FTP, and OpenList `UserMount` writes are wrapped by the existing
  SecretVault transformer. OpenList still hashes its AList password before the
  encrypted write.
- Existing mount rows remain readable for compatibility; a legacy plaintext
  value is only upgraded when that row is saved. Historical plaintext therefore
  remains a Phase 6 migration debt, not a claim of completed conversion.
- Local File has no provider credential. Legacy movie credential fields keep
  their existing compatibility transformer and are not used by new
  `storage://` references.

## Phase 2C-1 Emby + Jellyfin convergence validation

Phase 2C-1 is **COMPLETE within its scoped boundary**. This does not complete
Phase 2 as a whole.

- Emby and Jellyfin have separate `EmbyProvider` and `JellyfinProvider`
  boundaries. Their saved identity is a credential-free
  `provider://<provider>?mountId=...&itemId=...` reference; server URL, API
  key/password, user identity, media-source data, upstream headers, and play
  session identity remain sealed/private.
- Playback follows Provider -> `PrivateMediaSource` -> public descriptor ->
  candidate list -> server viability -> browser `PlaybackClientProfile` and
  `localPlanner`. The server does not return or persist a final browser plan.
- Direct Play, proven same-quality Direct Stream/remux, and quality-changing
  Transcode are separate candidate facts. Provider video transcode is disabled
  by default and only appears with an explicit opt-in flag. The existing
  playsvideo compatibility route remains available for client-side remux/audio
  compatibility.
- Session start/progress/stop/cleanup uses sealed opaque capabilities and a
  bounded coordinator. The host player reports provider progress separately
  from room truth; generation replacement, abort, stale progress, duplicate
  cleanup, provider failure, and room/source abandonment are covered.
- Old Emby/Jellyfin rows can be refreshed through `media-movie:<id>` and are
  upgraded to the stable provider reference after a successful resolution.
  Browse, mount-management, and legacy proxy/resolve routes remain facades for
  the compatibility window; the current add/play frontend uses `mediaApi`.

### Phase 2C-1 validation

| Check | Command | Result | Evidence / limitation |
| --- | --- | ---: | --- |
| Backend typecheck/build | `npm run build -w backend` | PASS | Separate Emby/Jellyfin clients/providers, gateway/session routes compile |
| Backend tests | `npm test -w backend` | PASS with 1 skip | 78 passing, 1 Windows symlink-escape skip; 8 Phase 2C-1 provider/session tests pass |
| Frontend tests | `npm test -w frontend` | PASS | 9/9 |
| Frontend production build | `npm run build -w frontend` | PASS | Existing MediaBunny dynamic-import and large-chunk warnings remain |
| Focused frontend lint | changed-file ESLint | BASELINE BLOCKED | Existing CRLF/Prettier, React Compiler/ref, and set-state-in-effect findings remain; no lint rule was weakened |
| Chromium media fixture E2E | `npx playwright test e2e/media-playback.spec.ts --reporter=line` | PASS | 16/16, including Emby and Jellyfin fixture playback through `mediaApi`, Range/subtitle access, and session lifecycle calls |
| Real Emby server | external account/server | NOT RUN | No real Emby server/account was supplied |
| Real Jellyfin server | external account/server | NOT RUN | No real Jellyfin server/account was supplied |
| Diff whitespace check | `git diff --check` | PASS | No whitespace errors |

### Phase 2C-1 secret and quality boundary

- **Encrypted now:** new `UserMount.password` and `UserMount.apiKey` writes use
  the existing AES-256-GCM `SecretVault` transformer; media/session
  capabilities are separately sealed server-side.
- **Legacy readable:** existing non-envelope mount credentials remain readable
  so old deployments continue to work; saving the row upgrades that value.
- **Plaintext legacy remaining:** pre-existing mount rows that have not been
  saved remain plaintext in the database. No destructive bulk migration was
  attempted; this remains a Phase 6 debt.
- **Quality invariant:** no unsupported codec or transport failure silently
  requests a lower-quality provider video transcode. Lower-resolution or
  codec-changing output is only represented as an explicit transcode
  candidate; transport fallback and proven same-quality remux remain distinct.

Overall Phase 2 is now **COMPLETE within the Media Core/provider-convergence
scope**. Phase 3 manifest/resource hardening and Phase 6 migration/release gates
remain intentionally open.

## Phase 2C-2 Anime, live, and Bilibili convergence validation

Phase 2C-2 is **COMPLETE within the Phase 2 Media Core boundary**. The
catalog/search routes remain provider-specific, but playable source resolution
is now centralized.

- AniSubs, Kazumi, and configured anime sources use bounded stable
  `provider://` references. Temporary media URLs and provider headers are
  resolved server-side into `PrivateMediaSource` and `MediaDescriptor`; the
  room stores provider facts only.
- AniSubs/rule/catalog HTTP requests use the SSRF-safe Safe Fetch policy with
  bounded bodies, deadlines, cancellation, and optional BrowserResolver
  fallback. Compatibility `/resolve` routes return only a stable reference.
- Public HLS and HTTP-FLV inputs use an explicit live provider. Live facts
  (`isLive`, transport kind, non-seekable/unknown duration, reconnect policy)
  flow to the frontend; flv.js receives `isLive` instead of assuming VOD.
  Managed RTMP/WHIP/WHEP publishing remains deferred.
- Bilibili DASH selection now filters the requested quality by the complete
  video/audio RFC6381 tuple and the request-scoped client profile. If the
  requested quality has no supported tuple, resolution fails; it never silently
  selects a lower quality.
- Persisted room/movie descriptors remove signed URLs, headers, opaque session
  capabilities, transport plans, and host-specific playback plans; a bounded
  numeric `expiresAt` fact may remain so the client can trigger re-resolution.

### Phase 2C-2 validation

| Check | Command | Result | Evidence / limitation |
| --- | --- | ---: | --- |
| Backend build/typecheck | `npm run build -w backend` | PASS | Anime/live providers, profile propagation, and route DTOs compile |
| Backend lint | `npm run lint -w backend` | PASS | TypeScript no-emit check passes for the final Phase 2C-2 tree |
| Backend tests | `npm test -w backend` | PASS with 1 skip | 83 passing, 1 Windows symlink-escape skip; exact-codec/reference/live and bounded-rule tests pass |
| Frontend tests | `npm test -w frontend` | PASS | 9/9 |
| Frontend production build | `npm run build -w frontend` | PASS | Existing MediaBunny dynamic-import and large-chunk warnings remain |
| Focused frontend lint | changed-file ESLint | BASELINE BLOCKED | 4,254 problems (4,253 errors, 1 warning), predominantly existing Prettier/CRLF and repository/vendor rule findings; no lint rule was weakened |
| Provider playback bypass audit | `rg` source audit | PASS | Anime/Kazumi selection uses `resolveMediaInput`; no new raw URL/header persistence |
| Diff whitespace check | `git diff --check` | PASS | Only existing Git LF/CRLF normalization warnings |
| Chromium media fixture E2E | `npm run test:e2e -- --reporter=dot` | PASS | 18/18, including the 16-test baseline plus anime-provider reference playback and credentialed live-HLS gateway playback; after the final episode-DTO redaction, the two new Anime/Live scenarios were rerun as a focused 2/2; expected auth-refresh and inspector diagnostics remain in logs |
| Real anime provider accounts | external sources | NOT RUN | No stable external account/feed fixture was supplied |
| Real public HLS/HTTP-FLV source | external source | NOT RUN | No stable external stream was supplied; Chromium fixture covers HLS, while real HTTP-FLV decode is not run because the fixture/browser environment does not provide a stable FLV live source |
| Docker/ffmpeg/live ingest | host tools | NOT RUN | Docker and ffmpeg are unavailable; managed ingest is deferred |

## Phase 3A typed manifest checkpoint

Phase 3A is **COMPLETE within the typed-manifest and browser-verification
boundary**. Phase 3B is complete as the optional, bounded single-node cache
described below.

- `backend/src/services/media/manifest/` now owns the typed HLS/DASH resource
  model, lifecycle classifier, URL/resource/depth bounds, safe XML parsing,
  and the HLS/MPD mapper. The old route-local rewrite implementation was
  removed; the exported route helper is a compatibility facade over the mapper.
- HLS roles include manifests, segments, parts, keys, init resources and
  auxiliaries. Key requests have a dedicated bounded full-proxy path. Master
  mapping preserves all variants and groups; it does not silently select a
  lower quality after a transport error.
- DASH covers nested and sibling BaseURL scope, SegmentTemplate/List/Base,
  initialization/index/bitstream-switching resources, Location, xlink,
  URL-valued UTCTiming, template path confinement, and DTD/entity rejection.
- Bilibili DASH candidates selected by Phase 2 exact quality/codec viability are
  represented by a sealed static MPD containing only the selected video and
  compatible audio tracks. Raw signed m4s URLs remain in the encrypted handle.

### Phase 3A validation

| Check | Command | Result | Evidence / limitation |
| --- | --- | ---: | --- |
| Backend lint/typecheck | `npm run lint -w backend` | PASS | TypeScript no-emit check |
| Backend tests | `npm test -w backend` | PASS with 1 skip | 90 passing, 1 Windows symlink-escape skip; room-grant tamper coverage is deterministic |
| Focused mapper tests | included in backend suite | PASS | HLS lifecycle/roles/bounds/recursion, DASH graph/security, Bilibili selected MPD |
| Frontend tests | `npm test -w frontend` | PASS | 9/9 |
| Frontend build | `npm run build -w frontend` | PASS | Existing MediaBunny dynamic-import and large-chunk warnings |
| Frontend lint | `npm run lint -w frontend` | BASELINE BLOCKED | Repository-wide existing formatting/vendor/compiler findings remain; no lint rule was weakened |
| Chromium targeted media E2E | `npx playwright test e2e/media-playback.spec.ts -g "real HLS master|credentialed Live HLS|HLS reattaches|real DASH nested|DASH reattaches|AES key CORS failure" --reporter=line --workers=1` | PASS | HLS, credentialed live HLS, HLS reconnect, nested DASH, DASH reconnect, and AES key assisted-proxy flows passed; Inspector/client-blocked diagnostics are intentional direct-source aborts |
| Frontend tests | `npm test -w frontend` | PASS | 9/9 |
| Full Chromium media E2E | `npx playwright test e2e/media-playback.spec.ts --reporter=line --workers=1` | PASS | 18/18; provider/storage flows, private-source authorization, mobile overflow, HLS/DASH, reconnect, and Bilibili-like MPD browser paths completed |
| Diff whitespace | `git diff --check` | PASS | Only Git's existing LF/CRLF normalization warnings were reported |

The backend, frontend, targeted browser flows, and full Chromium suite now all
pass within the Phase 3A boundary. The root fixture diagnostics are expected:
the E2E route intentionally aborts direct fixture requests with
`route.abort('blockedbyclient')` to prove the gateway fallback.

Phase 3B now adds an optional single-node memory Slice Cache behind the
authorized media-handle boundary. It is disabled by default and only admits
stable VOD binary resources. It uses fixed aligned 2 MiB slices, bounded LRU /
TTL storage, resource-wide validator identities, per-slice single-flight and
same-resource uncached fallback on cache failure. Manifests, keys, live/event
resources, conditional requests, multi-range and transformed responses bypass
the cache. See `slice-cache.md`.

### Phase 3B validation checkpoint

Phase 3B is **COMPLETE** within the optional single-node slice-cache boundary.
The focused suite covers cross-slice/open/suffix/full requests,
single-flight joins and cancellation, validator changes/disappearance,
conditional and resource-kind bypass, authorization/credential/generation
partitioning, invalid upstream 206/ignored Range fail-open, and LRU/TTL
bounds. Chromium additionally verifies the same authorized Range response in
cache-enabled MISS/HIT mode and cache-disabled Phase 3A mode.

| Check | Command | Result | Evidence / limitation |
| --- | --- | ---: | --- |
| Backend lint/typecheck | `npm run lint -w backend` | PASS | TypeScript no-emit check |
| Focused Phase 3B suite | `npm run build -w backend; node --test test/phase3b-slice-cache.test.js` | PASS | 8/8; Range, validators, single-flight, auth partitions, fail-open, LRU/TTL |
| Backend regression | `npm test -w backend` | PASS with 1 skip | 98 passing; 1 Windows symlink-escape environment skip |
| Frontend regression | `npm test -w frontend` | PASS | 9/9 |
| Frontend production build | `npm run build -w frontend` | PASS | Existing MediaBunny dynamic-import and large-chunk warnings remain |
| Full Chromium media E2E | `npx playwright test e2e/media-playback.spec.ts --reporter=line --workers=1` | PASS | Existing 18/18 Phase 3A flows pass |
| Cache-enabled Chromium E2E | `SLICE_CACHE_E2E=true SLICE_CACHE_ENABLED=true npx playwright test e2e/media-playback.spec.ts --grep "Phase 3B cache" --reporter=line --workers=1` | PASS | 1/1; upstream same-resource GET count is reduced from two to one |
| Cache-disabled Chromium E2E | `SLICE_CACHE_E2E=true SLICE_CACHE_ENABLED=false npx playwright test e2e/media-playback.spec.ts --grep "Phase 3B cache" --reporter=line --workers=1` | PASS | 1/1; same `206` response and two normal upstream GETs |
| Diff whitespace and reference boundary | `git diff --check`; `git diff --name-only -- references` | PASS | No reference files changed; only existing LF/CRLF normalization warnings |

### Phase 3 final status

**COMPLETE** within the approved Phase 3A/3B boundary: typed manifest
resources remain authorization-scoped; the cache is optional, bounded and
disabled by default; Range semantics and representation quality are unchanged;
validator changes purge resource slices; cache errors fall back to the same
uncached resource; and the full regression plus cache-enabled/disabled browser
checks are green.

### Phase 4A final status

**COMPLETE** within the player/subtitle boundary. Player source generations own
their abort, engine, listener, fetch, worker, MediaSource, object-URL, timer,
and subtitle lifetimes; stale callbacks cannot commit the active generation;
attach replacement is serialized; engine destruction is idempotent; and runtime
fallback preserves representation quality. External/provider/embedded subtitle
work carries generation and track identity, and bounded MKV Range extraction
stops on byte, request-count, timeout, or cancellation limits.

Verification on 2026-09-15: Backend 98 PASS / 1 Windows symlink environment
SKIP; Frontend 14/14 PASS; backend/frontend builds PASS; Chromium media 21 PASS
/ 1 intentional cache-gate SKIP in the default run, including 3 new Phase 4A
browser cases; Phase 3B cache enabled 1/1 PASS; cache disabled 1/1 PASS.

### Phase 4B Voice final status

**COMPLETE within the voice-local boundary.** Logged-in members use stable user
identity with guest socket identities, same-user replacement is generation-safe,
audio is bounded to the 48 kHz/960-sample contract, decoder and scheduled-source
lifetimes are isolated per peer, join/reconnect/leave cleanup is idempotent, and
the backend enforces ghost cleanup plus host/moderator mute/kick protections.
Full room permission convergence, host transfer, and RealtimeSyncCore were the
remaining Phase 5A work and are now closed within the single-node boundary.

Verification on 2026-09-15: Backend 102 PASS / 1 Windows symlink environment
SKIP; Frontend 18/18 PASS; frontend lint/build and backend lint PASS; the
fake-media Chromium voice join/reconnect/leave/unmount gate is included in the
final browser regression below.

### Phase 5A final status

**COMPLETE within the RealtimeSyncCore and Room Permission boundary.** Video
playback, readiness, subtitle state, reconnect snapshots, targeted control
requests, and host authority use one versioned, source-generation-bound
contract. Duplicate, stale, reordered, cross-generation, malformed, and
out-of-bounds realtime inputs are rejected. Room authorization is centralized
for playback, movie/subtitle changes, viewer management, host transfer, room
settings, and Voice mute/kick decisions. Host transfer is room-serialized and
transactional, with moderator cleanup, cache refresh, rollback, and immediate
old-host invalidation.

Verification on 2026-09-15: Backend 109 PASS / 1 Windows symlink environment
SKIP; Frontend 20/20 PASS; backend lint/build PASS; frontend build PASS;
Chromium 23 PASS / 1 intentional SKIP; Phase 5A realtime browser flow PASS;
Voice fake-media and Phase 4A browser regressions PASS. Frontend full ESLint
remains the pre-existing repository baseline failure and was not relaxed or
auto-fixed. Phase 3 cache checks remain the previously recorded PASS baseline.

The detailed contracts are in `realtime-sync-core.md`, `room-permissions.md`,
`music-sync-domain.md`, and `together-listen.md`. NCM and Phase 6
migration/release work remain intentionally open.

### Phase 5B-1 final status

**COMPLETE within the MusicSyncDomain, persistent queue, Together Listen, and
single-node realtime boundary.** Music has its own `musicGeneration`, version,
server timestamp, queue identity, current selection, play mode, playback state,
heartbeat, reconnect snapshot, host-offline fact, viewer control
request/response, and generation/version-bound track ACK. The shared
`RealtimeSyncCore` supplies ordering, deduplication, room locks, targeted
delivery, and disconnect cleanup through an independent music clock; it never
reads or mutates video state, `sourceGeneration`, readiness, subtitles, or the
current movie.

Queue items are persisted in the existing TypeORM/SQLite boundary with stable
generated IDs, normalized order, duplicate-track support, transaction-backed
add/remove/reorder/clear operations, and persisted current selection/play mode.
Position and playing state remain ephemeral across restart, so a restart does
not claim exact playback recovery. Queue source refs are opaque, bounded, and
provider-neutral; raw cookies, authorization headers, signed stream URLs, and
provider credentials are rejected and never stored.

The browser UI is a basic Together Listen panel using only deterministic local
`music://fixture/...` WAV sources. It exercises audio generation cleanup,
bounded drift correction, host controls, viewer requests, play modes, queue
selection/reorder/remove, and reconnect snapshot-first behavior. There is no
NCM login, cookie, search, playlist, album, FM, cloud, lyrics, comment, like,
or upstream music API in Phase 5B-1. Phase 5B-2 remains the explicit NCM
decision/review gate.

The historical blocked state is retained for auditability: the first full
Chromium run had one failure in the existing Voice fake-media test, and two
independent focused Voice runs failed before the music behavior was exercised.
The first genuinely missing event was the authenticated Socket.IO `connect`
after forced disconnect; no new `voice-join` followed. The test's old socket-ID
poll accepted a cleared ID as a false-positive reconnect signal. The underlying
cause was a stale pre-login auth refresh racing with login and marking the new
session expired; multiple `useSocket` consumers could then start competing
socket recovery. The minimal closure fix added session-generation guards to the
shared refresh path and one shared socket-auth recovery promise, and tightened
the test to require `socket.connected` plus a new non-empty ID. No Voice
protocol or UI source was changed, and Music did not remove Voice listeners or
resources. A build alone is not treated as behavioral proof.

### Phase 5B-1 verification

| Check | Command | Result | Evidence / limitation |
|---|---|---:|---|
| Backend typecheck | `npm run lint -w backend` | PASS | TypeScript no-emit check passes after the final queue deletion/rollback fix |
| Backend tests | `npm test -w backend` | PASS with 1 skip | 117 passing; Windows symlink-escape case skipped because this environment does not permit creating a symlink |
| Frontend tests | `npm test -w frontend` | PASS | 23/23, including 4 music authority/timing/lifecycle cases |
| Frontend production build | `npm run build -w frontend` | PASS | Existing MediaBunny dynamic-import and large-chunk warnings remain |
| Focused changed-file ESLint | `npx eslint src/hooks/useSocket.ts src/lib/api.ts src/modules/music src/modules/room/RoomPage.tsx src/modules/screen-sharing/components/WatchPage.tsx --ext ts,tsx --report-unused-disable-directives --max-warnings 0` (from `frontend`) | PASS | No findings in the changed frontend paths |
| Frontend full ESLint | `npm run lint -w frontend` | BASELINE BLOCKED | Existing repository/vendor findings remain; current run reported 6,731 problems, and no rule was weakened or full-tree auto-fix applied |
| Music Chromium E2E | `npx playwright test e2e/phase5b-music.spec.ts --reporter=line --workers=1` | PASS | 1/1; two viewers, duplicate queue identity, fixture readiness/Range, viewer request/host approval, switch ACKs, stale ended rejection, and reconnect snapshot |
| Full Chromium E2E | `npx playwright test --reporter=line --workers=1` | PASS | 24 passed, 1 intentional skip, 0 failed; video, cache, Phase 5A, Voice, and music cases completed naturally |
| Focused Voice regression — run 1/3 | `npx playwright test e2e/voice-lifecycle.spec.ts --reporter=line --workers=1` | PASS | Independent serialized run, 1/1 |
| Focused Voice regression — run 2/3 | `npx playwright test e2e/voice-lifecycle.spec.ts --reporter=line --workers=1` | PASS | Independent serialized run, 1/1 |
| Focused Voice regression — run 3/3 | `npx playwright test e2e/voice-lifecycle.spec.ts --reporter=line --workers=1` | PASS | Independent serialized run, 1/1 |
| Diff whitespace | `git diff --check` | PASS | Only Git's existing LF/CRLF normalization warnings were reported |
| Reference/dependency boundary | `git diff --name-only -- references`; manifest diff | PASS | No reference files changed; no package or lockfile drift |

### Phase 2 closure audit

- Target-2 provider registry rows are converged: storage, Emby/Jellyfin,
  Bilibili compatibility, AniSubs/Kazumi/anime, and public HLS/HTTP-FLV live
  sources all enter the common provider contract.
- Target-2 quality/security rows are converged: source generation and abort
  guards remain in the resolve/gateway path; public DTOs redact provider
  credentials; the client still owns final planning; transport fallback keeps
  representation identity.
- The remaining matrix items are explicitly Phase 3 manifest/resource typing,
  Phase 4 player lifetime hardening, Phase 5 product/realtime UX, managed live
  publishing, or Phase 6 migration/release work. They are not hidden as Phase
  2 provider gaps.

## Migration foundation boundary

- `backend/src/migrations/foundation.ts` inventories tables, distinguishes fresh
  and existing databases, runs TypeORM migrations only when explicitly enabled,
  and propagates failures so a retry cannot be mistaken for success.
- `backend/src/data-source.ts` keeps `synchronize: true` for compatibility during
  this foundation phase; `backend/src/index.ts` does not silently run migrations.
- The existing schema was not rewritten into a fabricated baseline migration.
  Phase 6 must add representative historical fixtures, backup/restore drills,
  interrupted-run tests, and the production switch to `synchronize: false`.
- `/app/config` remains the persistence boundary. Operators must back up that
  boundary before migration or key-management changes; automatic backup/rollback
  is a Phase 6 release-hardening requirement.

## Known environment limitations

- The declared Node dependency tree is restored from the lockfile.
- Docker CLI and ffmpeg are absent.
- The repository's local Node Playwright runner is installed and was used; no global Python Playwright runner was used.
- No local `synctv-app` source is available, so WebRTC peer, Service Worker range routing, IndexedDB piece caching, cancellation, and browser fallback behavior cannot be audited from implementation.
- Extracted ZViewer and SyncTV folders lack Git metadata; exact local reference commit identity is unresolved.
- Network-dependent provider behavior was not exhaustively exercised with real user credentials; the local fixture-based media, security, and browser suites passed.

## Deferred or rejected features

- DEFER PostgreSQL until SQLite contention, durability, or operational requirements justify a migration.
- DEFER Redis until multi-process coordination or shared ephemeral state becomes real.
- DEFER WebRTC P2P implementation until the missing client implementation is available and privacy, abuse, cancellation, fallback, and browser range behavior can be tested end to end.
- DEFER WHIP/WHEP/external WHEP and RTMP ingestion until TongMu has a concrete live-publishing use case.
- REJECT gRPC/cross-node relay, cluster fencing, Kubernetes, and Helm for the present single-node product.
- REJECT server-owned final `PlaybackPlan`, silent quality downgrade, public credentials, and direct copying of Rust implementations or unverified upstream assets.

## Unresolved questions

1. Which commit or release produced each extracted reference directory? Preserve commit metadata or a provenance manifest for future snapshots.
2. Which legacy providers are actively used in production and therefore determine the provider-convergence migration order?
3. What compatibility window is required for old public routes and DTOs while providers move to the new Media Core?
4. Which license applies to the absent `synctv-app` snapshot, and can its client-side P2P implementation be reviewed and adapted later?
5. Which historical updater repository/artifact names must remain accepted during product-name normalization? Phase 1 keeps old artifact aliases but rejects the ZViewer repository as an update source.
6. Are user-blocking/privacy and playback-history features product requirements for V2 or post-V2 candidates?

## Documentation produced and updated

- `upstream-adoption-matrix.md`
- `provider-compatibility.md`
- `target-architecture.md`
- `implementation-plan.md`
- `upstream-notes-zviewer.md`
- `upstream-notes-synctv.md`
- `manifest-resource-model.md`
- `progress.md`
- `player-lifecycle.md`

Phase 1 updated `progress.md`, `upstream-adoption-matrix.md`, and
`implementation-plan.md` with the implementation status and phase boundary.
`upstream-notes-zviewer.md` and `upstream-notes-synctv.md` were not modified.
