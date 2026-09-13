# TongMu

TongMu is a synchronized watch-together and room-interaction platform. When a browser can reach the source or CDN directly, the client connects directly. The server focuses on rooms, synchronization, interaction, media resolution, and playback coordination; Media Gateway is a fallback when Direct First is not viable.

TongMu evolved from the ZViewer codebase. Its media-core design was reviewed against the local read-only SyncTV reference under `references/synctv`; references are intentionally excluded from the published repository.

## Core principles

- Original Quality First and Direct First; Proxy as Fallback.
- Resolve Once, Stream Independently, with explicit failure reporting.
- Public Metadata / Private Credentials: credentials and origin headers stay server-side.
- Shared Media / Local Playback Plan: rooms share media facts, while each client selects its own playback engine.
- No Video Transcoding by Default; existing browser-side playback paths handle compatible remuxing when available.
- BrowserResolver is available in the recommended Docker image with Playwright and Chromium.

## Docker quick start

Use the root `docker-compose.yml`; it is the single recommended Compose entry point.

```bash
cp .env.example .env
# Set production JWT secrets and CORS_ORIGIN in .env.
docker compose config
docker compose up -d --build
```

Open `http://localhost:3333`. Port 3333 serves the API, Socket.IO, frontend, and `/live` HTTP-FLV endpoint. Port 3334 is the OBS RTMP port. The container uses the Playwright Chromium image and a 1 GB shared-memory allocation. The historical `zviewer-browser-data` volume name is retained for data compatibility.

## Development and tests

```bash
npm install
npm run dev
npm run lint -w backend
npm test -w backend
npm run build -w frontend
npm test -w frontend
npm run test:e2e
```

Keep the whole `config/` directory across upgrades. It contains the SQLite database, generated secrets, certificates, uploads, avatars, and media segments. `.env`, runtime data, logs, test artifacts, and `references/` are ignored by Git.

## Upstream and license

The published source is distributed under the root [MIT License](LICENSE), with the original `Copyright (c) 2025 Zero-wyc` notice retained. TongMu evolved from [ZViewer](https://github.com/Zero-wyc/ZViewer) and references [SyncTV](https://github.com/synctv-org/synctv) media proxy, manifest, and provider designs. The local SyncTV source and its MIT license remain under `references/synctv/` and are not published with TongMu.

The release-tree attribution notice is in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

Historical `zviewer-*` executable names, storage keys, environment identifiers, updater names, and Docker volume names remain where renaming could break compatibility.
