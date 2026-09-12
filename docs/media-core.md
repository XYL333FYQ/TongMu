# ZViewer 2.0 media core

The existing room, synchronization and player engines remain the product core. The new pipeline only decides what an input represents and how the existing player should open it:

```text
input -> SourceResolver -> MediaProbe -> MediaDescriptor
      -> PlaybackPlanner -> encrypted media handle -> existing player engine
```

## Resolver order

1. `BilibiliResolver` handles BV identifiers and Bilibili URLs and adapts the existing, site-specific resolver.
2. `DirectUrlResolver` probes HTTP(S) media, including URLs without a file suffix.
3. `GenericWebResolver` reads at most 1 MiB of HTML/JSON and combines `<video>`, `<source>`, Open Graph video metadata, JSON-LD, nested player configuration, and embedded media URLs. It scores all candidates and penalizes common ad/preview/tracking names before probing up to twelve candidates.
4. `BrowserResolver` is an optional fallback for JavaScript-generated sources. It watches media responses and bounded playback-API JSON, ignores individual `.m4s`/`.ts` segments, keeps needed Referer/Origin/User-Agent/Cookie headers server-side, and submits ranked candidates to the same probe.

Browser sniffing is deliberately not a DRM bypass. MPD `ContentProtection`, Widevine, PlayReady, FairPlay and CENC markers produce a blocked plan and an explicit user error.

## Probe and planner limits

`MediaProbe` treats URL suffix and `Content-Type` as hints. It performs advisory HEAD, then a bounded `Range: bytes=0-65535` GET. If Range is ignored it reads at most 64 KiB and cancels the body. It recognizes HLS, MPD, ISO-BMFF/MP4, EBML/Matroska/WebM, FLV and MPEG-TS magic. Timeout is 8 seconds and process-wide probe concurrency is four.

The planner chooses direct, HLS, standard MPD/DASH, FLV or the existing playsvideo pipeline. It also checks the requesting browser's native HLS, MediaSource, Worker/playsvideo and HEVC capabilities and returns an explicit unsupported reason rather than allowing a predictable black screen. MKV/TS prefer remux with video copy. DTS/AC3/EAC3/TrueHD produce an audio-only AAC transcode plan with video copy. It never silently selects full video transcoding; the project has no server transcoder.

Codec, dimensions and track metadata are available when a specialized resolver supplies them (currently Bilibili and mounted/server sources). Generic direct URLs only receive container-level bounded probing because the server does not bundle ffprobe. The existing browser playsvideo/mediabunny path performs deeper demuxing when playback needs it.

## Secure media gateway

`POST /api/stream/media/resolve` returns a media descriptor, playback plan and an encrypted, authenticated media handle. AES-256-GCM hides the upstream URL and anti-hotlink credentials. The handle expires after 12 hours and is bound to the room supplied by the host, or to the requesting user when no room is supplied. The key comes from `MEDIA_HANDLE_SECRET`; otherwise it is generated once inside `config/jwt-secrets.json`, so handles survive restarts when `config/` is persistent.

Room handles require a separate encrypted room grant issued only after that exact Socket.IO connection joins the room. Every media request verifies both the grant and its database Session; normal leave, disconnect, or kick ends that Session, and startup closes any Sessions left active by a previous process before accepting requests. This is a database-backed capability check, not a direct live Socket.IO membership query. Guests are isolated by socket capability rather than the shared numeric guest user ID. User-scoped handles remain bound to their original user.

The gateway revalidates HTTP(S), DNS results and every redirect. Public inputs cannot reach loopback, RFC1918, link-local, metadata, multicast or reserved ranges. Unsafe forwarding headers are removed. HLS manifests rewrite playlists, segments and key URLs into child handles. Standard MPD inheritance is parsed as XML: MPD, Period, AdaptationSet and Representation `BaseURL` values are resolved in order, inherited templates are materialized per Representation, and each base receives an origin-constrained child handle. Cookie/Authorization-like headers are valid only for their recorded credential origin and are stripped after cross-origin redirects.

Range is passed through exactly. A valid upstream 206 retains `Content-Range`, `Content-Length` and status. If an upstream ignores a non-zero seek Range and answers 200, the gateway cancels it and returns 502 instead of downloading an entire movie or falsely advertising seek support. Only the initial open-ended `bytes=0-` request may degrade to an honest 200 sequential stream; no `Accept-Ranges` or `Content-Range` is invented. playsvideo remux/transcode is blocked when the probe confirms that Range is unavailable.

## Browser Resolver deployment

It is off by default because Chromium is resource-intensive and visits untrusted pages.

