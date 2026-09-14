# Phase 2 provider compatibility ledger

This ledger is intentionally explicit about the boundary reached in Phase 2C-1.
The common provider contract now owns playback resolution for the four storage
families plus Emby and Jellyfin. Anime/catalog and live source families remain
temporary adapters/gaps and are not counted as converged merely because they can
still play media.

## Converged through the Media Core entrypoint

| Provider | Registry id | Current boundary | Credential owner | Lifecycle |
| --- | --- | --- | --- | --- |
| Bilibili BV/AV/short links | `bilibili` | `MediaProvider` via `LegacyResolverAdapter`; private descriptor and candidate facts | current viewer, optional | request cancellation/deadline checks; no provider session cleanup yet |
| Public or signed direct URL | `direct-url` | `MediaProvider` via `LegacyResolverAdapter`; bounded probe and candidate generation | none | request cancellation/deadline checks |
| Generic web page | `generic-web` | `MediaProvider` via `LegacyResolverAdapter`; Safe Fetch HTML discovery and probe | none | request cancellation/deadline checks; browser-independent |
| BrowserResolver | `browser` | `MediaProvider` via `LegacyResolverAdapter`; BrowserResolver remains the opt-in fallback | current viewer only when supplied privately | bounded browser slot and cleanup; request checks at provider boundary |
| Local/server files | `local-file` | `storage://` reference -> `LocalFileProvider` -> descriptor plus opaque scoped gateway candidate | current authenticated actor; filesystem root stays server-private | realpath containment, stale-file validator, request-scoped handle and source-generation binding |
| WebDAV | `webdav` | `WebDavProvider` -> public direct candidate only for an anonymous safe target, otherwise scoped gateway/proxy | saved mount owner; password remains server-private | AbortSignal/deadline reaches stat/fetch; configured private-mount boundary; shared ByteRange policy |
| FTP | `ftp` | `FtpProvider` -> no browser direct candidate; scoped HTTP media gateway | saved mount owner; password remains server-private | REST seek capability is represented; socket/client/stream close on abort, timeout and disconnect |
| OpenList/Alist | `openlist` | `OpenListProvider` -> visibility-classified temporary direct candidate or scoped proxy candidate | saved mount owner/source creator; API credential remains server-private | expiry is descriptor data and refresh is provider re-resolution; API cancellation and token cache remain server-side |
| Emby | `emby` | stable `provider://emby` reference -> `EmbyProvider` -> private source, descriptor, candidates, viability, client planner | saved mount owner; API key/password remain server-private | provider start/progress/stop/cleanup through bounded generation-bound lifecycle; legacy facade retained |
| Jellyfin | `jellyfin` | stable `provider://jellyfin` reference -> `JellyfinProvider` -> private source, descriptor, candidates, viability, client planner | saved mount owner; API key/password remain server-private | provider start/progress/stop/cleanup through bounded generation-bound lifecycle; legacy facade retained |

The storage rows and the two media-server rows are native providers under the
common contract; `LegacyResolverAdapter` remains only for the older
Bilibili/direct/generic-web/BrowserResolver families. None of these paths copy credentials into
`ProviderContext`, return a `PlaybackPlan`, or make the room DTO a
provider-private object.

## Storage legacy compatibility ledger

The browse and mount-management APIs remain provider-specific. New playback
resolution from the current frontend is a compatibility facade into
`POST /api/stream/media/resolve` and the scoped `GET /api/stream/media/:id`
gateway. The legacy routes remain available for old records and browse-era
clients during the removal window; they are not the new frontend playback
entrypoint and must not create a second server-side `PlaybackPlan`.

| Provider | Browse/manage routes retained | Legacy playback routes retained | New Media Core entrypoint | Direct/proxy policy | Range / compatibility status |
| --- | --- | --- | --- | --- | --- |
| Local/server files | `/api/server-files/roots`, `/browse`, `/upload`, `/folder`, `/rename`, `/file` | `/resolve`, `HEAD /proxy`, `GET /proxy` | `storage://local-file` + `LocalFileProvider` | opaque authorized gateway; never `file://` | shared ByteRange, realpath/symlink boundary, old proxy remains for old records |
| WebDAV | `/api/webdav/mounts`, `/mounts/:id/browse`, `/resolve` | `/proxy`, `/direct-url`, `/stream` | `storage://webdav` + `WebDavProvider` | safe anonymous public direct only; credentialed/private mounts use gateway | existing WebDAV ByteRange/proxy validation; old routes remain compatibility surfaces |
| FTP | `/api/ftp/mounts`, `/mounts/:id/browse`, `/resolve` | `/proxy`, `/stream` | `storage://ftp` + `FtpProvider` | gateway only; no fake `ftp://` browser candidate | seek-capable REST reader when available; honest no-seek metadata; old routes retained |
| OpenList/Alist | `/api/openlist/mounts`, `/mounts/:id/browse`, `/search` | `/resolve`, `/direct-url`, `/proxy`, `/stream` | `storage://openlist` + `OpenListProvider` | short-lived bearer URL only when public-target policy allows; otherwise gateway | provider fetch/expiry/refresh semantics; old routes retained |
| Emby | `/api/emby/mounts`, `/mounts/:id/browse`, `/resolve` | `/proxy`, `/stream` and old resolve facade | `provider://emby` + `EmbyProvider` via `mediaApi` | provider credentials are never published; current frontend uses scoped Media Core gateway candidates | old routes remain for old records/browse-era clients; removal requires record migration and no consumers |
| Jellyfin | `/api/jellyfin/mounts`, `/mounts/:id/browse`, `/resolve` | `/proxy`, `/stream` and old resolve facade | `provider://jellyfin` + `JellyfinProvider` via `mediaApi` | provider credentials are never published; current frontend uses scoped Media Core gateway candidates | old routes remain for old records/browse-era clients; removal requires record migration and no consumers |

Removal condition for each legacy playback route: all stored records have been
re-resolved through Media Core, the compatibility facade has had a documented
release window, and the old route has no remaining frontend or API consumers.

## Temporary adapters / remaining convergence work

The following families still have route-specific contracts and must not be
described as Phase 2-complete:

| Source family | Current state | Required next step |
| --- | --- | --- |
| AniSubs/Kazumi/anime sources | scraping/catalog routes | move extraction behind Safe Fetch and private-source redaction |
| Live HLS/HTTP-FLV | player-specific live paths | add live provider candidates, refresh, disconnect and generation cleanup |

Until those migrations land, `backend/src/routes/*` for the remaining families
is the documented temporary compatibility surface. New playback resolution
must enter `frontend/src/modules/media/mediaApi.ts`; no new UI route should
invent a second playback planner or publish provider credentials.

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
- Emby and Jellyfin direct play, same-quality direct stream/remux, and
  quality-changing transcode are separate candidate facts. Provider transcode
  candidates are emitted only for an explicit opt-in request; the default
  resolver never silently lowers video quality for an unsupported codec.
- Media-server sessions are sealed as opaque capabilities. The host player
  binds them to actor, room/movie, provider, media source, and source
  generation; progress is non-authoritative and cleanup is bounded,
  idempotent, best effort, and stale-generation aware.
- Existing Emby/Jellyfin movie rows are accepted through `media-movie:<id>`
  compatibility refresh and upgraded to stable provider references after a
  successful resolution. Temporary stream URLs are not persisted as the new
  identity.
