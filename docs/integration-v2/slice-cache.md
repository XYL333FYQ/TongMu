# TongMu V2 Phase 3B single-node slice cache

Phase 3B adds an optional in-memory optimization behind the existing media
handle and HTTP proxy boundaries. It is not a public cache endpoint and it is
not a second authorization mechanism. A request must first pass
`authorizedResource`, including actor/room, expiry and `sourceGeneration`
checks, before the route supplies a cache context.

## Configuration and defaults

The cache is disabled by default. Set `SLICE_CACHE_ENABLED=true` to opt in.
The safe defaults are:

| Setting | Default | Purpose |
| --- | ---: | --- |
| `SLICE_CACHE_SLICE_BYTES` | 2 MiB | Fixed aligned slice size |
| `SLICE_CACHE_MAX_BYTES` | 128 MiB | Hard total byte bound |
| `SLICE_CACHE_MAX_RESOURCES` | 256 | Metadata/resource bound |
| `SLICE_CACHE_MAX_SLICES` | 4,096 | Global slice bound |
| `SLICE_CACHE_MAX_SLICES_PER_RESOURCE` | 256 | Prevent one resource dominating the store |
| `SLICE_CACHE_MAX_IN_FLIGHT` | 64 | Shared metadata/fetch operation bound |
| `SLICE_CACHE_MAX_REQUEST_SLICES` | 128 | Per-request amplification bound |
| `SLICE_CACHE_TTL_MS` | 30,000 | Metadata and slice freshness |
| `SLICE_CACHE_UPSTREAM_TIMEOUT_MS` | 30,000 | Header/body fetch timeout |

`MemorySliceCacheStore` is deliberately process-local. There is no Redis,
SQLite blob cache, disk cache, public `/cache/:hash` route, or cross-node
coordination. The store uses insertion-order maps as bounded LRU indexes,
evicts expired entries, and evicts the least recently used slice when byte,
slice, resource, or per-resource limits are reached.

## Eligibility

The route passes `future-slice-cache` only for resources that have already
been typed and authorized. The default allowlist is:

- ordinary `media` binary gateway resources;
- VOD HLS `hls-segment` resources;
- VOD DASH `dash-media` resources;
- `dash-base` single-file resources.

Manifests, HLS keys, HLS Parts, initialization/index/auxiliary/timing
resources, recursive manifests, HTTP-FLV, provider sessions, live/event/
unknown-lifecycle resources, multi-range requests and conditional requests
bypass the slice cache. HLS lifecycle classification is carried from the
Phase 3A mapper into the sealed child handle. Dynamic DASH MPDs are treated as
live. Keys retain the existing bounded full-proxy `no-store` path.

The cache does not participate in representation, codec, qn, or quality
selection. A miss or cache error requests the same URL and same request
headers through the existing proxy.

## Cache identity and authorization partition

The byte identity is separate from authorization identity. The SHA-256 cache
key domain includes:

- a canonical resource/root identity and upstream URL;
- resource kind and representation identity;
- source generation and authorized scope;
- credential origins and all effective upstream request headers except Range
  and conditional headers;
- target policy and trusted-private host scope.

Raw URLs, cookies, Authorization values, provider tokens, or other sensitive
header values are never used as observable keys or logs; they are only inputs
to the final one-way digest. Room viewers can share a cache entry only when
the sealed scope and credential/header partition are the same. A different
actor, mount owner, credential, cookie, or source generation gets a different
partition. The cache is queried only after media-handle authorization, so a
cache hit cannot grant access to an expired handle or stale room member.

## Range and streaming behavior

The existing `ByteRange` parser remains the only client Range parser. Explicit,
open-ended, suffix and EOF ranges are resolved against the discovered total
size. The aligned upstream request is:

```text
sliceStart = floor(byteOffset / 2 MiB) * 2 MiB
Range: bytes=sliceStart-sliceEnd
```

The response is assembled slice-by-slice with backpressure. It is never
assembled into a full-file buffer. The client still receives the original
semantic response: `200` for a full request, or `206` with exact
`Content-Range` and `Content-Length` for a single range. Multi-range bypasses
the cache and remains owned by the normal upstream path; no fake multipart
response is generated. A stale/unsatisfiable request is allowed to fall back
so the existing `416` handling remains authoritative.

HEAD metadata is used first for total size, range support, content type and
validators. If HEAD is unavailable or incomplete, one bounded `Range: bytes=0-0`
probe is allowed. A probe answered with `200` does not prove range support and
is not admitted as a slice.

## Validators and object versions

Metadata is resource-wide, never per-slice. The validator priority is:

1. strong ETag plus total length;
2. `Last-Modified` plus total length;
3. total length only, with the short TTL and isolated cache key;
4. no validator, which is not admitted.

Weak ETags are not strong byte identity. If the observed validator or total
size changes, or a validator disappears, all slices for that resource are
purged before the new version is stored. A slice fetched while an older
version is pinned fails the current assembly rather than mixing versions.
`If-Range`, `If-None-Match`, `If-Modified-Since`, `If-Match` and
`If-Unmodified-Since` bypass the cache and continue through normal proxy
conditional handling.

Responses with `Cache-Control: no-store`, any `Vary` value, or a non-identity
`Content-Encoding` are not admitted. Media byte offsets therefore never refer
to transformed bytes.

## Single-flight, cancellation and failures

The same resource partition and slice index share one in-flight upstream
operation. Each caller awaits the shared promise with its own AbortSignal.
One disconnected caller cannot cancel a fetch still needed by another; the
shared upstream controller is aborted only when the final waiter disappears.
Settled flights are removed on success and failure, so a timeout, network
error, invalid `206`, mismatched `Content-Range`, mismatched body length, or
validator mismatch can be retried.

Cache errors always fail open to the existing uncached proxy for the same
resource. Invalid upstream protocol data is not rewritten into a valid cached
response: the normal proxy's existing 200/206/416 validation remains the final
authority. If an error occurs after cached response headers have started, the
response is terminated rather than appending bytes from another version.

## Known limitations and future work

- Metadata is memoized for the configured TTL; a validator change is observed
  on the next metadata refresh, not by a new network request on every hit.
- There is no stale-while-revalidate window in this Phase 3B implementation.
- Live segment caching, HTTP-FLV, HLS keys, manifests, conditional-cache
  responses, persistent cache storage, distributed single-flight, and metrics
  infrastructure remain out of scope.
- Internal counters are available for focused tests/debugging only; no
  Prometheus or HTTP metrics endpoint is introduced.
