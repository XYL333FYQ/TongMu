# SyncTV upstream notes

## Audit identity and translation rule

- Audited local snapshot: `references/synctv-main/synctv-main` (1,983 files).
- The snapshot has no `.git`, so its exact commit cannot be proven locally. Cargo workspace version is `1.0.4`; `git ls-remote` on 2026-09-13 reported upstream HEAD `7f3e625b4ecad588bc1c7d773ffb337661cac95d`. The hash identifies the then-current remote head, not necessarily the extracted snapshot.
- License: MIT, copyright 2026 SyncTV Contributors. TongMu's existing `THIRD-PARTY-NOTICES.md` already carries the SyncTV MIT text; future substantial adaptations must keep source/commit notes.
- Translation rule: copy design semantics and tests into TypeScript interfaces/modules. Do not copy Rust structure, PostgreSQL/Redis assumptions, gRPC DTO layers or cluster runtime merely because they exist.

## PlaybackClientProfile

### Source map

- `synctv-core/src/provider/playback_profile.rs`: `CURRENT_PLAYBACK_CLIENT_PROFILE_VERSION`, `PlaybackClientProfile`, `PlaybackMediaCapability`, enum families, matching and `cache_fingerprint`.
- `synctv-proto/proto/client.proto`: wire validation, field numbers and maximum 64 media capabilities.
- `synctv-api-common/src/impls/client/convert.rs`: protobuf/domain conversion and version validation.
- Provider consumers: `synctv-core/src/provider/{bilibili,alist,emby,live_proxy}.rs`.

### Semantics

Profile version 2 describes request-scoped runtime capability rather than a provider-specific “device profile.” It includes:

- environment (`Native`/`Web`), stream preference and subtitle preference;
- maximum streaming bitrate and audio channels;
- broad video codec/container/audio capability lists;
- supported live transports (HLS/FLV/WHEP);
- precise capability tuples: transport + container + video codec + audio codec + pipeline + optional RFC 6381 codec string;
- ability to send custom upstream headers, use provider proxy and load insecure HTTP media.

The important bug-prevention detail is tuple matching: MP4/H.264 and WebM/VP9 in different capabilities must not imply MP4/VP9. Exact codec-string matching is tokenized/case-insensitive. Current-version empty `media_capabilities` means no media support. A sorted, complete fingerprint partitions provider playback caches so one browser's codec answer is not reused for another.

### TongMu translation

Add a small shared TS schema and runtime validator. Browser capability collection belongs in `frontend/src/modules/media`; the server accepts only bounded/known values. The profile is an input to a **viability/security filter**, not to a server-side final planner:

```text
descriptor candidates
  -> reject unsafe/impossible for profile
  -> return remaining facts/candidates
  -> localPlanner ranks them on the receiving client
```

Do not adopt SyncTV's provider-chosen `default_mode` as the shared room truth. Keep TongMu's client-owned `PlaybackPlan`.

## Provider architecture

### Source map

- `synctv-core/src/provider/traits.rs`: `MediaProvider`, `DynamicPlaylistProvider`, `ProviderPlaybackSessionLifecycle`, `ProviderCredentialDependency`, `PlaybackResult`, `PlaybackInfo`.
- `synctv-core/src/provider/context.rs`: `ProviderContext`, `ProviderActor`, `ProviderCredentialPolicy`.
- `synctv-core/src/service/providers_manager.rs`: registry/manager.
- `synctv-core/src/service/remote_provider_manager/*`: remote instance routing/health/validation; mostly not for TongMu.
- Implementations: `synctv-core/src/provider/{direct_url,alist,emby,bilibili,live_proxy,rtmp,...}.rs`.
- HTTP resource authorization: `synctv-api-common/src/playback_provider/common.rs` and provider siblings.

### Valuable contracts

`MediaProvider.generate_playback` is the provider-owned boundary for source parsing, upstream route generation, headers, subtitles and lifecycle metadata. `validate_source_config` runs before persistence; `prepare_source_config` normalizes; `credential_dependencies` tells generic code which user's provider credential affects a resource without parsing provider JSON; optional casts expose dynamic playlist, live danmaku and playback-session lifecycle capabilities.

