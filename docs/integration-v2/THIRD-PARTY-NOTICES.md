# Third-party notices

This file is copied into every TongMu release archive. Exact source commits,
asset hashes and release boundaries are recorded in `provenance-inventory.md`.
`package-lock.json` is the exact transitive npm dependency graph.

## Direct runtime packages

The following license groups cover TongMu's complete direct production
dependency set. Exact installed versions are listed in
`provenance-inventory.md` and locked by `package-lock.json`.

- MIT: multer, sql.js, all direct `@types/*` packages, the enhanced NCM API,
  @xmldom/xmldom, basic-ftp, cheerio, cookie-parser, cors, express,
  express-rate-limit, http-proxy-middleware, jsonwebtoken, nanoid, opencc-js,
  qrcode, socket.io, typeorm, undici, xpath, yauzl, artplayer, clsx, danmaku,
  playsvideo, React, React DOM, React Router DOM, socket.io-client,
  tailwind-merge and zustand.
- Apache-2.0: node-media-server, Playwright/Playwright Core,
  reflect-metadata, Material Color Utilities, flv.js and hls.js.
- BSD-3-Clause: bcryptjs and dash.js.
- BSD-2-Clause: dotenv.
- ISC: semver, @swarmcloud/dashjs and lucide-react.
- BlueOak-1.0.0: tar.
- Unlicense: webdav-client.
- BSD-3-Clause OR GPL-2.0: node-forge (dual-license expression in the
  distributed package).

Each npm package's distributed license remains authoritative. The build does
not remove copyright or license files from the source dependency tree.

## ZViewer baseline and public assets

TongMu's baseline and the public images/icon sprite/legacy CLI identified in
the provenance inventory come from `zero-wyc/ZViewer`; the exact vendored
Mediabunny source entered that repository at commit
`cb14443b07b11c734ea8a9dbcfd1dee4900d920c`. ZViewer is distributed under the
MIT License, copyright 2025 Zero-wyc. Brand symbols in `icons.svg` may also be
subject to their owners' trademark policies.

```text
MIT License

Copyright (c) 2025 Zero-wyc

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Mediabunny compatibility snapshot

- Component: local `mediabunny@1.38.1` compatibility source snapshot.
- Exact incorporated source: the immutable ZViewer commit and file hashes
  recorded in `provenance-inventory.md`; the mutable `integration` branch name
  is not used as the sole provenance locator.
- License: Mozilla Public License 2.0 (MPL-2.0).
- Modifications: inherited DTS compatibility edits are marked in the vendored
  files and are kept in source form in `frontend/vendor/mediabunny/`.
- Source availability: the complete incorporated source form and local edits
  ship in the TongMu source repository; MPL-2.0 text is available from the
  upstream repository and <https://www.mozilla.org/MPL/2.0/>.

## playsvideo and ffmpeg audio WebAssembly

- `playsvideo@0.4.7`: MIT, copyright 2026 Kyle Graehl.
- `patches/playsvideo+0.4.7.patch`: a TongMu compatibility modification of
  that MIT component.
- `ffmpeg-core.js` and `ffmpeg-core.wasm` distributed by playsvideo: LGPL-2.1,
  lazy-loaded for audio transcoding. The distributed package states that no
  GPL codecs are compiled in. Exact SHA-256 values are in the provenance
  inventory. Corresponding source/licensing information is maintained by
  `kzahel/playsvideo` and its linked ffmpeg.wasm source.

## sql.js

`sql.js@1.14.1`, including `sql-wasm.wasm`, is MIT licensed, copyright the
sql.js authors. Its exact WASM SHA-256 is recorded in the provenance inventory.

## Playwright Core

- Package: `playwright-core@1.62.0`
- License: Apache-2.0
- Purpose: optional BrowserResolver browser automation and release smoke.
- Local adaptation: `patches/playwright-core+1.62.0.patch` makes the optional
  Node debugger probe tolerate the inspector-free `@yao-pkg/pkg` runtime. It
  does not change navigation, proxy, credential or SSRF policy.

## SyncTV

TongMu 的部分 provider、媒体代理和清单处理设计，以及若干适配器的实现，参考或改写了 SyncTV 对应模块。SyncTV 的完整源码只保存在本机只读目录 `references/synctv/`，不会进入 TongMu 的 GitHub 仓库；以下通知保留给可能来自或改写自 SyncTV 的部分。

Phase 2 的 `PlaybackClientProfileV1` tuple matching、provider context/credential
dependency/lifecycle 语义，以及对应的 provider compatibility ledger，属于
对 SyncTV MIT 语义的 TypeScript 适配；`references/` 中的源码仍未复制到本仓库。

SyncTV is distributed under the MIT License:

```text
MIT License

Copyright (c) 2026 SyncTV Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## @neteasecloudmusicapienhanced/api 4.40.1

Phase 5B-2A and 5B-2B use `@neteasecloudmusicapienhanced/api` version `4.40.1`
as a server-only, lazily started NCM API implementation. TongMu calls it
through the explicit allowlisted `NcmApiClient` catalog/provider methods; the
package is never imported by the browser and its routes are not exposed as an
arbitrary forwarding surface. The implementation does not copy the reference
project's NCM pages, assets, or broad forwarding route.

Source and provenance:

- Package: [`@neteasecloudmusicapienhanced/api@4.40.1`](https://www.npmjs.com/package/@neteasecloudmusicapienhanced/api)
- Repository: [`NeteaseCloudMusicApiEnhanced/api-enhanced`](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)
- Package license: MIT
- Purpose in TongMu: QR/login status/logout, exact NCM song URL resolution, and
  bounded catalog/library/lyrics/comment reads plus supported likes behind the
  server credential, current-user, and room-capability boundaries
- Local changes: no package source was copied into TongMu; the dependency is
  pinned in `backend/package.json` and the root lockfile.

The package distribution includes the following MIT notice (copyright retained
from its distributed `LICENSE` file):

```text
The MIT License (MIT)

Copyright (c) 2013-2022 Binaryify

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```
