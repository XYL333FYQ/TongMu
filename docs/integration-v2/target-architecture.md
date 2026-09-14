# TongMu V2 target architecture

> Phase 0 architecture contract. This document describes the intended end state; it does not authorize product-code changes by itself.

## Non-negotiable invariants

1. TongMu is the product and source of truth. ZViewer and SyncTV are references, not merge bases.
2. Original Quality First. A transport/CDN failure may select another transport or CDN for the same representation, but may not silently select a lower quality.
3. Direct First; Proxy as Fallback. Proxying is a viability mechanism, not a default ownership transfer to the server.
4. Credentials, upstream authorization headers, raw provider URLs with secrets, and mount secrets remain server-private.
5. A room shares media facts (`MediaDescriptor` plus source generation), not one browser's `PlaybackPlan`.
6. The server rejects impossible or unsafe routes; the receiving client chooses the best remaining route.
7. `/app/config` remains the persistent data boundary. BrowserResolver, Chromium/Playwright, and adequate shared memory remain part of the browser-enabled Docker entrypoint.
8. Existing database/API names may need compatibility aliases. Product renaming must never strand existing data or clients.

## Media Core

```text
User input / persisted source reference
                  |
                  v
        Provider / Resolver Registry
        | validate | normalize | resolve
                  |
                  v
          PrivateMediaSource                 server only
   (raw URL, credentials, headers, owner)
                  |
          probe + representation selection
                  |
                  v
            MediaDescriptor                  public media facts
 (protocol, container, codecs, quality, expiry,
  subtitles, live/DRM facts; no credentials)
                  |
                  v
          PlaybackCandidate[]                same representation routes
   DIRECT -> MANIFEST_ASSISTED -> PARTIAL_PROXY -> FULL_PROXY
                  |
                  v
       PlaybackClientProfile                 request scoped, versioned
                  |
                  v
    Server viability / security filter
 (credential exposure, CORS/mixed content, codec/container/transport,
  room grant, source generation, expiry, provider availability)
                  |
        viable candidates + public facts
                  |
                  v
          Client Local Planner               per browser/device
                  |
                  v
             PlaybackPlan                    client-owned decision
                  |
                  v
             Player Engine
 native | hls.js | dash.js | flv.js | playsvideo/remux
```

### Ownership boundary

| Layer | Owns | Must not own |
| --- | --- | --- |
| Provider/resolver | Provider parsing, credential lookup, upstream representation discovery, provider-specific availability and refresh | Browser-specific final engine choice |
| `PrivateMediaSource` | Raw input, resolved upstream URLs, Cookie/Authorization/custom headers, credential owner and origin scope | Public DTO fields |
| Probe | Bounded content/transport facts and confidence | Permanent quality downgrade |
| `MediaDescriptor` | Shareable media facts and quality identity | Raw credentials, unrestricted headers, private URLs |
| Candidate builder | Same-representation transport alternatives and opaque handles | Cross-quality fallback disguised as transport fallback |
| `PlaybackClientProfile` | Versioned browser/runtime capabilities and policy constraints | Provider credentials or user preferences unrelated to viability |
| Server viability filter | Remove unsafe/impossible candidates; explain why | Select the final `PlaybackPlan` for every participant |
| Local Planner | Rank viable candidates and choose engine for this client | Mutate shared room media facts |
| Player engine | Attach, play, switch same-quality transport, clean up | Persist room truth or silently change quality |

### Public/private DTO rule

The server may know `input`, `originalUrl`, final signed URLs, Cookies, Authorization, Referer/Origin, provider API keys, mount passwords, file paths and credential-owner IDs. The browser receives only redacted facts and opaque, scoped handles. A harmless public direct URL may be published only after URL query and header inspection. Every nested error/metadata object passes recursive redaction before serialization or logging.

`PlaybackClientProfile` V1 should include `profileVersion`, environment, supported transport/container/video/audio codec tuples, exact RFC 6381 codec strings where available, pipeline (`native`, `mse`, `managed-mse`), custom-header support, proxy support, insecure-HTTP viability, maximum bitrate/channels, subtitle preference, live transports and optional P2P support. Empty capabilities in a current-version profile mean no support, not “unknown.” An absent/legacy profile gets conservative compatibility defaults.

### Room media state

The room owns:

- stable movie/source identity;
- public `MediaDescriptor` and quality identity;
- monotonically increasing `sourceGeneration`;
- authoritative playback state (`paused`, `position`, `rate`, `updatedAt`, sequence/version);
- a scoped room-media grant bound to room, participant/session, source generation and expiry.

Each client independently owns its viable candidate list, selected candidate, engine, object URLs, workers, buffers and retry state. On source generation change, every in-flight resolve/attach result from an older generation is discarded and cleaned up.

## Provider architecture

Create one registry contract rather than more route-specific playback islands:

