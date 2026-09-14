# ZViewer upstream notes

## Audit identity and scope

- Audited local snapshot: `references/ZViewer-main/ZViewer-main` (635 files).
- The snapshot has no `.git`, so its exact commit cannot be proven locally. `package.json` reports `1.0.0`; `git ls-remote` on 2026-09-13 reported upstream HEAD `9890f7cda739912f4f6167a0ddea510eafec7160`. Treat that hash as the then-current remote head, not as a verified identity for the extracted snapshot.
- License: MIT, copyright 2025 Zero-wyc. Preserve the notice for substantial copied/adapted code.
- Audit method: read implementation and state transitions in the listed files, compare symbols/behavior with TongMu, and inspect tests/scripts/assets. README claims were not treated as implementation proof.

## Together Listen / music domain

### Fast source map

| Area | Source paths | Important symbols |
| --- | --- | --- |
| Backend sync | `backend/src/modules/music/MusicSyncHandler.ts` | `MusicSyncHandler`, `MusicSyncStatePayload`, `musicSyncStates`, `buildQueuePayload`, `safeGetStateAck` |
| Persistent queue | `backend/src/entities/MusicQueueItem.ts` | queue row, `roomId`, stable song identity, `order` |
| NCM credentials | `backend/src/entities/NcmCredential.ts` | per-user serialized cookie state and profile fields |
| NCM service | `backend/src/modules/music/ncm-api.service.ts` | internal loopback API lifecycle |
| HTTP API | `backend/src/routes/music.ts` | generic NCM forwarding, `/cloud/upload`, `/album/full`, `/login/status`, `/stream`, `/song-quality` |
| Client state machine | `frontend/src/modules/music/hooks/useListenTogether.ts` | `advancePosition`, heartbeat, `GET_STATE`, control request/response, ACK, queue/play-mode transitions |
| Store | `frontend/src/modules/music/store.ts`, `store-settings.ts` | `useMusicStore`, `resetRoomPlayback`, queue sort, persistent local settings |
| Player/context | `frontend/src/modules/music/context/*`, `components/MusicPlayer.tsx` | audio element ownership, actions and UI state |
| Product surface | `frontend/src/modules/music/pages/*`, `components/*`, `utils/*` | search, playlist, album, artist, liked, FM, cloud, comments, lyrics, QR login |

### Backend state machine

`MusicSyncHandler` keeps two kinds of state deliberately separate:

1. The ordered queue is persisted as `MusicQueueItem` rows. Queue mutations are authorized through `roomPermissionService.canViewerPerform(..., 'musicQueue')`, then broadcast as a complete, order-sorted snapshot. Upsert can append or insert after the current item and shifts later order values. Remove compacts order; reorder rewrites the submitted ID order; clear deletes the room queue.
2. The most recent playback snapshot is an in-memory `musicSyncStates` entry. It contains track identity, `isPlaying`, `positionSec`, `playMode` (`sequence`, `repeat-one`, `shuffle`) and `updatedAt`. `music:sync-state` and the 2-second `music:host-heartbeat` validate and replace the snapshot; they forward it to the other room members.

`music:get-state` combines persisted queue and the latest in-memory sync state. This allows a joining/reconnecting client to reconstruct both durable order and current ephemeral position. State is explicitly cleared when the room lifecycle ends.

Viewer control is a targeted handshake, not an unauthorized state write: `music:control-request` goes only to the active sharer with requester socket/username; the host's `music:control-response` goes only to the requester and carries `from` for validation. `music:sync-ack` lets viewers acknowledge a successful track switch to the host.

### Client synchronization behavior

`useListenTogether.ts` is the valuable implementation, not merely the event list:

- The host owns the audio element and broadcasts changes plus a full snapshot every two seconds.
- `advancePosition` adds bounded elapsed time only when `isPlaying`; missing, negative or implausibly large `Date.now() - updatedAt` is treated as clock skew and the original position is used.
- A viewer seeks only when drift exceeds roughly two seconds, reducing audible jitter and feedback loops.
- On join/reconnect it requests `music:get-state`, sorts the queue, applies play mode/current item, resolves the stream, and acknowledges a successful switch.
- Host-offline state is represented explicitly so viewers do not pretend an absent host is authoritative.
- Sequence/repeat-one/shuffle transitions are deterministic from queue/current key. Shuffle maintains a key list and repairs it when the queue changes.
- Before changing tracks or leaving, the audio element is paused, `src` is cleared and `load()` is called to release buffered network resources.