```dotenv
MEDIA_BROWSER_RESOLVER=true
MEDIA_BROWSER_MAX_CONCURRENCY=1
MEDIA_HANDLE_SECRET=a-long-random-deployment-secret
# Optional when Chromium is installed by the OS:
PLAYWRIGHT_EXECUTABLE_PATH=/usr/bin/chromium
```

Install the browser once for a source deployment:

```bash
npm ci
npx playwright install chromium
npm run build
npm start
```

For Linux containers, keep the default `Dockerfile.linux-single` image lightweight, or explicitly select the Chromium-enabled image:

```bash
docker compose -f docker-compose.linux-browser.yml up -d --build
```

`Dockerfile.linux-browser` is pinned to the Playwright 1.62 Chromium image, enables `MEDIA_BROWSER_RESOLVER`, reserves a 1 GiB shared-memory area, and persists `/app/config`. Keep concurrency at one for small deployments. Set a stable, random `MEDIA_HANDLE_SECRET` in the Compose environment for production; otherwise the persisted config volume supplies the generated key. The lightweight image still does not contain Chromium and should leave Browser Resolver disabled.

Every Chromium connection is forced through a short-lived loopback proxy owned by the resolver. The proxy validates the destination, resolves all addresses, rejects any non-public answer, and connects to the already-validated IP. This closes the DNS-rebinding gap between a page-route check and Chromium's actual socket. The request interceptor remains as an earlier rejection layer. High-risk multi-tenant deployments should still isolate Chromium with an egress firewall as defense in depth.

## Database transition

The historical database still uses `synchronize: true`; switching it off without a complete baseline migration would risk existing installs. This release introduces the first idempotent migration for `sourceInput` and `mediaDescriptor` and an opt-in migration runner:

```dotenv
TYPEORM_MIGRATIONS=true
```

The stored descriptor never contains resolver headers/cookies. It keeps diagnostics, the original input, selected Bilibili quality metadata, signed room handles and the playback plan. Playback reuses an unexpired handle directly. Only the room host may refresh an expiring shared source and broadcast the replacement; viewers never independently re-resolve it with their own account/Cookie state. A later release can add a complete historical baseline and then safely disable synchronize.

## Validation

```bash
npm ci
npm test --workspace=backend
npm run test:e2e
npm run lint --workspace=backend
npm run build --workspace=frontend
npm run build
```

Automated fixtures cover magic detection for MP4, WebM, Matroska, AVI, WMV/ASF, TS, FLV, HLS and DASH; DRM; extensionless URLs; HTML behind misleading media suffixes; independent HEAD/Range timeouts; no-Range servers; anti-hotlink headers; signed/encrypted room handles; deterministic SSRF/DNS checks; exact 206 and sequential-200 semantics; Browser Resolver Cookie provenance and JSON limits; nested DASH BaseURL/SegmentTemplate/SegmentList resolution; candidate scoring; and planner remux/audio-only decisions. Playwright starts an isolated full stack and performs real playback of generated MP4 and extensionless MP4 (including seek), HLS master/extensionless child/AES-128/fMP4, and DASH nested BaseURL audio/video adaptations. It also verifies that HLS/DASH child requests remain authorized after a two-second access JWT expires, and checks the unified panel at 390 px without horizontal overflow.

## Manual acceptance checklist

- Bilibili page/BV: default DASH, requested and actual quality visible, MP4 compatibility explicitly capped at 720P.
- Ordinary static video page: selects the main `<video>`, JSON-LD or player-config candidate rather than an ad.
- JavaScript video page: enable Browser Resolver and confirm resolver=`browser`; CAPTCHA/login/DRM sites may correctly remain unsupported.
- MP4 and extensionless MP4; MKV and extensionless MKV; WebM; TS; FLV.
- HLS master/media playlists and AES key loading; standard MPD with relative segment templates.
- MKV H264/AAC remux and MKV H264/DTS audio-only conversion through playsvideo.
- Referer-, Origin- and Cookie-protected media; credentials must not appear in the returned descriptor or browser URL.
- Seek: client Range receives the same 206, `Content-Range` and body slice.
- Quality switching: a downgrade always shows requested, actual and fallback reason.

## Known limits

- Generic parsing cannot defeat CAPTCHA, login workflows, obfuscated/proprietary players or DRM.
- Browser sniffing captures normal page-session cookies only; it does not automate account login.
- Exotic DASH features outside BaseURL, SegmentTemplate and SegmentList (for example SegmentBase byte-range indexes) may still need a site-specific resolver.
- A media handle expires after 12 hours. The host re-resolves it on playback when it is near expiry; this refresh is on demand rather than a background scheduler.
- Full video transcoding and server-side ffprobe are intentionally not bundled.