```text
MediaProvider<Input, PrivateSource>
  name / sourceKinds / availability
  validateInput(context, input)
  normalizeInput(input)
  resolve(context, input, requestedQuality)
  credentialDependencies(context, input)
  refresh?(context, privateSource)
  cleanup?(context, sourceGeneration)
  browse/search/dynamicPlaylist?        optional capabilities
```

`ProviderContext` carries actor kind (user/guest/system), room/movie/source generation, credential owner policy, cancellation/deadline, safe-fetch service and client profile. It never makes provider-specific credentials generic DTO fields. WebDAV, FTP, OpenList, Emby, Jellyfin, server files, AniSubs/Kazumi/anime and live sources must enter this contract incrementally while legacy routes remain compatibility adapters until their contract tests pass.

Provider verification occurs before persistence and again when resolving time-sensitive resources. Credential dependencies are explicit so logout/rotation can invalidate affected descriptors without generic room code parsing provider-specific JSON.

## RealtimeSyncCore

```text
RealtimeSyncCore
|-- identity/session binding
|-- authoritative host lease and reconnect grace
|-- monotonically increasing seq/version
|-- snapshot store + get-state
|-- heartbeat and updatedAt validation
|-- sourceGeneration race guard
|-- permission decision + targeted request/response
|-- join/reconnect/unload cleanup
|
|-- VideoSyncDomain
|   |-- movie/source identity and descriptor grant
|   |-- play/pause/seek/rate state
|   |-- player-ready/source-generation ACK
|   `-- subtitle track/state synchronization
|
`-- MusicSyncDomain
    |-- persistent ordered queue
    |-- current track, position and play mode
    |-- host heartbeat / viewer drift correction
    |-- viewer control request / host response
    `-- viewer switch ACK and host-offline behavior