The upstream uses `updatedAt` but has no strong monotonically increasing event sequence in this music contract. TongMu should add `seq/version` in `RealtimeSyncCore`; wall-clock time remains delay compensation only.

### NCM feature boundary

`ncm-api.service.ts` starts `@neteasecloudmusicapienhanced/api` on loopback and `routes/music.ts` forwards a broad set of API calls. The UI implements QR login/status/logout, search, daily/FM, playlists, album/artist pages, liked songs, comments/like, cloud upload, lyrics and quality display. `/album/full` is a useful edge fix: if an authenticated album response contains fewer songs than `album.size`, an anonymous response is fetched and merged to restore the full list while retaining authenticated privilege fields.

`/stream` looks up the current user's credential and can fall back to the room owner's credential, resolves a NCM CDN URL, optionally returns a direct URL and otherwise proxies the audio with Range headers. It constrains direct hosts to NetEase music domains. `/song-quality` reuses the same resolution chain and caches actual upstream `sr/br/type/level` metadata.

Important conflict: the upstream stream path uses a `QUALITY_CHAIN` and may silently try lower levels. TongMu must expose requested, actual and maximum audio quality and require an explicit policy before lowering quality. The current NCM credential entity stores serialized cookies without TongMu's required authenticated-encryption boundary. Do not copy it.

### Recommended adaptation

- Build `MusicSyncDomain` on a shared `RealtimeSyncCore`, retaining the durable queue/ephemeral snapshot split and targeted request/ACK flows.
- Model NCM as a provider producing a private audio source, public descriptor and same-quality playback candidates. Use the existing room-media grant pattern for owner credential sharing.
- Adopt UI information architecture and interaction patterns, not raw credentials or silent quality fallback.
- Add queue transactions/uniqueness, sequence/version, source generation, cancellation and restart tests that ZViewer lacks.

## Room permissions and moderation

### Source map

- `backend/src/modules/room/room-permission.service.ts`: `canViewerPerform`, `matrixAllow`, `isRoomHostOrModerator`, `canModeratorActOn`, `getModerators`, `setModerators`.
- `backend/src/modules/room/handlers/viewer-management.handler.ts`: kick/mute/unmute, appoint/dismiss moderator, transfer host, broadcast updates.
- `backend/src/modules/room/room-session.service.ts`: transactional host transfer and moderator removal.
- `backend/src/entities/SystemSettings.ts`: `roomPermissionMatrix`.
- `backend/src/entities/Room.ts`: `moderators`, muted viewers, owner.

### Evaluation order and invariants

`canViewerPerform` checks owner first, then root (always allowed), then moderator/admin/user through the configured action matrix; guests are denied. Missing matrix values preserve the prior defaults: moderator/admin allowed, normal user denied. Covered actions are `addMovie`, `manageMovie`, `musicQueue`, `kickViewer` and `muteViewer`.

Moderator power has hard ceilings outside the configurable matrix. `canModeratorActOn` refuses owner, root and other moderator targets. Only owner/root can change moderators; the count is bounded. Host transfer is transactional, downgrades/upgrades sessions, updates owner and removes the new owner from moderators. Cache invalidation and `moderators-changed` broadcasts follow role mutations.

Guest uses the no-persisted-user semantic; ZViewer comments/routes sometimes call this `userId=0`. TongMu should represent this as `actor.kind='guest'`, because zero-as-ID is easy to confuse with a database subject.

### TongMu adaptation

TongMu currently has centralized permission checks but not this full matrix/moderator system. Adapt the evaluation order and hard invariants; do not scatter matrix reads across handlers. Extend the matrix to playback controls, voice moderation and host transfer, and add exhaustive role/action/target tests.

## Voice fixes

### Source map

- `backend/src/modules/voice-chat/voice-chat.handler.ts`
- `frontend/src/modules/voice-chat/hooks/useVoiceChat.ts`
- `frontend/public/voice-processor.js`
- `backend/src/modules/room/room-permission.service.ts`

### Backend behavior

