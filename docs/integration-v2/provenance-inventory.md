# TongMu provenance inventory

Last audited: 2026-09-20. This inventory covers source code, runtime
dependencies, copied or adapted code, patches, browser assets, native/WASM
binaries, reference-derived files and generated release contents. It is a
source/provenance record, not a statement that upstream trademarks are
licensed.

## Evidence and release rule

- `package-lock.json` is the exact npm graph: 1,092 installed package entries,
  including versions, resolved sources and integrity values where npm provides
  them. The direct runtime packages are enumerated below; transitive packages
  are not duplicated into this prose document because the lockfile is the
  machine-auditable inventory.
- Every signed release contains this document as `PROVENANCE-INVENTORY.md`, the
  applicable `THIRD-PARTY-NOTICES.md`, and `artifact-inventory.json`. The last
  file records the path, size and SHA-256 of every other file in the archive.
- `references/` is audit-only and is never packaged. A row saying “reference”
  does not authorize copying the whole reference project.
- No tracked font file exists. The font picker uses installed system fonts.
- Test media and historical databases are generated fixtures and are not
  release inputs.
- No incorporated item remains classified as `UNKNOWN`. The vendored
  Mediabunny bytes are tied to an immutable ZViewer commit as described below;
  the older mutable branch name is not used as the sole evidence.

## Direct runtime dependency inventory

Versions below are the installed versions verified with `npm ls --omit=dev
--depth=0`; package metadata and distributed license files were inspected.

| Area | Packages and exact versions | License evidence |
| --- | --- | --- |
| root runtime | `multer@2.2.0`, `sql.js@1.14.1` | MIT |
| root runtime | `node-forge@1.4.0` | BSD-3-Clause OR GPL-2.0; TongMu consumes it under the package's dual-license expression |
| root types shipped by pkg tooling | `@types/multer@2.2.0` | MIT |
| backend | `@neteasecloudmusicapienhanced/api@4.40.1`, `@xmldom/xmldom@0.9.10`, `basic-ftp@6.0.1`, `cheerio@1.2.0`, `cookie-parser@1.4.7`, `cors@2.8.6`, `express@5.2.1`, `express-rate-limit@8.6.2`, `http-proxy-middleware@4.2.0`, `jsonwebtoken@9.0.3`, `nanoid@5.1.16`, `opencc-js@1.0.5`, `qrcode@1.5.4`, `socket.io@4.8.3`, `typeorm@0.3.30`, `undici@7.28.0`, `xpath@0.0.34`, `yauzl@3.2.0` | MIT |
| backend | `bcryptjs@3.0.3` | BSD-3-Clause |
| backend | `dotenv@17.4.2` | BSD-2-Clause |
| backend | `node-media-server@4.2.8`, `playwright@1.62.0` / `playwright-core@1.62.0`, `reflect-metadata@0.2.2` | Apache-2.0 |
| backend | `semver@7.8.5` | ISC |
| backend | `tar@7.5.22` | BlueOak-1.0.0 |
| backend | `webdav-client@1.4.3` | Unlicense |
| backend type packages | `@types/bcryptjs@2.4.6`, `@types/cookie-parser@1.4.10`, `@types/jsonwebtoken@9.0.10`, `@types/node-media-server@2.3.7`, `@types/qrcode@1.5.6` | MIT |
| frontend | `@material/material-color-utilities@0.4.0`, `flv.js@1.6.2`, `hls.js@1.6.16` | Apache-2.0 |
| frontend | `dashjs@4.7.4` | BSD-3-Clause |
| frontend | `@swarmcloud/dashjs@0.10.0`, `lucide-react@1.23.0` | ISC |
| frontend | `artplayer@5.4.0`, `clsx@2.1.1`, `danmaku@2.0.9`, `playsvideo@0.4.7`, `react@18.3.1`, `react-dom@18.3.1`, `react-router-dom@6.30.4`, `socket.io-client@4.8.3`, `tailwind-merge@3.6.0`, `zustand@5.0.14` | MIT |
| frontend vendored | `mediabunny@1.38.1` compatibility fork snapshot | MPL-2.0; exact-byte chain below |

The lockfile also contains development/build dependencies and all transitive
runtime dependencies. Seven transitive packages whose npm metadata omits a
`license` field (`busboy`, `console-browserify`, `querystring-es3`,
`spawn-command`, `streamsearch`, `timers-browserify`, and
`xmlhttprequest-ssl`) carry MIT text in their distributed LICENSE/readme files.
The two workspace rows and the local Mediabunny link are not unresolved npm
packages.

## Vendored, generated and binary components

