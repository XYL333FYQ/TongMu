# Third-party notices

The detailed TongMu integration notices are maintained in
[`docs/integration-v2/THIRD-PARTY-NOTICES.md`](docs/integration-v2/THIRD-PARTY-NOTICES.md).

Phase 5B-2B uses the pinned MIT package
`@neteasecloudmusicapienhanced/api@4.40.1` only through the server-side,
allowlisted `NcmApiClient`. No package source, reference-project asset, or
raw NCM credential is copied into the browser bundle. The detailed notice
also records the package source, license text, and current purpose.

Phase 6B-1 packages `playwright-core@1.62.0` (Apache-2.0) for the optional
BrowserResolver. `patches/playwright-core+1.62.0.patch` only makes debugger
detection tolerate the inspector-free `@yao-pkg/pkg` runtime; it does not
weaken browser network policy. Single-file archives require an operator-supplied
Chromium/Chrome executable, while the recommended Docker image includes one.
