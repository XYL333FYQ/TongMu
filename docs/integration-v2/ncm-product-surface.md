# Phase 5B-2B NCM catalog and product surface

## Status

**COMPLETE within the bounded catalog/product boundary.** The implementation
does not claim a real NCM account was tested or that the unofficial upstream
dependency is officially authorized. A deterministic local fixture and
Chromium flow provide the repeatable verification evidence.

## Server contract

`backend/src/modules/music/ncm/ncm-catalog.service.ts` is the only service
that turns NCM responses into catalog data. `NcmApiClient` exposes explicit
allowlisted methods; routes and the browser never call the NCM package or an
arbitrary upstream path directly.

Public routes under `/api/music/ncm/` are bounded and provider-neutral:

- `search` accepts only song, playlist, album, or artist search types.
- `playlist/:id`, `album/:id`, and `artist/:id` return normalized metadata and
  bounded track/detail lists.
- `lyrics/:trackId` returns original, translated, and romanized text lines.
- `comments/:resourceType/:resourceId` supports bounded `latest` and `hot`
  pages.

Private routes are authenticated current-user operations only:
`playlists`, `liked`, `fm`, `fm/dislike`, `cloud`, `like`, and
`comment-like`. The request does not contain an account selector. The server
gets the credential from the authenticated TongMu user and keeps it inside
the NCM client/provider call.

The only queue identity emitted by the catalog is:

```text
music://ncm/track/<positive decimal track id>
```

Queue insertion goes through the existing `MusicSyncDomain` mutation. The
catalog never creates a second player, sets an audio source, or sends a raw
stream URL. The room snapshot remains the authority for queue identity,
generation, current position, and playback permissions.

## Quality behavior

The catalog can display the requested quality preference and the available
quality facts supplied by the provider. If the preferred quality is not in a
known available list, the UI asks the user to choose an available value. The
server and resolver still enforce exact requested quality; there is no silent
lower-quality fallback. After resolution, Together Listen displays requested,
actual, maximum/available facts when present. Browser codec failure is an
explicit error.

## UI behavior

The new catalog surface is embedded in the existing Together Listen card. Its
views are Search, Playlists, Albums, Artists, Liked, FM, and Cloud. Search
uses a 300 ms debounce and aborts stale requests. Playlist/album/artist
navigation, lyrics, comments, private logout clearing, account-generation
guards, and queue insertion all stay in this one surface.

Lyrics and comments are rendered as React text children, never
`dangerouslySetInnerHTML`. Lyrics highlighting uses the authoritative music
store position only when the selected track and `musicGeneration` still
match the request guard. Mobile layout uses bounded overflow and was checked
at 320 px in Chromium.

## Deferred

Cloud upload, comment posting, arbitrary user-resource management, provider
account import, real-account verification, and any official NCM authorization
claim remain deferred. The implementation does not copy the reference
project's broad arbitrary NCM proxy or its silent `QUALITY_CHAIN` behavior.