`ProviderContext` separates actor (`System`, `User`, `Guest`) from credential owner. Shared resources may intentionally use creator credentials while ordinary requests use viewer credentials. Context also carries room/media/playlist ID, provider instance, playback generation, cancellation/deadline and client profile. `ProviderPlaybackSessionLifecycle.progress/cleanup` closes provider sessions/transcodes when generation changes.

TongMu should adapt these interfaces around `PrivateMediaSource` and preserve opaque handles. It should not return raw provider `PlaybackInfo` objects with headers/URLs as public state. Remote provider instances, Redis stores and gRPC transports are separate infrastructure and remain deferred.

## Range model

### Source map

- `synctv-proxy/src/slice_cache/range.rs`: `ClientRangePlan`, `ClientRangeError`, parsers/bounds/Content-Range.
- `synctv-proxy/src/slice_cache/range_tests.rs`: explicit, open-ended, suffix, multi, invalid, clamp, zero/overflow/416 cases.
- `synctv-proxy/src/slice_cache/filter.rs`: client-range routing and `RangeNotSatisfiable` mapping.

### Semantics

The parser distinguishes `Explicit {start,end}`, `OpenEnded {start}`, `Suffix {suffix_len}` and `MultiRange` before a total size is known. `range_bounds_for_total` then clamps only an explicit end beyond EOF, maps a long suffix to the whole resource, and rejects start beyond EOF/zero-size resources as unsatisfiable. Invalid syntax and unsatisfiable ranges are separate error categories so `416` can include `bytes */TOTAL`.

Multi-range is not silently collapsed. The slice cache bypasses it before the single-slice path; the origin or a dedicated multipart implementation must own the result.

### TongMu gap and adaptation

`backend/src/services/proxy/range-stream.ts` currently parses `bytes=-500` as start zero/end 500. `backend/src/services/webdav.ts` has a separate parser that can return a full/clamped response for invalid, multi or unsatisfiable input. Port the model and its table tests into one TypeScript module used by all local/proxy routes. Preserve upstream 200 only where a no-range/full request permits it; do not fabricate a partial response from an unvalidated body.

## Slice cache

### Source map

- `synctv-proxy/src/slice_cache/mod.rs`: design overview and public API.
- `config.rs`, `types.rs`, `status.rs`: size/TTL/backend and HIT/MISS/BYPASS/EXPIRED/STALE/UPDATING/REVALIDATED states.
- `range.rs`, `filter.rs`, `head.rs`, `passthrough.rs`: routing, HEAD and origin behavior.
- `keys.rs`: URL + sorted provider headers + slice/full/meta domain-separated SHA-256 keys.
- `etag.rs`, `store.rs`: validators, per-key locking, stale revalidation and invalidation.
- `backend/{memory,file}.rs`, `lifecycle.rs`, `maintenance.rs`: bounded storage and eviction.
- `*_tests.rs`, `synctv-proxy/tests/proxy_integration_tests.rs`: concurrency, corruption, lifecycle and proxy contracts.

### Why it is designed this way

- Fixed (default 2 MiB) aligned slices make seek requests reusable without caching a whole movie.
- URL plus sorted provider headers prevents authenticated variants from sharing bytes. TongMu should use a credential-scope identifier/HMAC rather than placing raw secret header values into observable keys.
- Per-key async locks plus double-check prevent a thundering herd from downloading one missing slice repeatedly. Lock and metadata maps have explicit cleanup bounds.
- HEAD metadata is cached; if HEAD fails or omits length, `Range: bytes=0-0` discovers total size. A 200 response to that probe is a valid complete response and may be streamed, not mislabeled 206.
- Each 206 must have a matching `Content-Range`, total length and exact body size. A short slice is valid only at resource end.
- The first ETag (or Last-Modified fallback) establishes resource identity. Change/disappearance invalidates every slice so bytes from two object generations cannot be combined.
- Conditional requests refresh TTL on 304. Stale-while-revalidate can preserve playback under a bounded window while one updater runs.
- Memory/file backends track actual byte use, TTL and LRU/watermark eviction. File headers are length/time bounded and startup loaders tolerate corrupt entries.
- Cache-disabled, unsupported-range, multi-range and failures have explicit passthrough behavior. Cache is an optimization, never a prerequisite.

