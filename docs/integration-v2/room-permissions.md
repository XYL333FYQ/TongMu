# Room Permission Core

## Scope

Phase 5A centralizes room authorization decisions for video, viewer
management, host transfer, room settings, and Voice moderation. It does not
change Voice identity, reconnect, ghost cleanup, audio, or decoder lifecycle.
Those Phase 4B lifecycle guarantees remain in place.

Role facts and permission decisions are separate. The core adapts TongMu's
existing identities without changing database identity semantics:

| Role | Meaning |
| --- | --- |
| `system` | root/system-privileged actor; protected from room moderation |
| `owner` | current room owner/host |
| `moderator` | room moderator below the owner |
| `member` | authenticated room member |
| `guest` | guest or otherwise non-privileged room participant |

## Actions and defaults

The finite action set is:

- `playback.play`, `playback.pause`, `playback.seek`, `playback.rate`
- `movie.change`, `subtitle.change`
- `viewer.approve`, `viewer.reject`
- `viewer.kick`, `viewer.mute`
- `voice.mute`, `voice.kick`
- `moderator.manage`, `host.transfer`, `room.settings`

The default policy is deliberately conservative. System and the current owner
may perform room-authoritative playback, movie, subtitle, settings, transfer,
and moderation actions. Moderators may perform the explicitly supported
moderation actions against lower roles, but cannot act on system, owner, or a
peer moderator. Members and guests cannot invoke privileged room actions.
Every socket handler calls the same `canPerform(...)` decision or a
compatibility method that delegates to it.

## Anti-escalation

Target checks are part of authorization, not a frontend convention. A
moderator cannot target system, owner, or another moderator; cannot promote
itself; cannot create a peer or higher role; and cannot transfer host to an
invalid or non-member target. System/root and owner identities are protected
from moderator operations. Self-target behavior is explicit and fail-closed
for moderation actions.

Viewer management validates room membership and target identity server-side.
Targeted events additionally validate that the target socket is currently a
member of the room.

## Host transfer

Host transfer is serialized by the realtime room lock and committed in one
database transaction. The transaction updates the old host, new host, room
owner, moderator invariant, session authority, and playback host cache. The
new host is removed from the moderator list when the existing model requires
that invariant. Cache/session refresh follows the same successful commit path;
errors roll back the transaction.

Concurrent transfers cannot both succeed for the same old-host/version state.
After a successful transfer, the old host's socket immediately fails host-only
commands, including late commands sent by a stale socket.

## Voice convergence

Voice mute/kick role decisions now use the shared Permission Core through the
existing Voice permission compatibility boundary. Voice identity, reconnect
replacement, ghost cleanup, membership generations, audio lifecycle, and
decoder ownership remain Phase 4B behavior. This phase does not add music
permissions or a second Voice lifecycle implementation.

## Validation

The Phase 5A backend tests cover the role/action matrix, guest/member/
moderator/owner/system behavior, protected targets, self-target behavior,
invalid payloads, and serialized room locking. Existing Voice tests and the
Chromium fake-media Voice flow remain regression gates. Music queue, Together
Listen, NCM, and Phase 6 schema/release migrations remain deferred.
