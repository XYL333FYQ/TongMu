# Third-party notices

The detailed TongMu integration notices are maintained in
[`docs/integration-v2/THIRD-PARTY-NOTICES.md`](docs/integration-v2/THIRD-PARTY-NOTICES.md).

The canonical notice shipped in release archives is that detailed file, not
this pointer. It covers the complete direct runtime dependency set plus these
redistributed or adapted components:

- ZViewer-derived public images, icon sprite, voice worklet and legacy CLI:
  MIT, exact source and SHA-256 values in
  [`provenance-inventory.md`](docs/integration-v2/provenance-inventory.md).
- SyncTV-derived provider/media semantics and adaptations: MIT.
- `mediabunny@1.38.1` compatibility snapshot: MPL-2.0.
- `playsvideo@0.4.7` and its local patch: MIT.
- playsvideo's audio-only `ffmpeg-core.wasm`: LGPL-2.1; no GPL codecs.
- `playwright-core@1.62.0` and its pkg compatibility patch: Apache-2.0.
- `@neteasecloudmusicapienhanced/api@4.40.1`: MIT, server-only.
- `sql.js@1.14.1` and its WASM runtime: MIT.

`package-lock.json` is the machine-auditable exact npm graph. Every signed
archive additionally carries `PROVENANCE-INVENTORY.md` and a per-file
`artifact-inventory.json` with SHA-256 digests.