### TongMu adaptation

Start only after shared Range and provider-scoped authorization are correct. Implement an optional single-process cache behind the existing safe-fetch/handle boundary. Use cancellation, a maximum response/slice size, ETag consistency and deterministic status diagnostics. Do not adopt gRPC cache service, Redis coordination or shared filesystem assumptions.

## HLS mapper

### Source map

- `synctv-proxy/src/manifest.rs`: `HlsResourceKind`, `HlsPlaylistKind`, `classify_hls_playlist`, `rewrite_m3u8_with_typed_url_mapper`, `MAX_M3U8_URLS`.
- Provider transport callers in `synctv-core/src/provider/playback_transport.rs` and `synctv-api-common/src/playback_provider/*`.

### Semantics

Typed resources distinguish Manifest, Segment, low-latency Part, Key, Init and Auxiliary. URI lines following `EXT-X-STREAM-INF` become manifests; tag attributes classify `EXT-X-MEDIA`, I-frame/image playlists, rendition reports, keys/session keys, map/preload map, parts/preload parts and metadata. Playlist lifecycle is Master, LiveMedia, EventMedia or VodMedia using master tags, `PLAYLIST-TYPE` and `ENDLIST`.

Relative URLs resolve against the manifest source. Quoted `URI` is rewritten without naïvely splitting commas inside quotes. Proxy bases containing CR/LF are rejected. A default 1,000-URL ceiling limits resource/memory amplification; over-limit VOD output is terminated explicitly. Child transport logic strips sensitive headers on cross-origin changes.

TongMu already rewrites URI lines and quoted attributes, but lacks this typed contract and URL-count bound. Adapt types and test vectors, retaining TongMu's byte limit and Safe Fetch on every child/redirect. Verify variant/audio/subtitle linkage before retaining `highestHlsMaster` filtering.

## MPD mapper

### Source map

- `synctv-proxy/src/mpd.rs`: `MpdResourceKind`, `rewrite_mpd_with_url_mapper`, element context stack, URL attribute classification and tests.

### Semantics

The streaming XML mapper tracks inherited and descendant BaseURL per element. The first sibling BaseURL determines descendant resolution, while every sibling is rewritten independently—`primary/` and `backup/` do not become `primary/backup/`. If the root has no BaseURL, it inserts a proxy scope for the manifest directory.

It rewrites:

- `SegmentTemplate` media/initialization/bitstreamSwitching;
- `SegmentURL` media/index;
- `Initialization`, `RepresentationIndex`, `BitstreamSwitching` sourceURL;
- `Location` as a manifest resource;
- `UTCTiming` value and namespace-qualified xlink href;
- BaseURL text at nested MPD/Period/AdaptationSet/Representation levels.

Safe relative templates stay relative under the rewritten BaseURL so `$RepresentationID$`, `$Number$` and formatted `$Number%05d$` survive. Absolute/dynamic paths receive a proxy scope. Repeated percent decoding detects traversal/backslash/path escapes in downstream transport validation.

TongMu handles BaseURL, SegmentTemplate and SegmentList basics, but lacks complete typed coverage for SegmentBase-related init/index, bitstream switching, Location and xlink. Adapt the stack semantics and tests; do not regex-copy Rust XML handling.

## Bilibili

### Source map

- Upstream API/parsing: `synctv-media-providers/src/bilibili/{client,types,service,client_tests}.rs`.
- Provider integration: `synctv-core/src/provider/bilibili.rs`.
- Transport authorization: `synctv-api-common/src/playback_provider/bilibili.rs`.

### Valuable behavior