The latest handler keys logged-in membership as `user:{userId}` and guests as `socket:{socketId}`. Joining from the same account replaces the older socket and keeps reverse socket-to-member indexes, preventing duplicate-account ghosts. A periodic scan reconciles voice entries with live Socket.IO connections. Member payloads use real identity rather than slicing socket IDs.

The server enforces persisted mute state for users and session-only mute for guests, drops audio/codec-config from muted senders, supports kick/cooldown and applies owner/root/moderator protections. Reconnect/leave removes indexes and broadcasts one coherent membership update.

### Frontend behavior

- `OPUS_SAMPLE_RATE = 48_000`, `FRAME_SIZE = 960`: one 20 ms Opus frame. Both capture and playback `AudioContext` request 48 kHz, avoiding a 44.1 kHz context feeding a 48 kHz encoder contract.
- Decoder config descriptions are byte-compared before reconfiguration. If audio arrives before the config, the decoder attempts a no-description Opus config and later upgrades safely.
- Pending scheduled `AudioBufferSourceNode`s are tracked and stopped/disconnected on peer/room cleanup.
- Join failures call the complete cleanup path: media tracks, AudioWorklet, gains, encoders/decoders and all AudioContexts are closed.
- Socket reconnect automatically rejoins voice, refreshes identity/mute state and resends codec configuration.
- Visibility recovery resumes suspended contexts on mobile. Encoder backlog is bounded/dropped to prevent unbounded latency.
- Displayed latency is based on local playback-buffer delay; cross-device `Date.now()` subtraction is not treated as reliable latency.

TongMu's current voice hook/handler lacks several of these guarantees and still derives display identity from socket IDs. This is a high-priority adaptation. Port behavior and tests, not wholesale files, because TongMu permissions/session DTOs differ.

## Player lifecycle

### Source map and state machines

- `frontend/src/modules/room/watch-together/usePlayerRemountKey.ts`: increments a remount key after a real movie-ID change; avoids remount on first/null load.
- `frontend/src/modules/player/hooks/usePlayerSource.ts`: serializes attach/reload promises, holds unmount/current-generation guards, destroys prior engines and releases object URLs/listeners; stale async results clean themselves rather than attach.
- `frontend/src/modules/player/engines/direct-engine.ts`, `hls-engine.ts`, `flv-engine.ts`: wait for readiness/error with disposable listeners and idempotent destruction.
- `frontend/src/modules/player/engines/dash/player.ts`: explicit `idle -> attaching -> attached <-> seeking -> disposed` state; abortable attach and sparse-scan cancellation.
- `frontend/src/modules/player/engines/playsvideo-engine.ts`, `playsvideo-subtitle-bridge.ts`: generation tokens cover engine and subtitle bridge; stale/failing workers and decoders are cleaned.

TongMu already has related files and generation/cleanup work. Use symbol-level diffs to selectively adopt newer fixes while retaining TongMu's candidate transport switching. A player remount is a last lifecycle boundary, not a substitute for engine cleanup.

### ffmpeg.wasm finding

The audited latest ZViewer snapshot does **not** contain the older shared ffmpeg.wasm worker/acquire-release engine requested in the audit checklist. `playsvideo-engine.ts` says the old self-built WASM engine was replaced by playsvideo, and `mkv-embedded.ts` intentionally avoids ffmpeg.wasm because it tends toward full-file reads and large WASM memory. Therefore:

- do not invent an upstream “module-level ffmpeg worker” result;
- do not copy obsolete worker semantics from older history without a separately pinned source;
- treat playsvideo's current Worker/decoder lifecycle as the relevant upstream behavior;
- retain a future pooled-worker extension only if the actual dependency exposes safe acquire/release, fatal reset and cross-job isolation.

## Subtitle and MKV pipeline

### Source map

- `frontend/src/modules/subtitles/mkv-embedded.ts`: browser Matroska demux and sparse scan.
- `frontend/src/modules/room/watch-together/useSubtitles.ts`: load/abort/dedupe/broadcast/late-join state.
- `frontend/src/modules/room/watch-together/SubtitleOverlay.tsx`: cue layout, line/position/align and customization.
- `frontend/src/lib/subtitleParser.ts`: external text formats.

### Behavior and edge cases

