# TongMu V2 implementation plan

This is an execution plan ordered by safety and dependency, not a feature wish list. Each phase must update `progress.md` and the adoption matrix. Phase 1 has now been implemented within the boundary below; the migration/release work listed in Phase 6 is intentionally not implied by that completion.

## Phase 1 — P0 security and protocol correctness

**Goal**

Restore a reproducible baseline, close credential exposure and token-revocation
defects, establish correct byte-range semantics, and leave a tested migration and
release-safety foundation before expanding the architecture.

**Why now**

`GET /api/stream/bilibili/cookie` returned a raw provider cookie, Bilibili
credential “encryption” was Base64, token revocation could fail open on a cold
cache/read error, and the shared local parser interpreted `bytes=-N` as bytes
`0..N`. WebDAV had a second inconsistent parser that could turn invalid,
multi-range, or unsatisfiable requests into a full or clamped response. These are
security/correctness foundations for every later provider.

**Dependencies**

- The existing `config/` persistence boundary and a documented operator backup expectation.
- A versioned credential-encryption key location under the configured `/app/config` boundary.
- A read-old/write-new compatibility path for existing Base64 credential rows.

**Files/modules affected**

- `backend/src/routes/stream/bilibili-auth.ts`
- `backend/src/services/bilibili/credential.ts`
- `backend/src/services/secret-vault.ts`
- `backend/src/services/proxy/{byte-range,range-stream,http-proxy}.ts`
- `backend/src/services/webdav.ts`
- `backend/src/middleware/auth.ts`
- `backend/src/migrations/foundation.ts`, `backend/src/data-source.ts`, `backend/src/index.ts`
- all Range-serving routes and `backend/test/*`
- `backend/src/services/updater/*`, updater route, and `.github/workflows/*`
- focused frontend Bilibili account files

**Upstream references**

- SyncTV `synctv-proxy/src/slice_cache/range.rs`, `range_tests.rs`
- SyncTV `synctv-media-providers/src/credential/{encryption,storage,types}.rs`
- TongMu's stronger `backend/src/services/media/handles.ts` AES-GCM pattern

Only the explicitly listed upstream reference files were used for semantic
comparison; no recursive reference-tree re-audit was performed.

**Required tests**

- Raw cookie is absent from every public/status/login response.
- Existing credential migration, new authenticated encryption, tamper/wrong-key behavior and logout.
- Explicit/open-ended/suffix/invalid/multi/empty/overflow/unsatisfiable Range table across local file, WebDAV and gateway.
- Exact `200/206/416`, `Content-Length`, `Content-Range`, HEAD and upstream-ignores-Range behavior.
- Redaction regression tests for nested errors/logs.
- Cold-cache/concurrent/revoked-token/database-failure authorization behavior.
- Fresh/existing migration detection, retry after failure, updater source safety,
  and CI concurrency configuration.

**Exit criteria**

- No public API returns provider credentials.
- No secret record is newly stored as Base64/plain text.
- One parser defines Range semantics everywhere; all table tests pass.
- The declared dependency baseline and relevant browser checks are reproducible.
- Migration foundation detects fresh/existing databases and propagates failures;
  production `synchronize:false` remains a Phase 6 gate pending historical fixtures.

**Major risks**

- Locking users out if old rows cannot be migrated.
- Breaking `<video>` seeking with subtly wrong 206 headers.
- Treating multi-range as single-range and corrupting consumers.

**Phase 2 implementation checkpoint**

- Core implemented: `PlaybackClientProfileV1` validation/fingerprint and real
  browser feature collection; server-only viability filtering; client-owned
  local planning; provider context/registry/credential-dependency contract.
- Core resolver adapters now cover Bilibili, direct URL, generic web,
  BrowserResolver, storage, Emby/Jellyfin, AniSubs/Kazumi/anime, and public
  HLS/HTTP-FLV live inputs. Catalog routes and managed live ingest remain
  compatibility/deferred surfaces. See `provider-compatibility.md`.
- Phase 2 exit criteria are complete within this provider-convergence scope;
  Phase 3 manifest/resource typing and Phase 6 migration/release gates remain
  separate.

**Phase 1 implementation status**

