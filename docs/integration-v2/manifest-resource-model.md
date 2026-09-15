# TongMu V2 manifest resource model

Phase 3A introduces a typed manifest mapper for HLS and DASH. It does not
implement Slice Cache. The mapper creates resource facts while the existing
AES-GCM media handle remains the only public capability format.

## Resource identity and authorization

`backend/src/services/media/manifest/model.ts` defines the protocol-specific
resource kinds and the mapping contract. A mapped resource carries:

- protocol and resource kind;
- upstream URL and parent/root source identity;
- recursive depth and representation identity where applicable;
- scope, source generation and expiry through the existing sealed handle;
- request headers and credential-origin policy server-side only;
- Range permission and a future cache-policy hint.

The browser receives only an opaque `/api/stream/media/:id` capability (or the
typed DASH template `/asset` route). `resolveMediaHandle` checks actor/room
scope and expiry; `authorizedResource` additionally requires the emitted
`sourceGeneration`. Child handles inherit the root scope, root identity,
generation, expiry, provider policy and private headers. A child cannot change
its sealed kind into a key, manifest or arbitrary segment.

`headersForTarget` keeps sensitive headers only for recorded credential origins.
Cross-origin Cookie, Authorization, token and API-key headers are stripped;
Safe Fetch still owns redirect and SSRF validation.

## HLS

`HlsResourceKind` is `Manifest`, `Segment`, `Part`, `Key`, `Init` or
`Auxiliary`. `HlsPlaylistKind` classifies `Master`, `LiveMedia`, `EventMedia`
and `VodMedia` from playlist tags rather than the file name.

The mapper handles ordinary URI lines and the supported URI-bearing tags:
variant, audio/subtitle and iframe/image playlists, session data, keys,
session keys, maps, parts, preload hints and rendition reports. It resolves
relative, root-relative, protocol-relative, absolute, query-only and encoded
URLs against the final upstream manifest URL. Unknown URI-bearing tags are
typed as `Auxiliary`; malformed or unsafe URLs fail the whole mapping instead
of returning a partially rewritten private manifest.

The route keeps the existing 4 MiB manifest byte bound and adds a 1,000-resource
bound plus a depth bound of four. Keys use a dedicated typed handle, a 1 MiB
body bound, `no-store/no-transform`, no Range, and forced full proxy mode.
Partial/assisted mode may retain public same-representation media children, but
private manifests and keys remain gateway resources. The mapper does not select
the highest HLS variant: representation selection remains outside resource
mapping, so transport failure cannot silently select a lower variant.

## DASH / MPD

`DashResourceKind` covers `Manifest`, `Media`, `Initialization`, `Index`,
`BitstreamSwitching`, `Timing`, `Auxiliary`, `BaseURL` and
`RecursiveManifest`.

The XML mapper uses `@xmldom/xmldom`, rejects DTD/entity/notation input, and
resolves the first sibling `BaseURL` at each MPD/Period/AdaptationSet/
Representation scope. It materializes inherited `SegmentTemplate` and
`SegmentList` state per Representation so sibling BaseURL scopes do not leak.
It preserves DASH substitution tokens including `$Number%05d$`, `$Time$`,
`$RepresentationID$`, `$Bandwidth$` and `$$`.

Typed resources are emitted for template media/initialization/
bitstream-switching targets, SegmentList media/index/initialization targets,
SegmentBase initialization/index ranges, BaseURL file/directory scopes,
`Location`, namespaced xlink hrefs, and URL-valued `UTCTiming`. Direct timestamp
timing values remain unchanged. DASH templates are constrained to their sealed
asset path and same origin; BaseURL descendants use the dedicated `/base`
route with the same path boundary.

## Bilibili selected MPD

Bilibili's provider returns one already selected video m4s and compatible audio
m4s, not an upstream MPD. For DASH candidates, the route builds a sealed
static MPD containing only that selected video representation and compatible
audio representation, with SegmentBase/BaseURL facts. The raw signed CDN URLs
remain inside the encrypted handle and are converted to typed `dash-media`
resources by the same mapper. Phase 2 exact quality and RFC6381 audio/video
tuple filtering therefore remains authoritative; no lower-quality or
unsupported representation is reintroduced.

## Compatibility and Phase 3B boundary

The exported `rewriteManifest` helper in `routes/stream/media.ts` is retained
for old callers, but delegates to the typed mapper. The live `/media/:id` route
uses the typed mapper directly; the old route-local HLS/DASH implementation was
removed. Existing client/player URLs remain compatible with the opaque gateway
contract.

The optional Phase 3B Slice Cache consumes `future-slice-cache` only after this
resource identity and authorization path has succeeded. It admits only the
documented VOD binary kinds; manifests, keys, live/event resources, conditional
requests and multi-range requests bypass it. See `slice-cache.md` for the
validator, partition, single-flight, bounded-storage and fail-open contract.