`mkv-embedded.ts` performs a 4 MiB Range probe. Smaller files (roughly below 512 MiB) can stream through one demux path; large files prefer Cues and sparse Cluster windows. It uses bounded worker concurrency, seek-aware priority and incremental flushes (frame count/time thresholds) to avoid waiting for a complete file. It can decode text subtitle tracks such as UTF-8/ASS/SSA/WebVTT and zlib-compressed content. PGS/VOBSUB bitmap tracks are deliberately unsupported.

`useSubtitles.ts` aborts obsolete loads, streams embedded cues incrementally, shares selected subtitle state and supplies it to late joiners. It deduplicates repeated cues, but a start-time-only key can collapse two distinct cues with the same timestamp; TongMu should include track ID, time range and text/hash. Local offset/font/position should remain presentation settings, while track identity and timing source are synchronized.

Tests to add: non-Range server, truncated EBML, absent/corrupt Cues, concurrent seek/unmount, multiple text tracks with equal timestamps, compressed blocks, large-file byte budget, late join and source-generation race.

## Mobile patterns

`frontend/src/hooks/useMediaQuery.ts` provides SSR-safe `matchMedia`, legacy Safari `addListener` fallback and `useIsMobile`, `useIsTouch('(pointer: coarse)')`, `useIsPortraitMobile`. Music/player CSS uses `100dvh`, safe-area insets, touch alternatives to hover/double-click, portrait-specific layouts, `touch-action` and reduced blur on constrained mobile paths.

Adopt the shared hook and behavior checks where TongMu lacks them. Do not copy entire ZViewer screens or override existing TongMu desktop/mobile layout. Browser validation must include 320px-class widths, no horizontal overflow, safe areas, portrait/coarse pointer and hover-capable narrow windows as distinct cases.

## Bilibili UX and security warning

ZViewer's movie-push surface implements QR login, cookie login, account status, search, BV/av addition and quality controls. These flows are worth adapting into provider-owned UI states (logged out, QR waiting/scanned/expired, logged in, credential invalid, resolving).

Do **not** copy its credential boundary. The reference has the same Base64 credential storage and raw cookie-return endpoint family found in TongMu. It also predates/does not supersede TongMu's stronger `PrivateMediaSource`, redacted descriptor, encrypted media handle and explicit requested/actual/maximum quality semantics. For media security/quality decisions the decision is KEEP TONGMU; only UX/state-machine behavior is adoptable.

## Other useful upstream deltas

- The permission/membership work applies to movie management, music and voice through a shared service rather than duplicated role checks.
- Source-switch cleanup and subtitle scan cancellation contain concrete race fixes worth porting with regression tests.
- Album hydration and mobile visibility/audio-context recovery are small, user-visible edge fixes.
- The current ZViewer backend declares no real test script (`test` exits with “no test specified”), so upstream behavior needs TongMu-owned tests before adoption.
- Latest frontend has no test script either. Source maturity must not be inferred from feature breadth.

## What not to copy

- Base64/plain credential persistence or any raw cookie DTO/endpoint.
- Silent NCM quality downgrade.
- Host wall-clock timestamps as the sole ordering/staleness mechanism.
- Socket-ID-derived identity for logged-in users.
- Old ffmpeg.wasm assumptions absent from this snapshot.
- UI wholesale where it would overwrite TongMu Media Core flows.
- Fonts/images/icons/binaries without file-specific provenance review.

## License and asset provenance

ZViewer code is MIT, but that does not establish the license of every bundled asset. The snapshot includes `SourceHanSansCN-Bold.woff2`, `Gilroy-ExtraBold.woff`, `Bender-Bold.woff`, `netease-music.png`, avatars/backgrounds/icons and a vendored mediabunny distribution. No adjacent font license files were found. The NCM module adds `@neteasecloudmusicapienhanced/api`. Before copying any asset or bundled distribution:

1. identify upstream project/version/commit and license;
2. verify redistribution and trademark/brand restrictions;
3. record local modifications and source URL;
4. add the required notice/license text to `THIRD-PARTY-NOTICES.md` and release artifacts;
5. prefer package-manager source over untraceable bundled JS/binaries.

No ZViewer font, image, icon, WASM binary or bundled media fixture is approved for migration by this Phase 0 document.