- Complete: dependency restoration, SecretVault V1, legacy Bilibili read-old/write-new migration, raw-cookie removal, recursive redaction, fail-closed token revocation, shared ByteRange and upstream response validation, migration foundation, updater source stopgap, and CI/release concurrency stopgap.
- Deliberately deferred: provider/profile convergence, HLS/DASH rewrite, Slice Cache, player/voice/realtime work, historical migration fixtures, `synchronize:false`, updater integrity/signatures/rollback, and canonical artifact renaming.

## Phase 2 — Media Core contract completion and provider convergence

**Goal**

Add `PlaybackClientProfile` and server viability filtering while keeping `PlaybackPlan` client-owned; migrate the remaining legacy source families behind the Provider/PrivateMediaSource/Descriptor/Candidate chain.

**Why now**

The new core protects all currently playable source families. Catalog/listing
routes remain provider-specific by design, while playback enters the common
contract so later player and security work has one source boundary.

**Dependencies**

- Phase 1 Range and secret contract.
- Versioned public DTO compatibility rules.

**Files/modules affected**

- `backend/src/services/media/{types,protocol,planner,candidates,probe,handles,room-access}.ts`
- `backend/src/services/media/resolvers/*`
- `backend/src/routes/{webdav,ftp,openlist,emby,jellyfin,serverFiles,kazumi,animeSources}.ts`
- `frontend/src/modules/media/{mediaApi,localPlanner,transport}.ts`
- provider browser/push panels as adapters, without redesigning UI

**Upstream references**

- SyncTV `synctv-core/src/provider/{traits,context,playback_profile,playback_transport}.rs`
- SyncTV provider implementations for Alist/Emby/DirectURL and `credential_dependencies`
- TongMu `docs/media-core.md`

**Required tests**

- Profile version/default/empty capabilities; codec+container must match in the same capability tuple.
- Server removes impossible/mixed-content/credential-leaking candidates but never selects the final plan.
- Every source family resolves to a redacted descriptor and same-quality candidates.
- Direct→assisted→partial→full fallback retains requested/actual/maximum quality identity.
- Room grant binds membership, session, source generation and expiry.
- Existing provider UI flows remain behaviorally compatible.

**Exit criteria**

- No playable source bypasses the public/private media contract except a documented temporary adapter.
- `mediaApi` is the one playback-resolution entrypoint.
- Room state contains facts, never a host browser's engine plan.
- Legacy endpoints have removal/compatibility dates and contract coverage.

**Major risks**

- Credentialed mounts accidentally becoming public URLs.
- Server profile filtering becoming a disguised server planner.
- Provider migration changing existing UX or route compatibility.

## Phase 3 — Manifest, proxy and optional single-node slice cache

Slice Cache starts in this phase only. It is explicitly outside Phase 3A; Phase 1
provides the Range and upstream-validation contract that Phase 3B may rely on.

Current checkpoint: **Phase 3A is COMPLETE within the typed-manifest and
browser-verification boundary. Phase 3B is COMPLETE as an opt-in bounded
single-node memory cache; the Phase 6 migration/release gate remains open.**

**Goal**

Phase 3A makes HLS/DASH resource mapping complete and typed. Phase 3B may then
add a bounded cache only where it materially reduces repeated proxy traffic.

**Why now**

Before this checkpoint, HLS rewriting was broadly functional but untyped and
lacked a URL-count ceiling. The Phase 3A mapper now types HLS roles/lifecycle,
adds byte/resource/depth bounds, and covers the complete scoped DASH graph,
including `SegmentBase`, `RepresentationIndex`, `BitstreamSwitching`,
`Location`, xlink and URL-valued timing. Caching before URL, authorization and
Range correctness would amplify bad responses.

**Dependencies**

- Phase 1 shared Range semantics.
- Phase 2 provider-scoped handles and viability filter.

**Files/modules affected**

- `backend/src/routes/stream/media.ts`
- `backend/src/services/proxy/{safe-fetch,http-proxy,range-stream}.ts`
- `backend/src/services/media/manifest/{model,mapper,bilibili}.ts`
- the existing sealed media handle and gateway routes
- `backend/src/services/proxy/slice-cache.ts` implements the optional bounded
  memory store, validators, single-flight and fail-open slice assembly
