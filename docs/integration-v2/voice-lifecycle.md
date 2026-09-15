# TongMu Voice lifecycle (Phase 4B)

## Scope

Voice remains a single-node Socket.IO relay. This document covers the
voice-specific identity, audio, lifecycle, ghost, and moderation contracts.
It does not introduce WebRTC, Together Listen, RealtimeSyncCore, or the
Phase 5 full room permission matrix.

## Identity and membership

The backend keeps one membership map per room keyed by identity:

- logged-in user: user:<userId>;
- guest: socket:<socketId>.

identity, socketId, and username are separate fields. username is only display
data and is never used for authorization. The socket reverse index resolves
socketId to roomId, identity, and generation in constant time.

When a logged-in user reconnects, the new socket replaces the old membership.
The old membership is broadcast as left before the replacement is broadcast as
joined. Every membership also has a monotonically increasing generation.
Audio, codec, mute, and kick events carry the generation so late events from a
superseded connection cannot affect the replacement.

Guests intentionally remain connection identities. This preserves the current
product behavior that multiple anonymous connections are allowed without
pretending they are one persistent user.

## Audio contract

The wire contract is mono Opus at 48,000 Hz. One frame is 20 ms, exactly 960
samples per channel. The PCM fallback uses the same sample rate and frame size.
Both capture and playback AudioContext instances request 48,000 Hz, and
AudioData timestamps advance by exactly 20,000 microseconds per frame.

An AudioWorklet accumulates render quanta until one complete 960-sample frame
exists. If the browser keeps a hardware-rate worklet (for example, 44,100 Hz),
the processor uses a continuous source cursor and linear interpolation to
resample to 48,000 Hz before frame assembly. It does not drop or duplicate a
render quantum. The browser normal AudioContext resampler is still the
preferred path.

The server bounds packet bytes, codec tuple, sample rate, channel count,
expected frame size, timestamp, audio rate, and codec-description size.
Malformed or oversized packets are dropped in isolation.

## Encoder and decoder lifecycle

The client checks WebCodecs support/configuration before creating the Opus
encoder. If WebCodecs is unavailable or setup fails, the existing mono PCM
fallback remains available. Encoder errors close the failed encoder and do not
take down the room.

Every remote peer owns its own decoder, gain/analyser chain, generation, and
pending packet list. Decoder configuration identity is the value tuple
codec + sampleRate + channels + description bytes; equal values do not call
configure again. A genuinely different description rebuilds only that peer's
decoder. If a browser rejects a description, the known Opus tuple is retried
without description. A small bounded packet queue covers audio-before-config;
packets are discarded after the count, byte, or age limit.

## Playback and cleanup

Scheduled AudioBufferSourceNode instances are kept in pendingSources. Ended
nodes remove themselves. Peer leave, replacement, decoder rebuild, voice leave,
join failure, and unmount stop/disconnect all pending sources, close the
decoder, and clear the pending packet queue. Playback resets its cursor when
the future timeline or source count becomes too large, so a burst cannot create
minutes of stale voice backlog. Late packets are dropped by member generation
and unknown-socket checks.

Join follows the safe order: validate the existing room membership, acquire
and configure local audio resources, then commit backend voice membership.
Every failure path closes contexts, stops tracks, closes the encoder, removes
listeners, and clears local state. leave() is idempotent. Unmount also calls
the same cleanup path. A socket reconnect cleans the old local voice graph and
rejoins through the normal validation and microphone setup path; it never
keeps old and new capture graphs concurrently. A disconnected client stops
sending immediately and is cleaned after a bounded 15-second reconnect grace.

## Ghost reconciliation

The backend runs a 15-second, single-node bounded sweep. It compares voice
membership sockets with io.sockets.sockets and removes memberships whose
socket no longer exists. Disconnect cleanup additionally checks that the
reverse-index generation still owns the membership, so a late disconnect from
socket A cannot remove replacement socket B. Kick cooldowns are pruned by the
same sweep.

## Voice-local moderation boundary

The backend handles voice-mute, voice-unmute, and voice-kick; hiding a button
is not authorization. Mute drops both audio and codec-config packets at the
relay, while the target can continue to listen. Kick removes only voice
membership and applies a bounded 60-second voice rejoin cooldown.

Phase 4B adds only the permission helpers needed by these actions: active room
host or the room's persisted moderator list. A moderator cannot act on the
room owner, root, or another moderator, and no actor can target itself through
these dangerous actions. The full role/action matrix, moderator appointment,
host transfer invariants, and cross-domain permission convergence remain
explicit Phase 5 work. Logged-in voice mutes are stored in Room.voiceMuted;
guest mutes are process/session scoped.

## Verification boundary

backend/test/phase4b-voice.test.js covers stable identity, guest identity,
replacement ordering, stale disconnect, rapid reconnect, server mute relay
enforcement, malformed/oversized packets, moderator protection, kick cooldown,
and ghost sweep. frontend/test/voice-contract.test.cjs covers the 48 kHz /
960-sample and bounded-resource contract. The Chromium test uses Playwright's
fake media device and exercises join, socket replacement, explicit leave, and
page unmount resource release.

No physical microphone, physical 44.1 kHz device, or two-physical-device voice
call was run in this environment.