The VOD DASH request uses `qn=127` and `fnval=4048`, parses ordinary/Dolby/FLAC audio, preserves `base_url` plus `backup_url` candidates and retains actual upstream quality/codec metadata. It can merge regular and HEVC responses into one manifest, group codec families into stable adaptation sets and filter exact codec strings using `PlaybackClientProfile`. Cache keys include a codec-route schema/profile fingerprint. If all video or audio representations are filtered out, it reports a capability-specific error instead of returning an unusable manifest.

CDN backups are server-side alternatives for the same representation. This matches TongMu's rule that CDN fallback is not a quality downgrade. Profile filtering is codec viability, also orthogonal to quality. Live results collect/sort quality and codec choices and expose HLS/FLV according to profile.

### TongMu comparison

TongMu is stronger in several places and must stay authoritative:

- explicit `requestedQuality`, `actualQuality`, `maximumQuality` and refusal to silently downgrade on transport failure;
- private credential/public descriptor boundary;
- direct-first same-representation candidates and client Local Planner;
- BrowserResolver and Safe Fetch.

Adapt exact codec-tuple filtering, stable DASH grouping, profile-partitioned caches and backup-candidate tests. Do not adopt provider `default_mode` as room state or weaken TongMu quality semantics. SyncTV's broad provider features do not replace TongMu's WBI/BV/av/b23/bili2233 UX checks; keep tests for those inputs.

## Live media

### Source map

- `synctv-core/src/provider/rtmp.rs`: managed RTMP source -> HLS/HTTP-FLV/WHEP routes.
- `synctv-core/src/provider/live_proxy.rs`: validated external RTMP/HTTP-FLV/WHEP sources and profile-driven defaults.
- `synctv-livestream/src/*`: publisher/pull/stream generation and active-viewer guards.
- `synctv-api-http/src/http/livestream_webrtc.rs`: WHIP/WHEP create/delete session resources.
- `synctv-xiu/src/webrtc/*`: media WebRTC plumbing.

### Design semantics

Managed RTMP and external live pulls are distinct providers. External protocol/URL is validated; WHEP Authorization is length/value bounded. HLS, FLV and WHEP are separate media routes. Publisher/viewer sessions expose explicit create/delete lifecycles. The tracker uses generation IDs and guards: FLV viewers hold a streaming guard, HLS requests touch activity, and teardown waits for publisher/viewer inactivity rather than assuming one request equals a stream lifetime.

### Decision for TongMu

- ADAPT ordinary provider-resolved live HLS/HTTP-FLV into the existing descriptor/candidate/planner path.
- DEFER managed RTMP ingest and external pull until a real single-node publishing requirement exists.
- DEFER WHIP/WHEP until browser/relay operational requirements and cleanup tests are funded.
- REJECT cluster relays/gRPC cross-node stream transport for the current single-node product.

## P2P media

### Source map

- `synctv-core/src/provider/p2p_media.rs`: opaque provider/resource `swarm_id` from a domain-separated SHA-256 identity.
- `synctv-api-common/src/impls/messaging/media_swarm_tracker.rs`: room+swarm membership, 90-second TTL, max 16 peer suggestions, optional Redis.
- `synctv-api-common/src/impls/messaging/webrtc.rs`: ticket, room/swarm/source-generation/recipient validation, SDP/ICE size limits and private ICE filtering.
- `synctv-realtime/tests/webrtc_*`, `room_hub_tests.rs`: signaling delivery, timeout and cleanup races.

Providers, not proxy URLs, define byte-equivalent resource identity. Swarm tickets bind public room, actor, swarm, playback generation and optionally resource owner. Both signaling endpoints must currently be in the same room and swarm. Connections are bounded to a small number of active swarms, candidates are bounded, memberships expire and stale generation/resource ownership revokes access.

No `synctv-app` source exists in `references/`. `git ls-remote` found a remote head (`c18c737aa0ee5e9e1194b3762c66ba73e6d5d5e2` on 2026-09-13), but the Web client implementation was not audited. Therefore Service Worker Range routing, IndexedDB/piece caching, cancellation and direct/proxy fallback behavior are unknown and must not be inferred from the server or README. Keep a `P2P_CANDIDATE` extension point and DEFER implementation until client source is pinned and audited.

