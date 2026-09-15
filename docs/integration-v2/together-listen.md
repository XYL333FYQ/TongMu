# Together Listen

## Phase 5B-1 boundary

Together Listen is a basic room control panel, not an NCM product surface.
The first implementation uses deterministic local WAV fixtures addressed as
`music://fixture/<id>`. The fixture route supports normal browser metadata
loading, `HEAD`, byte `Range`/`206`, and honest `416` responses. No external
music service, login, cookie, search, playlist, album, FM, cloud, lyrics,
comments, likes, or upstream stream URL is used.

## Host and viewer behavior

The host panel can add fixture entries, select a queue item, reorder/remove
items, choose sequential/repeat-one/repeat-all/shuffle, play/pause, seek, and
move to the previous/next item. Queue edits are sent to the server and the
returned authoritative snapshot updates every member.

Viewers receive the same queue and playback snapshot. Play/pause, seek, select,
and previous/next become a control request targeted to the current host. The
host sees a pending request with explicit agree/reject controls. The server
checks request ID, room, actor, host socket, music generation, version, and
expiry before applying an approved request or returning a targeted response.

## Snapshot and timing behavior

The client requests `music:get-state` on initial connection and reconnect. It
does not treat local state as authoritative while reconnecting. Host heartbeats
run at a bounded interval and carry position, playing state, playback rate,
music generation, and base version. Viewer timing compensates for bounded
network delay and corrects only meaningful drift, avoiding repeated seeks for
small differences.

The panel reports an explicit host-offline state. A viewer never self-promotes,
and the room remains available for a later host reconnect.

## Audio lifecycle

`MusicAudioLifecycle` owns source assignment, event listeners, abort state, and
cleanup for the audio element. Every callback closes over the track generation
and an attach epoch. A callback from an unloaded or replaced track is ignored.
Unload is idempotent: it pauses, removes listeners, clears the source, calls
`load()`, resets position, aborts pending work, and revokes only object URLs
owned by the lifecycle. Track ACK is sent after the current generation reaches
the browser-ready event; it is never required for host progress.

## UI integration and verification

The panel is mounted in the existing host room controls and approved viewer
watch controls. It uses a separate Zustand music store and does not enter the
video room store or change the existing video layout/playback contract.

The Chromium flow verifies the actual browser path: two identical source refs
produce two queue identities, fixture audio reaches a ready state, byte Range
is honored, a viewer requests play, the host approves it, and the viewer
observes playing state. Unit tests verify ordering, delay/drift bounds, and
stale callback cleanup.