| Component | Exact source and evidence | Local change | License / shipped use |
| --- | --- | --- | --- |
| Mediabunny compatibility snapshot | `zero-wyc/ZViewer` commit `cb14443b07b11c734ea8a9dbcfd1dee4900d920c`, path `frontend/vendor/mediabunny/dist/**`; TongMu baseline commit `71ba0342b043193d243dade07970cefdd6b680e9` is byte-identical. The source metadata names `kzahel/mediabunny` `integration`; the mutable branch alone is not treated as the immutable locator. | DTS support edits marked in `codec.js`, `matroska/ebml.js`, and `matroska/matroska-demuxer.js` were already present in the immutable ZViewer source and are retained unchanged by TongMu. | MPL-2.0. Bundled into the frontend JavaScript. |
| playsvideo | npm `playsvideo@0.4.7`, repository `kzahel/playsvideo`; distributed LICENSE copyright 2026 Kyle Graehl. | `patches/playsvideo+0.4.7.patch` adapts package compatibility; patch applies only to 0.4.7. | MIT. Bundled into frontend. |
| ffmpeg audio WebAssembly | Distributed inside `playsvideo@0.4.7`: `ffmpeg-core.js` SHA-256 `409c1b8dc5f53efc7b04d27781d4d4971f1bbb3b184ee3d57d9824ee91363a88`; `ffmpeg-core.wasm` SHA-256 `5fd404eb005f6e37f4b81105676fa7039d9d3fe463bcad21aff87b5de2bf462b`. | None in TongMu. Vite renames the output asset. | LGPL-2.1, runtime-loaded audio-only build; playsvideo states no GPL codecs are compiled in. |
| sql.js WebAssembly | npm `sql.js@1.14.1`; `sql-wasm.wasm` SHA-256 `438c88f666dc054ce4e9395f80fe9db4218b1a3c379960454880f048a7898aed`. | None. | MIT. Embedded in packaged backend. |
| Playwright runtime | npm `playwright-core@1.62.0`; official Docker image `mcr.microsoft.com/playwright:v1.62.0-noble`. | `patches/playwright-core+1.62.0.patch` only tolerates the inspector-free pkg runtime. | Apache-2.0. Package metadata ships in single-file builds; Chromium itself is supplied externally or by the Docker image. |
| NCM server implementation | npm `@neteasecloudmusicapienhanced/api@4.40.1`, repository `NeteaseCloudMusicApiEnhanced/api-enhanced`. | No source copied; only allowlisted server calls. | MIT. Backend only. |

## Public assets and copied runtime files

All rows below entered TongMu through the immutable ZViewer snapshot above.
Except for `voice-processor.js`, they remain byte-identical to that snapshot.
The upstream snapshot is MIT, copyright 2025 Zero-wyc. Brand glyphs inside
`icons.svg` remain subject to their owners' trademark rules.

| Release path | SHA-256 | Purpose / local status |
| --- | --- | --- |
| `frontend/dist/favicon.jpg` | `ee0cb5dfa9858dc92c4d51ef3f7c1f01484ed25a44bb9d3629c71d6b86651fd1` | Application favicon; unchanged. |
| `frontend/dist/icons.svg` | `b45fa506195cfcdef406ba9f0c77b36ddc1a7c224040926ec70abc2fdea7b93a` | UI and service-brand symbol sprite; unchanged. |
| `frontend/dist/Nacho3.jpg` | `6bb9ed6974b6cff4be259d6441c227228b9efab190c48b33b6540ac23b97ab25` | Default/public image; unchanged. |
| `frontend/dist/player-empty.jpg` | `f34784e3ff57c3ffe56b0434acc66bce520bf9263c5d01f6025eae5230f05be0` | Empty-player artwork; unchanged. |
| `frontend/dist/root-avatar.jpg` | `c6adf54536d044afe1894067a19792555e707070997407ca727317a2dffd327f` | Default root avatar; unchanged. |
| `frontend/dist/voice-processor.js` | source SHA-256 `3ad4cbb065ef8f3d25bdabfbeefd6fa1b7d0648059121841fe8d0c84b746d971` | Derived from the same ZViewer worklet and then changed in TongMu Phase 4 for bounded voice transport. |
| `frontend/dist/zviewer-cli-windows-amd64.exe` | `6607ea893c3c7447173fa48c5f8e58fd03e5d49838b3bc51eb619427bd71100d` | Optional legacy CLI binary; byte-identical to ZViewer snapshot. Its historical filename is retained for compatibility. |

## Reference-derived code and patches

| Source | Adoption boundary | License / evidence |
| --- | --- | --- |
| SyncTV | Provider lifecycle, media proxy/manifest concepts, compatibility ledgers and bounded adaptations identified in `upstream-adoption-matrix.md`. The reference tree is never packaged. | MIT; notice retained in `THIRD-PARTY-NOTICES.md`. |
| ZViewer | Baseline UI/runtime and the exact public assets above. TongMu preserves old API/database/file names only where compatibility requires them. | MIT, immutable source commits recorded above. |
| `patches/playsvideo+0.4.7.patch` | Package compatibility patch, version-bound. | Derived from MIT playsvideo. |
| `patches/playwright-core+1.62.0.patch` | Pkg runtime debugger detection tolerance, version-bound. | Derived from Apache-2.0 Playwright Core. |

## Generated release contents

`frontend/dist/assets/*` is generated by Vite from TongMu code and the exact
locked dependencies above. Hashed filenames can change between builds, so the
release-local `artifact-inventory.json` is authoritative for a particular
archive. `zviewer-backend[.exe]` and `zviewer-cert[.exe]` are generated by
`@yao-pkg/pkg`; start scripts and `browser-runtime.json` come from
`packaging/`. User databases, secrets, uploads, media, backups, logs,
`references/`, `.env`, and test output are forbidden from release archives.