## Logging and metrics

### Source map

- `synctv-core/src/logging.rs`: component routing, text/JSON, non-blocking bounded buffers, rotation/retention and dropped-line counters.
- `synctv-api-http/src/http/metrics_middleware.rs`: matched-route request metrics.
- `synctv-core/src/metrics/{http,stream,livestream,remote_transport,logging}.rs`.
- `synctv-api-common/src/request_context.rs`, `synctv-api-grpc/src/grpc_support.rs`: request ID context.
- `docs/src/content/docs/en/operations/observability.mdx`: operational signals.

The strongest portable idea is bounded cardinality: HTTP metrics label the matched route template (`/items/{item_id}`), never the actual private ID. Status, duration and in-flight requests are recorded; relay error types are a closed classification rather than arbitrary error strings. Non-blocking logging exposes dropped-line counts and supports component-specific sinks/levels without inheriting secret diagnostic spans into compact access logs.

The audited HTTP metrics middleware does not record response bytes, and HTTP request-ID propagation is not as obvious/complete as the gRPC mapping. TongMu should not claim those features were found; it should add its own response-byte accounting and request/source-generation correlation IDs. Redaction and bounded labels are mandatory.

## Other useful capabilities

- Playback history: `synctv-core/src/models/playback.rs`, `repository/playback_history.rs`, cleanup retention/count limits and `ViewPlaybackHistory` permission. Adapt only if TongMu has a product need; make retention/privacy explicit.
- User blocking and visibility: service/repository filtering hides blocked users/messages and revokes guest access after room visibility changes. Useful later, but separate from Media Core.
- Recoverable lifecycle: room/account deletion is soft and cleanup-retained. The principle fits TongMu's recoverable-data preference; the PostgreSQL implementation does not.
- Cooperative cancellation: `ExecutionControl` passes deadlines/cancellation from request to provider/proxy instead of only wrapping an outer future. Adapt for BrowserResolver, manifests and player-facing resolves.
- Security headers and rate-limit categories are well scoped, but CSP must be tailored to TongMu's actual media/browser assets.
- Provider implementation contracts and proto boundary tests show the value of validating every mode/auxiliary URL and keeping DTO limits.

## Infrastructure not to migrate now

| Capability | Decision | Reason | Reconsider when |
| --- | --- | --- | --- |
| PostgreSQL default | REJECT | TongMu's single-node SQLite deployment and `/app/config` recovery are simpler | Concurrent multi-writer/storage limits are measured and migrations are mature |
| Redis requirement | REJECT | Adds an availability dependency for state that can remain local/persistent | More than one active TongMu backend must share leases/cache/realtime |
| gRPC internal APIs | REJECT | Duplicates Express/Socket.IO contracts without current consumers | A separately deployed trusted provider/relay service is approved |
| Cluster/cross-node relay | DEFER | Complex fencing, dedupe, catch-up and failure modes; no current need | Horizontal scaling becomes a real deployment target |
| Kubernetes/Helm | REJECT | Operational surface exceeds a single-node/self-hosted product need | Supported enterprise orchestration becomes a product requirement |
| Multi-node fencing | DEFER | Meaningless without multi-writer leaders/nodes | Cluster mode is designed first |
| Remote provider process | DEFER | Local providers are easier to secure/debug | Isolation or independent scaling has a measured benefit |
| Full SyncTV permission/account platform | REJECT | Would replace product identity and greatly expand scope | Never by default; evaluate individual semantics only |

## License and provenance

SyncTV code is MIT, but its documentation logos/screenshots, generated protobuf code, provider protocol schemas and any fixtures may have separate provenance. No SyncTV assets or binaries are approved for direct migration by this audit. For each adapted implementation, record source path plus pinned source revision, preserve the MIT notice for substantial portions and document the TypeScript rewrite. Generated/bundled files should be regenerated from a licensed source or avoided. Keep `references/**` out of TongMu Git.

