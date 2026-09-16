# Phase 5B-2A NCM provider core

## Status and boundary

Phase 5B-2A is complete for the NCM provider, server-private credential
boundary, QR login/session lifecycle, explicit-quality resolution, and
room-authorized music playback. It does not implement NCM catalog/search,
playlists, albums, artists, FM, cloud music, lyrics, comments, likes, or a
full NCM product browser. Those items remain Phase 5B-2B work.

This module does not claim official NCM API authorization. The upstream API is
an unofficial technical dependency and must remain subject to deployment
operator review, applicable terms, and account/provider availability.

## Provider contract

NCM songs enter the music domain through a bounded stable reference:

```text
music://ncm/track/<positive decimal track id>
```

`NcmMusicProvider` is registered in the credentialed music provider registry.
It resolves the reference only after the room capability has selected the
credential owner and an explicit `requestedQuality`. The resolution has two
parts:

- `MusicPrivateSource` contains the short-lived upstream URL, server-only
  request headers, credential owner, requested/actual quality, codec, expiry,
  and availability facts.
- `MusicPublicDescriptor` contains safe track/codec/quality/duration facts and
  never contains the upstream URL, request headers, Cookie, or another
  credential-bearing field.

The NCM URL is validated before use. Production URLs must be HTTPS/HTTP audio
URLs on `music.126.net` or its subdomains; the local deterministic fixture
origin is an allowlist exception only in the test environment. NCM routes do
not accept arbitrary upstream URLs and do not forward arbitrary NCM paths.

`NcmApiClient` is the only NCM HTTP wrapper. Its allowlist is limited to QR
key/create/check, login status, logout, and the song URL endpoint. It owns
Cookie/CSRF header injection, the bounded request timeout, caller
`AbortSignal`, a 2 MiB JSON response bound, JSON validation, user-agent
policy, redacted errors, and one bounded retry for transient transport/5xx
failures. `NCM_API_BASE_URL` can point to a separately managed API service. If
it is not set, the pinned server-only dependency is started on loopback on a
bounded port range; it is never started as a browser dependency.

## Credential and QR boundary

`NcmCredential` stores user/provider metadata plus a `SecretVault` AES-256-GCM
envelope. The decrypted credential is available only for the duration of an
internal provider request. New NCM writes do not use plaintext or reversible
Base64 storage. Public status returns login/profile/version facts only.

QR sessions are held in a user-bound, bounded in-memory state machine. The
public states are `qr-created`, `waiting`, `scanned`, `authorized`,
`logged-in`, `expired`, and `failed`. A session ID cannot be polled by another
user, a new login supersedes the user's previous session, expiry is bounded,
and logout invalidates the active QR session, clears the usable encrypted
credential, and persists a credential-free version tombstone. Cookies never
enter queue rows, room snapshots, socket payloads, frontend storage, logs, or
public DTOs.

Guests may participate in a room, but the login routes require an
authenticated user because a guest has no persistent credential owner.

## Room authorization and playback

`POST /api/music/resolve` accepts only a room grant, the current queue item,
the current `musicGeneration`, the stable source reference, and an explicit
quality. The server checks the active member/session and the authoritative
`MusicSyncDomain` track before resolving the owner credential. The owner is
the room owner (with the existing host fallback for legacy rooms), not a
credential supplied by the browser.

The response contains a safe descriptor and an opaque TongMu playback URL.
The sealed capability binds:

- room and current member/socket;
- actor identity;
- owner credential and monotonic credential version;
- stable track reference and queue item;
- current `musicGeneration`; and
- the requested quality.

`GET`/`HEAD /api/music/playback/:id` re-checks membership, actor, owner
credential version, current track, and generation before every stream. A
viewer who only knows a track ID cannot create a capability, reuse a
capability in another room, or use the host's capability as another actor.
Leaving the room, owner logout, a credential replacement, or a track switch
revokes future access without waiting for the short capability TTL. Logout's
version tombstone survives a process restart, so a later login cannot reuse an
old capability version.

Credentialed playback uses the opaque gateway by default. It reuses the shared
HTTP proxy/ByteRange semantics: exact single ranges, open/suffix ranges,
`200`/`206`/`416`, `HEAD`, and ignored non-zero `Range` responses. If an
upstream URL expires or returns `401`/`403`, the gateway re-resolves the same
stable reference with the same requested quality once and then applies the
same range validation. No new audio cache is introduced.

## Explicit quality and codec behavior

The supported quality vocabulary is `standard`, `higher`, `exhigh`,
`lossless`, `hires`, `jyeffect`, `sky`, and `dolby`, but a value is usable
only when the upstream response supplies that actual level. Every resolution
publishes `requestedQuality`, `actualQuality`, `availableMaximum`,
`availableQualities`, and codec/container/MIME facts.

If the requested level is unavailable, the provider returns the typed
`NCM_QUALITY_UNAVAILABLE` error with safe availability facts. It does not
silently select `standard`, `higher`, or any other lower level. The old
`QUALITY_CHAIN` behavior is intentionally absent. If the browser cannot play
the returned MIME/codec, the client reports an explicit capability error and
does not lower quality automatically. If the upstream marks the response as a
preview/trial window, TongMu returns `NCM_STREAM_UNAVAILABLE`; it does not use
an unblock source or another CDN to bypass a paid, VIP, or copyright limit.

## Verification and real-environment limits

The deterministic local fixture covers QR waiting/authorization, encrypted
credential storage, cross-user QR rejection, exact-quality rejection, codec
facts, actor/generation capability checks, owner credential use, upstream
auth-failure re-resolution, exact Range bytes, track-switch invalidation, and
member-leave revocation. Chromium covers the visible QR flow, login state,
NCM queue item, opaque playback URL, descriptor redaction, viewer playback,
and a viewer Range request.

Real NCM account/cookie validation was **NOT RUN** in this environment because
no real account or credential was supplied. Passing the local fixture does not
prove upstream account availability, API terms, regional behavior, or every
NCM quality tier.

See `progress.md`, `implementation-plan.md`, and
`upstream-adoption-matrix.md` for the phase ledger and remaining 5B-2B scope.
