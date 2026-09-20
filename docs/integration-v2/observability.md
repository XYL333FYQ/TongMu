# TongMu observability contract

Status: Phase 6B-2 implementation complete. This contract applies to the
in-process logger, HTTP middleware and bounded metrics registry. TongMu writes
application logs to stdout/stderr; Docker or the operator owns retention and
rotation. No log daemon or unbounded file sink is created under `config/`.

## Structured log schema

Every application record is one JSON object with these required fields:

- `timestamp`: ISO-8601 wall-clock timestamp for the event.
- `level`: `debug`, `info`, `warn`, or `error`.
- `component`: bounded code-owned category such as `http`, `proxy`, `database`,
  `socket`, `ncm`, or `updater`.
- `event`: bounded code-owned event name.

HTTP completion records also include `requestId`, method, matched route,
status, monotonic `durationMs`, actual `responseBytes`, a bounded authentication
category and whether completion arrived through `finish` or `close`. Provider,
transport, resource, result and typed error-code context may be added, but all
context passes through the same recursive redactor.

## Request IDs and matched routes

`X-Request-Id` is accepted only when it is 1-64 characters, begins with an
ASCII alphanumeric and otherwise contains only ASCII alphanumeric, `.`, `_`,
or `-`. Missing, invalid or overlong input is replaced with a UUID. The same ID
is returned as `X-Request-Id` and propagated through `AsyncLocalStorage`; it is
correlation data, never identity or authorization.

Only the Express matched route template is logged or labeled. Router mount
prefixes must remain under the fixed `api`, `health`, `internal`, or `live`
roots. Templates longer than 160 characters, deeper than 12 segments, invalid
templates and unknown routes become the single value `UNMATCHED`. Raw paths,
room IDs, media handles and URL queries are never fallback labels.

## Response bytes and duration

The middleware wraps `res.write` and `res.end`, counts the byte length of the
actual string/Buffer/Uint8Array chunks, and calls the original methods with the
original receiver and arguments. It does not buffer, concatenate or copy
payloads, change backpressure, inspect Content-Length, or alter Range/SSE/proxy
semantics. `finish` and `close` share an idempotent completion function so a
response is never counted twice; listeners and method wrappers are restored.

Duration uses `process.hrtime.bigint()`. Wall-clock time is used only for the
human timestamp.

## Redaction

Redaction is recursive, cycle-safe, depth/array/string bounded and fail-soft.
It covers secret-bearing keys and inline values including Authorization,
Cookie/Set-Cookie, `MUSIC_U`, `__csrf`, passwords, provider/API keys, JWTs,
access/refresh/query tokens, signed URLs and media handles, updater/signing
private keys, SecretVault/database secrets, nested `Error.cause`, bearer/JWT
patterns and private-key PEM blocks. Binary objects become a byte-count marker.

HTTP/HTTPS strings retain only origin and path; all queries become the bounded
`?[REDACTED_QUERY]` placeholder. An unparsable URL becomes `[INVALID_URL]`.
Production error records omit stacks; development may include a redacted,
length-bounded stack. Logger failure is swallowed without retrying raw context.

Security-critical auth/provider/proxy/updater/migration/music/NCM/socket paths
use the structured logger. High-frequency voice packets, heartbeats, playback
ticks, segments and parts never produce one structured record per item.

## Metrics and label bounds

The built-in Prometheus-compatible registry has a hard global cap of 4,096
series. Every label has a static allowlist, except `matched_route`, which must
pass the template bounds above. Invalid updates are ignored; metrics failure
cannot fail media playback.

Defined metrics:

- `http_requests_total{method,matched_route,status_class}`
- `http_request_duration_seconds{method,matched_route}` histogram
- `http_response_bytes_total{matched_route,status_class}`
- `media_resolve_total{provider_type,result}`
- `media_gateway_requests_total{resource_kind,transport_mode,result}`
- `slice_cache_total{outcome}`
- `active_room_count`, `active_socket_count`, `active_voice_member_count`,
  `music_room_count`
- `realtime_rejected_total{reason}`
- `voice_packet_dropped_total{reason}`
- `database_migration_total{result}`, `update_check_total{result}` and
  `update_apply_total{result}`

There are no user, room, movie, queue item, socket, request, filename, URL,
version, SHA, artifact, arbitrary provider or error-message labels. Provider,
resource, transport, result and reason values are fixed enums.

## Endpoint policy

`GET /internal/metrics` is disabled by default. Set
`OBSERVABILITY_METRICS_ENABLED=true` to register it. Even when enabled, it
requires normal access-token authentication plus the root role. It returns
`text/plain; version=0.0.4; charset=utf-8` with `Cache-Control: no-store`.
The registry's global cap, fixed metric definitions and bounded templates bound
the possible response size; it is never an anonymous public endpoint.

## Verification evidence

`backend/test/phase6b2-observability.test.js` verifies the recursive secret
corpus, valid and invalid request IDs, actual byte accounting for a 100 MiB
unknown-length stream, bounded heap growth, no raw ID in logs/metrics and one
series for 10,000 random unmatched paths. The container runtime smoke invokes
real Direct/HLS/DASH probes and a controlled static-parser failure followed by
a real Chromium BrowserResolver success.