- media protocol and E2E fixtures

**Upstream references**

- SyncTV `synctv-proxy/src/{manifest,mpd}.rs`
- SyncTV `synctv-proxy/src/slice_cache/*`
- SyncTV proxy integration and slice-cache tests

**Required tests**

- HLS Master/Live/Event/VOD; line URIs and quoted URI; audio/subtitle/variant/key/init/part/auxiliary; relative, absolute and redirected children; byte, URL and recursion limits.
- DASH nested/sibling BaseURL, Template formatting tokens, List, SegmentBase, init/index/bitstream switching, Location/xlink, timing URL handling and hostile traversal/scope escapes.
- Bilibili selected-representation-only MPD construction without lower-quality or unsupported codec reintroduction.
- Cross-origin sensitive-header stripping for every child fetch.
- Phase 3B cache hit/miss/single-flight, HEAD fallback, upstream 200/206/416,
  ETag/Last-Modified changes, If-Range/conditionals, cancellation, eviction,
  corruption and fail-open passthrough are covered by the focused backend
  suite and the cache-enabled/disabled Chromium fixture check.

**Exit criteria**

- Every emitted manifest URL has a typed authorization path.
- Unsupported constructs fail clearly or pass through safely; none are half-rewritten.
- Phase 3A: every emitted manifest URL has a typed authorization path; unsupported constructs fail clearly or pass through safely; proxy never changes quality.
- Phase 3B: cache can be disabled, remains authorization-safe, preserves
  Range semantics and cache failure preserves uncached playback.
- Proxy never changes quality.

**Major risks**

- Breaking live refresh/query-token propagation.
- Cross-origin key/header leakage.
- Serving slices from different upstream object versions.

## Phase 4 — Player, subtitle and voice lifecycle hardening

**Goal**

Eliminate stale source attachment and leaked media resources; bring voice identity, reconnect and moderation to the current ZViewer behavior without replacing TongMu transport planning.

**Why now**

Once descriptors/candidates are stable, client lifecycle behavior can be tested against one source-generation contract. ZViewer contains concrete race and cleanup fixes; TongMu voice is materially behind it.

**Dependencies**

- Phase 2 source generation/profile contract.
- Phase 3 manifest behavior for HLS/DASH engines.

**Files/modules affected**

- `frontend/src/modules/player/engines/*`
- `frontend/src/modules/player/hooks/usePlayerSource.ts`
- `frontend/src/modules/room/watch-together/usePlayerRemountKey.ts`
- `frontend/src/modules/subtitles/mkv-embedded.ts`
- `frontend/src/modules/voice-chat/hooks/useVoiceChat.ts`
- `backend/src/modules/voice-chat/voice-chat.handler.ts`
- voice/member/permission DTOs and tests

**Upstream references**

- ZViewer `usePlayerSource.ts`, `usePlayerRemountKey.ts`, direct/HLS/FLV/DASH/playsvideo engines
- ZViewer `mkv-embedded.ts`, `useSubtitles.ts`, `SubtitleOverlay.tsx`
- ZViewer voice hook and handler

**Required tests**

- Rapid A→B→A source switches, unmount during resolve/attach, failed attach fallback and engine destroy idempotence.
- MediaSource/Worker/fetch/object-URL cleanup and no obsolete attach.
- Small/large MKV, sparse scan, abort/seek priority, multi-track dedupe, late join and unsupported bitmap tracks.
- Voice fixed 48 kHz/960 frames, description dedupe/fallback, join failure, reconnect replacement/rejoin, ghost sweep, scheduled-source cleanup, mute/kick protections.
- Real mobile narrow viewports, safe area, portrait and coarse-pointer paths.

**Exit criteria**

- Resource/lifecycle instrumentation returns to baseline after repeated switches/leaves.
- Stale generations cannot change the active player or subtitle state.
- Logged-in voice membership uses real user identity; no duplicate/ghost member survives reconciliation.

**Major risks**

- Browser/WebCodecs differences and autoplay policy.
- Over-eager cleanup stopping the current generation.
- Porting upstream player code over TongMu's stronger transport layer.

## Phase 5 — RealtimeSyncCore, permissions and Together Listen

**Goal**

Extract shared realtime invariants, upgrade the room permission model, then add Together Listen as a separate domain on that core.

