# Phase 2 provider compatibility ledger

This ledger is intentionally explicit about the boundary reached in Phase 2.
The new provider contract is live for the core resolver family, while the
remaining route-specific source families are temporary adapters/gaps. They are
not counted as converged merely because they can still play media.

## Converged through the Media Core entrypoint

| Provider | Registry id | Current boundary | Credential owner | Lifecycle |
| --- | --- | --- | --- | --- |
| Bilibili BV/AV/short links | `bilibili` | `MediaProvider` via `LegacyResolverAdapter`; private descriptor and candidate facts | current viewer, optional | request cancellation/deadline checks; no provider session cleanup yet |
| Public or signed direct URL | `direct-url` | `MediaProvider` via `LegacyResolverAdapter`; bounded probe and candidate generation | none | request cancellation/deadline checks |
| Generic web page | `generic-web` | `MediaProvider` via `LegacyResolverAdapter`; Safe Fetch HTML discovery and probe | none | request cancellation/deadline checks; browser-independent |
| BrowserResolver | `browser` | `MediaProvider` via `LegacyResolverAdapter`; BrowserResolver remains the opt-in fallback | current viewer only when supplied privately | bounded browser slot and cleanup; request checks at provider boundary |

The adapter is a compatibility layer around the existing resolver implementation.
It does not copy credentials into `ProviderContext`, does not return a
`PlaybackPlan`, and does not make the room DTO a provider-private object.

## Temporary adapters / remaining convergence work

The following families still have route-specific contracts and must not be
described as Phase 2-complete:

| Source family | Current state | Required next step |
| --- | --- | --- |
| WebDAV | legacy storage/range route | implement provider descriptor/candidate adapter and preserve server-only mount credentials |
| FTP | legacy stream/browser route | implement provider adapter with seek capability and bounded cleanup |
| OpenList/Alist | specialized listing/playback service | map direct/proxy/refresh choices into provider candidates without a server planner |
| Emby/Jellyfin | legacy play URLs and client APIs | map direct-play/transcode/session lifecycle and profile filtering into the common contract |
| Local/server files | shared ByteRange is complete, provider contract is not | add traversal-safe `LocalFile` provider and opaque grants |
| AniSubs/Kazumi/anime sources | scraping/catalog routes | move extraction behind Safe Fetch and private-source redaction |
| Live HLS/HTTP-FLV | player-specific live paths | add live provider candidates, refresh, disconnect and generation cleanup |

Until those migrations land, `backend/src/routes/*` for these families remains
the documented temporary compatibility surface. New playback resolution must
enter `frontend/src/modules/media/mediaApi.ts`; no new UI route should invent a
second playback planner or publish provider credentials.

## Contract invariants

- `PlaybackClientProfileV1` is request-scoped, versioned, bounded, and treated
  as untrusted input.
- The server viability filter removes impossible or unsafe candidates only. It
  never selects a final engine or constructs a `PlaybackPlan`.
- The browser `localPlanner` selects the first viable same-quality candidate
  for its own feature set. An empty V1 capability list means no support.
- `PrivateMediaSource`, credentials, and credential provenance remain server
  private. Room state shares descriptor facts/source generation and opaque
  handles, not a host browser's plan.
- Bilibili requested, actual, source-maximum, and available-maximum quality
  remain distinct. CDN fallback may change origin, never representation quality.