```

The Core owns ordering, identity, lease, snapshot, timing and permission mechanics. Video owns movies, player readiness and subtitle coupling. Music owns queue semantics, audio element lifecycle and play modes. Neither domain copies the other's state model; both use the same tested event envelope and stale-message rules.

Delay compensation advances a playing snapshot by a bounded `now - updatedAt`. It rejects negative or implausibly large clock deltas and corrects only beyond a drift threshold. Server sequence/version is the primary stale-write guard; wall-clock time is not an ordering primitive.

## Permissions

Use one decision service for HTTP and realtime actions. Roles are owner, root, admin, moderator, user and guest. Guest identity is an explicit actor kind; never equate `userId=0` with a stored user. The matrix covers movie add/manage, music queue, playback controls, kick, mute/unmute, host transfer and moderator appointment.

Hard invariants override configuration: root cannot be targeted; a moderator cannot act on owner/root/another moderator; moderator appointment/dismissal and host transfer require owner/root authority; moderator count is bounded; a transferred host is removed from the moderator list. Cache invalidation is part of every role/session mutation.

## Secret storage and authentication

- Replace reversible Base64 credential storage with versioned authenticated encryption (AES-256-GCM or platform secret provider), unique nonce per record, key supplied or generated into protected `/app/config` state.
- Never expose a raw provider cookie endpoint. UI uses status/profile DTOs and explicit login/logout/refresh commands.
- Continue strong generated JWT secrets and separate access/refresh expiry. Token-revocation lookup must not fail open during cache warm-up.
- Apply rate limits by bounded endpoint category and authenticated/user/IP identity; proxy and resolver endpoints have stricter budgets.
- Validate CORS from an explicit allowlist. HTTP bearer compatibility may remain, but production documentation should prefer HTTPS HttpOnly cookies.
- Encrypt movie/source secrets and mount credentials with independently versioned keys; plan key rotation and unreadable-record behavior.

## Range and cache

One shared `ByteRange` parser serves every local file and proxy route:

```text
Explicit(start,end) | OpenEnded(start) | Suffix(length) | MultiRange | Invalid
```

Resolve bounds only after total length is known. Invalid/unsatisfiable requests return `416` and `Content-Range: bytes */TOTAL` when total is known. Single ranges return exact `206`; no-range returns `200`; multi-range initially bypasses safely to an upstream that implements it or returns a deliberate unsupported response, never a silently altered single range.

Phase 2 may add an optional single-node slice cache: URL + credential-scope hash + slice index keys, fixed slices, per-key single-flight locks, validated `Content-Range`, ETag/Last-Modified consistency, HEAD metadata with Range-GET fallback, bounded metadata/locks, TTL/LRU watermarks and fail-open passthrough. Cache failure must not change representation quality or weaken SSRF policy.

## HLS and DASH

HLS rewriting uses typed roles: Manifest, Segment, Part, Key, Init and Auxiliary. It classifies Master, Live, Event and VOD lifecycles, rewrites both URI lines and quoted `URI`, preserves rendition relationships, separates key authorization, revalidates every fetched child URL and enforces manifest byte and URL-count limits. Quality filtering may select a declared representation only at explicit resolution time; transport retry never edits quality.

DASH rewriting parses XML and applies BaseURL inheritance at MPD/Period/AdaptationSet/Representation levels. It handles `SegmentTemplate` (`media`, `initialization`, `bitstreamSwitching`), `SegmentList`/`SegmentURL` (`media`, `index`), `SegmentBase`, `Initialization`, `RepresentationIndex`, `BitstreamSwitching`, `Location`, `UTCTiming` and xlink URLs. Template tokens and formatting such as `$Number%05d$` remain literal. Multiple sibling BaseURLs remain siblings, not a chained path. Every rewritten resource is bound to a signed scope and revalidated.

## Player engines and subtitles

All engines implement `attach`, `destroy`, readiness/error signals and an abortable lifecycle. A serialized attach queue plus mount/source generation prevents obsolete async work from attaching. Cleanup removes event listeners, aborts fetches/scans, revokes object URLs, ends MediaSource streams when valid, terminates/releases workers, closes decoders and disposes remux state. Switching candidates keeps playback time/rate/pause intent and changes only transport for the same representation.

Native/HLS/DASH/FLV remain first-class. playsvideo/remux is an explicit compatibility engine; no default video transcode is introduced. Shared WASM worker pooling is considered only if the actual library exposes safe acquire/release and fatal recovery contracts—the audited ZViewer snapshot no longer contains the older ffmpeg.wasm engine.

Subtitle Core normalizes SRT, ASS/SSA, VTT, SMI/SUB and embedded text tracks into one cue model. MKV extraction remains browser-side and abortable: small-file streaming, large-file sparse Cues/cluster scans, bounded concurrency, incremental flush and seek priority. Track identity, not start time alone, participates in dedupe. Bitmap subtitles are reported unsupported unless a real decoder is added. Offset/font/position are local presentation settings; selected track/timing facts are synchronized and late joiners receive a current snapshot.

## Voice

Voice identity is user-based for logged-in users and connection-based for guests. A reconnect replaces the same user's stale connection. Capture and playback contexts use explicit 48 kHz with 960-sample Opus frames; codec descriptions are byte-deduplicated and receivers may bootstrap with a no-description fallback. Pending scheduled buffer sources, encoders/decoders, tracks, nodes and contexts are all stopped on leave, failure, reconnect and unmount. A periodic membership reconciliation removes ghosts. Server enforcement covers mute/kick, cooldowns, root/owner/moderator protection and drops audio/config from muted senders.

## Live and P2P extension points

Single-node live V1 may expose provider-resolved HLS and HTTP-FLV through the same descriptor/candidate/filter/planner chain. External RTMP pull or WHIP/WHEP is DEFER until there is a real publishing requirement and lifecycle budget. If adopted, every publisher/viewer session is generation-bound, authorized, abortable and cleaned when no active guard remains.

P2P remains an optional candidate capability, not a replacement for Direct/Proxy fallback. A provider creates an opaque swarm ID from byte-equivalent resource identity; a short-lived ticket binds room, actor, source generation and resource owner. Peer candidates are bounded and signaling validates both endpoints' current room/swarm membership. The reference contains server signaling only; no web Service Worker/IndexedDB piece implementation was available to audit, so client P2P stays DEFER.

## Database evolution

TypeORM `synchronize` is removed from production only after a schema baseline and migration harness exist. The migration path is:

1. snapshot every existing entity/index/default and create a baseline marker for existing databases;
2. make every V2 change an idempotent, reversible-or-recoverable migration;
3. test empty install plus upgrades from representative historical SQLite/sql.js fixtures;
4. back up `/app/config` before migration and fail without partially advancing version;
5. keep compatibility reads/writes during data-shape transitions, then remove them in a later release.

SQLite remains the default. PostgreSQL/Redis are not prerequisites for this architecture.

## Updater, packaging and CI

Release artifacts have canonical TongMu names plus temporary compatibility aliases for existing `zviewer-*` consumers. The updater verifies checksum/signature before extraction, rejects traversal/symlinks outside staging, stages atomically, preserves config and has rollback instructions. `.env`, databases, secrets, logs, tests and `references/` never enter artifacts.

CI separates reusable build outputs from tests, uses concurrency with stale-run cancellation, and publishes immutable version tags before updating `latest`. Required gates cover backend typecheck/tests, frontend tests/build, media protocol and security contracts, browser E2E, migration upgrade fixtures, archive inventory, checksum verification and `docker compose config` for both entrypoints.

## Observability

Adopt structured, redacted events with a request/source-generation correlation ID. HTTP metrics use matched route templates, status class, latency and response bytes; labels never include room/movie/user IDs, URLs or provider error strings. Media metrics use bounded enums for resolver, transport, engine, outcome and error class. Logs and metrics never include raw URLs with secrets, credentials, grants or authorization headers.