**Why now**

Copying the music module first would duplicate old socket assumptions. Identity, sequence, reconnect, grants and permissions must be shared before music becomes a second synchronized media domain.

**Dependencies**

- Phase 1 credential security.
- Phase 2 descriptor/grant/source-generation contract.
- Phase 4 stable audio/player cleanup.

**Files/modules affected**

- `backend/src/modules/room/*`, `sync-playback/*`, `playback-memory/*`
- new `RealtimeSyncCore`, `VideoSyncDomain`, `MusicSyncDomain`
- room/SystemSettings entities plus migrations
- new music entities/routes/services and `frontend/src/modules/music/*`

**Upstream references**

- ZViewer `MusicSyncHandler.ts`, `useListenTogether.ts`, music store/context/pages/components
- ZViewer room permission, session and viewer-management handlers
- SyncTV room permission and playback-history models for concepts only

**Required tests**

- Sequence/version ordering, duplicate/stale events, reconnect snapshot, host lease/disconnect, get-state, clock-skew bounds and source-generation ACK.
- Full role/action matrix including guest, root protection, moderator anti-escalation/count and transfer-host invariants.
- Queue transactional ordering/upsert/remove/reorder/clear, persistence/restart, play modes and host-offline behavior.
- Viewer control request/response and switch ACK targeting.
- NCM QR/login/search/playlist/album/artist/liked/FM/cloud/comments/like/lyrics/stream behavior through private credentials and audio descriptors.
- Requested vs actual music quality is explicit; no silent quality downgrade.

**Exit criteria**

- Video and Music share only the tested realtime core.
- All actions call one permission service.
- Raw NCM credentials never reach browser DTOs/logs; provider status remains usable.
- Queue and sync recover after reconnect/restart within documented limits.

**Major risks**

- NCM upstream/API terms and dependency provenance.
- Music quality fallback violating Original Quality First.
- Database/state migration and socket compatibility.

## Phase 6 — historical migrations, packaging, CI and measured extensions

**Goal**

Complete the migration/release gate left by Phase 1 so V2 is safely
upgradeable/releasable; add observability; decide live/P2P only from measured
needs.

**Why now**

V2 is not complete if it only works on a clean development database or cannot produce trustworthy artifacts. Infrastructure-heavy features should be considered after the core is measurable.

**Dependencies**

- Data shapes from Phases 1–5 are settled, and Phase 1's migration harness is available.
- Representative historical databases and packaging hosts are available.
- Config backups and restore validation are available before any production schema change.

**Files/modules affected**

- `backend/src/data-source.ts`, `backend/src/migrations/*`, historical database fixtures
- `backend/src/services/updater/*`, `backend/src/routes/updater.ts`
- `scripts/build-*.js`, Dockerfiles, `docker-compose.yml`, `.github/workflows/*`
- logging/metrics middleware
- `THIRD-PARTY-NOTICES.md`

**Upstream references**

- SyncTV migration/cleanup, structured logging, matched-route metrics, provider session lifecycle and live/P2P contracts
- Existing TongMu browser-enabled Docker and release scripts

**Required tests**

- Empty install and upgrade fixtures from supported historical schemas; backup/failure/retry.
- Production `synchronize:false` startup with a proven ordered migration chain; no
  fabricated baseline is accepted for an unrepresented historical schema.
- Windows/Linux single-file and Docker smoke tests; asset/wasm/browser inventory.
- Updater checksum/signature, traversal, interrupted update, rollback and config preservation.
- CI concurrency, immutable release provenance, and no stale-run latest overwrite.
- Redacted structured logs, request/source correlation, bounded-label metrics and response-byte accounting.

**Exit criteria**

- Production starts with `synchronize: false` and a proven migration chain.
- Artifacts use TongMu canonical names with documented compatibility aliases.
- Release/update artifacts are integrity-checked and reproducible enough to trace.
- `THIRD-PARTY-NOTICES.md` covers every copied/adapted code and bundled asset.
- Live/P2P decisions are updated from DEFER only with an approved user need and client-source audit.

**Major risks**

- Historical schema variance.
- Breaking installed updater consumers through naming changes.
- Adding metrics cardinality or logging secrets.
