# MusicSyncDomain

## Scope

Phase 5B-1 adds a server-authoritative, provider-neutral music domain for a
room. It is deliberately separate from `VideoSyncDomain`: the music module
owns its queue, current item, playback state, play mode, `musicGeneration`,
version, and host facts. It may use `RealtimeSyncCore` ordering, deduplication,
room locks, targeted delivery, and socket cleanup, but it never reads or
mutates the current movie, video `sourceGeneration`, video playback,
readiness, or subtitles.

Phase 5B-1 does not include NCM login/cookies, search, playlists, albums, FM,
cloud music, lyrics, comments, likes, upstream music APIs, or provider-specific
quality fallback. Those are Phase 5B-2 review items.

## Persistent and ephemeral state

`MusicQueueItem` is stored in the existing TypeORM/SQLite database. Its
generated `queueItemId` is the stable identity; it is independent of a song
ID, title, array index, and source ref, so the same source can occur more than
once. The row contains a bounded opaque `sourceRef`, title/artist/album,
optional artwork, duration, normalized `orderIndex`, creator ID, bounded
provider-neutral metadata, and creation time. It does not contain an audio
URL, cookie, authorization header, signed stream URL, or provider credential.

`MusicRoomState` persists the selected queue item, play mode, shuffle seed/order
and history, and music version/generation. Queue mutations and multirow order
changes run inside one database transaction. The current position, playing
flag, and live playback clock are intentionally ephemeral. After restart the
queue, selected item, and mode are restored, while position is honestly reset
to zero and playback is paused.

## Authority and ordering

The music clock has its own room map in `RealtimeSyncCore`. A mutation carries a
bounded mutation ID, optional base `version`, optional `musicGeneration`, and
bounded client timestamp. The server rejects duplicates, stale versions,
stale generations, invalid timestamps, invalid bounds, and unauthorized
actions. Accepted mutations increment the music version; video mutations
increment only the video clock.

Selecting a different queue item, removing the current item, adding the first
item, or moving to another item increments `musicGeneration`. Old-track play,
pause, seek, ended, heartbeat, and ACK messages are rejected. An ACK is bound
to room, socket/actor, queue item, generation, and version, has a short expiry,
and is informational: a slow viewer never blocks the host or the next track.

## Queue and playback protocol

The Socket.IO handler exposes these compatibility-friendly event families:

- `music:get-state` / `music:request-state`: member-only snapshot-first read.
- `music:queue-add` / `music:queue-upsert`, `music:queue-remove`,
  `music:queue-reorder`, `music:queue-clear`, and `music:queue-select`.
- `music:play`, `music:pause`, `music:seek`, `music:next`, `music:previous`,
  and `music:mode-change`.
- `music:heartbeat` / `music:sync-state`, `music:ended`, and
  `music:track-ack` / `music:sync-ack`.
- `music:control-request` and targeted `music:control-response`.

The server normalizes queue order and enforces the queue/field/metadata
limits. Play modes are sequential, repeat-one, repeat-all, and deterministic
shuffle. Shuffle uses a persisted seed and queue-item identities, not array
positions alone. The server advances an authoritative position using its last
timestamp and clamps it to known duration; clients correct only material drift
and do not seek on every small heartbeat.

## Permissions, reconnect, and host loss

The existing Room Permission Core authorizes every action. The owner/current
host is authoritative for music playback, mode, selection, heartbeat, and
ended events. Owners/moderators may manage the queue. Authenticated members may
submit control requests and track ACKs; the host must approve a request before
the server applies it. Guests are rejected from the music request/ACK path.

Requests are targeted to the active sharer and carry the original room,
request ID, actor, host target, generation, version, and expiry. A response
from another socket, room, generation, version, or an expired request fails.
If the active sharer disconnects, the snapshot reports `hostOffline`; the
server does not promote a viewer. A reconnect requests a new snapshot before
the client resumes local audio synchronization.

## Security and quality boundary

Only constrained `music://provider/reference` values are accepted in Phase
5B-1. Secret-like query strings, credentials, raw media URLs, and unsafe
artwork URLs are rejected. Public snapshots contain queue metadata and state,
not private provider credentials. There is no silent lower-quality audio
fallback: a source that cannot be resolved by the current fixture resolver is
reported as unavailable.

## Verification

- `backend/test/phase5b-music.test.js` covers validation, duplicate identity,
  deterministic modes, transactional persistence/restart, timestamp position,
  stale generation/version, ACKs, permissions, and video/music isolation.
- `frontend/test/music.test.cjs` covers authority comparison, bounded delay and
  drift, and generation-owned audio cleanup.
- `e2e/phase5b-music.spec.ts` covers local WAV loading, Range, duplicate queue
  IDs, viewer request/host approval, and state propagation in Chromium.
