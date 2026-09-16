# Third-party notices

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
