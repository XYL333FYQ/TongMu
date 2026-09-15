# TongMu V2 Phase 4A — Player and Subtitle Lifecycle

Phase 4A hardens the client lifetime around `sourceGeneration`. It does not
change Media Core, the Local Planner, representation selection, room protocol,
or the Phase 3 manifest/cache authorization boundary.

## Generation ownership

`usePlayerSource` creates a monotonically increasing local generation for every
new source attach. The shared `PlayerGeneration` owns:

- an `AbortController` and the player fetch-controller lease;
- the engine instance and its cleanup callback;
- media-element listeners, timers, workers, MediaSource objects, and object URLs
  created by that attach;
- the source generation supplied by the room/media state.

`isCurrentPlayerGeneration` is required before any async resolve, engine
callback, media event, MSE/worker callback, subtitle callback, fallback, or
timer can commit state. A stale generation may finish its own cleanup, but may
not mutate the current generation.

## Attach serialization and replacement

Attaches are serialized through a coalescing queue. Replacing a source first
aborts and disposes the active generation; the next attach then runs with its
own signal. An aborted or stale queue item exits without committing an engine,
so a slow A cannot delay or overwrite a newer B/A2 attach indefinitely.

The player lifecycle states are `idle`, `resolving`, `attaching`, `ready`,
`replacing`, `failed`, and `destroyed`. Engine construction is not readiness;
the attach promise and the engine's real metadata/initialization condition are
required before `ready` is committed.

## Engine cleanup

Direct, HLS, DASH, FLV, and playsvideo engines use idempotent cleanup. Cleanup
removes listeners, aborts fetches, detaches or destroys the library instance,
pauses/resets the media element, releases MSE/SourceBuffer ownership, revokes
owned object URLs, terminates workers, and clears owned timers. A failed attach
is cleaned before a same-generation transport retry.

The remux fallback is restricted to the same source/representation and is
generation-bound. A native MKV fast-path failure can use playsvideo when the
existing player policy permits it; no old shared `ffmpeg.wasm` engine is
introduced.

`usePlayerRemountKey` remains a boundary for actual movie identity changes. A
normal play/pause/seek, same-source refresh, or metadata-only update does not
force a video-element remount.

## Event ownership and instrumentation

The player owns and removes `play`, `pause`, `seeking`, `seeked`, `timeupdate`,
`durationchange`, `loadedmetadata`, `canplay`, `error`, and `ended` listeners.
Room event broadcasting also checks the attached `sourceGeneration`, preventing
late events from an old element/source switch from rebuilding current room
state.

Test-only counters cover active engines, workers, object URLs, MediaSource
ownership, listeners, player fetch controllers, and timers. They are not Phase 6
metrics and must return to a bounded baseline after repeated replacement or
unmount.

## Fallback and quality invariant

The server still emits viability facts and transport candidates; the client
still consumes the current `PlaybackPlan`. A runtime attach failure may retry
only the next viable transport for the same representation. It must never
silently select a lower-quality representation. No engine fallback decision is
moved to the server.

## Subtitle lifecycle

External, provider, and embedded subtitles are owned by the media source
generation. Source-generation changes abort external fetches and embedded
extraction, clear old tracks, and prevent late batches from updating the new
source. Unmount aborts both external and embedded work.

Supported text formats remain SRT, ASS, SSA, VTT, SMI/SAMI, and MicroDVD SUB.
The parser handles BOM and CRLF/LF input, rejects malformed time ranges, keeps
overlapping and same-start/different-text cues, and escapes untrusted text.
Only parser-generated formatting tags are emitted to the overlay; subtitle
content is never treated as executable HTML or script.

Cue identity includes track, start, end, and normalized text. Start time alone
is not a dedupe key. Incremental extraction uses the same identity and checks
both generation and track identity on every batch. Broadcast/late-join state
also carries the source generation and rejects a mismatched update.

Private subtitle access continues through scoped media/resource authorization.
The frontend does not receive provider cookies, raw upstream credential URLs, or
provider headers as public subtitle state.

## Embedded MKV bounds

MKV extraction remains Range-based and reuses the existing authorization,
source-generation, and cache semantics. It probes headers/metadata/Cues first,
then requests only the cluster windows needed for the selected track and seek
priority. The operation has explicit limits:

- maximum bytes probed/read: 512 MiB by default;
- maximum Range requests: 8,192 by default;
- extraction timeout: 120 seconds by default;
- every request and stream observes `AbortSignal`.

Valid Cues use sparse cluster windows. Missing or corrupt Cues use a bounded
sequential fallback; they cannot trigger an unbounded 20 GB scan. A budget or
abort stops the operation, and stale callbacks are discarded. Text subtitle
tracks are extracted incrementally. Bitmap tracks such as PGS/VobSub remain
explicitly unsupported; no OCR is introduced.

## Verification expectations

The Phase 4A gate covers source replacement, stale callbacks, unmount during
resolve/attach, failed attach cleanup, idempotent destroy, same-representation
fallback, listener/resource counters, subtitle parser edge cases, generation
replacement, MKV byte/range/timeout/abort bounds, Chromium engine replacement,
and the Phase 3 cache enabled/disabled regression.

Voice identity, fixed 48 kHz/960-frame Opus behavior, decoder configuration
dedupe, reconnect replacement, ghost cleanup, and moderation remain Phase 4B.
