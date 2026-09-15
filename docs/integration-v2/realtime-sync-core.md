# RealtimeSyncCore

## Scope

Phase 5A provides the shared server-side realtime invariants for synchronized
video. Phase 5B-1 now reuses those primitives for MusicSyncDomain and Together
Listen through a separate music clock. It does not implement NCM, Redis,
clustering, or cross-node realtime.

`RealtimeSyncCore` is domain-neutral. It owns room-scoped identity and
ordering facts, while `VideoSyncDomain` owns video playback facts. A future
`MusicSyncDomain` may use the same core without reading or mutating video
state.

## Version model

Each domain has an independent room-scoped authoritative version. An accepted
authoritative mutation increments only that domain's version and records its
server timestamp. Client timestamps are timing facts only; they never decide
event ordering or authority. Video uses its existing `sourceGeneration` clock;
music uses `musicGeneration` and a separate version clock. A music mutation
cannot advance or rewrite the video clock.

Video mutations carry a bounded mutation id, the client base version, the
current `sourceGeneration`, and a bounded client timestamp. Music mutations
carry the same shared safeguards with `generation`/`musicGeneration` instead
of `sourceGeneration`. The server rejects a duplicate mutation, a stale base
version, a reordered version, or a generation that is no longer current. A
restart hydrates only the domain's persisted ordering metadata; ephemeral
playback position is not presented as exact recovery.

The frontend applies an event only when its generation is current and its
version is newer than the applied authority. A snapshot may replace an equal
version, but never an older version. This makes delivery order irrelevant for
events such as version 10, 12, 11, or 12, 12.

## Source generation

`sourceGeneration` is the existing media generation. The core does not create a
second media-generation concept. Every video mutation, readiness report,
subtitle update, snapshot, and targeted request is bound to the generation that
created it. A late event from movie A cannot mutate movie B even if its numeric
version is larger.

`VideoSyncDomain` validates media descriptors, position, duration, playback
rate, readiness, and bounded text before an event reaches playback memory or a
socket broadcast. Existing Phase 4A player and subtitle generation guards
remain in the player path.

## Authoritative snapshot and reconnect

Video `get-state` returns a room/session identity, authoritative version,
`sourceGeneration`, trusted server timestamp, current video domain state, and
host facts. Music `get-state` returns its own session, version,
`musicGeneration`, queue/current item, play mode, playback state, and host
facts. Existing event names remain available through compatibility adapters,
but each domain has one authoritative mutation path.

On socket reconnect the client re-authenticates through the existing Socket.IO
auth path, validates room membership, requests a fresh snapshot, and only then
continues consuming state. A new socket does not trust its local playback state.
Old socket readiness and cleanup records are removed idempotently. A late event
from an old socket cannot reclaim host authority.

## Host authority and disconnects

Server-side permission checks gate playback mutations. The UI is not an
authorization boundary. Host transfer is serialized per room and persisted in
one transaction with owner/moderator/session state and playback host cache
refresh. A stale or old host is rejected immediately after transfer.

TongMu keeps the existing single-node disconnect semantics: a disconnect does
not invent a distributed lease. Cleanup is bounded and idempotent, and a late
disconnect from a replaced socket cannot clear the current host's state.

## Clock bounds

Client timestamps are accepted only as finite numbers within the configured
five-minute skew window. `NaN`, `Infinity`, absurd future/past values, and
malformed realtime payloads are rejected. Server snapshots and authoritative
events use the server timestamp.

## Readiness and targeted events

`ready(sourceGeneration)` is generation-bound and is discarded when it does not
match the room's current video generation. Music track ACKs use the same
targeted/expiry idea but bind to `musicGeneration`, queue item, version, room,
and actor; slow viewers do not block the host. The same core exposes a targeted
emission helper: the target socket must be connected, a member of the room, and
pass the server-side relationship check. A client cannot select an arbitrary
socket id to receive a privileged event.

The viewer-control request primitive carries a bounded `requestId`, actor,
target, room, generation, base version, and expiry. A response is accepted only
for a live request, by an authorized host, and for the original target/room.

## Compatibility boundary

Legacy video event names and payload aliases remain at the socket boundary for
existing clients. Music compatibility aliases are converted into the music
domain path. They are converted into their respective shared core/domain path;
no handler is allowed to independently mutate another domain's authoritative
state.
