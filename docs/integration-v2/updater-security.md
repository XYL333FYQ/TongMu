# TongMu updater security and transaction model

## Trust and source policy

The updater is disabled unless `TONGMU_UPDATE_REPOSITORY=owner/repository` is
set. The historical `zero-wyc/ZViewer` source is rejected. The configured
repository is only a discovery location: a release is accepted only when its
signed manifest says product `TongMu`, matches the local platform/architecture,
matches the release tag, names one exact asset and passes the configured
trusted-key policy.

Metadata and downloads require HTTPS. Every redirect is bounded and rechecked
against the GitHub/download-host allowlist and public DNS results. Private,
loopback, link-local and reserved targets are rejected. Metadata has response,
content-type and timeout limits; artifacts have signed size limits. A localhost
exception exists only when an explicit test/development flag is set.

## Verification order

The updater performs these gates before any program file can move:

1. canonical manifest parse and product/tag/platform/architecture validation;
2. Ed25519 signature verification using an active or retired trusted public key;
3. exact asset-name and GitHub asset-size match;
4. bounded download into `config/update-state/staging/<update-id>/download`;
5. exact downloaded size, then SHA-256 match;
6. repeat signature verification at the extraction boundary;
7. archive scan and safe extraction into a new `extracted` directory;
8. runtime inventory and forbidden-content validation.

Checksum or signature failure deletes the transaction staging directory and
marks the transaction failed. The legacy upload endpoints remain present for
API compatibility but reject unsigned archives; there is no production
environment-variable typo that downgrades verification.

## Archive policy

ZIP and tar archives are scanned before extraction. The scanner rejects `..`,
absolute/UNC/drive paths, backslashes in archive names, NULs, NTFS alternate
stream syntax, trailing dot/space ambiguity, Windows device names, duplicate or
case-insensitive-colliding paths, symlinks, hardlinks and special files.
Expansion count and total size are bounded. Only the declared runtime
top-level allowlist is accepted, and any `config`, upload, media, backup,
database, `.env`, secret or log path is rejected.

## Staging, switch and recovery

The API only prepares a `ready-to-apply` transaction. The platform launcher
stops the old process, copies the current executable to a helper under the
persistent update-state directory, and asks that helper to switch program
entries. Existing program entries move to `previous-program`; verified staged
entries then move into the install root. Each operation is idempotent, so an
`applying` marker is completed safely after interruption. `config/` is never a
member of the program entry set.

The marker records update ID, from/to version and SHA, artifact hash, stage and
timestamps, but no repository token, cookie, private key or credential. A
separate `program-update.lock` permits one update transaction. The helper also
refuses a swap or rollback while the Phase 6A database lifecycle lock has a live
owner; the two locks are deliberately not conflated.

After launch, the launcher calls local `/health` and requires `status=ok` plus
the exact signed version and SHA. Only then is `previous-program` deleted and
the marker moved to `healthy`. A failed health identity stops the new process
and restores the previous program. Incomplete download/extraction is discarded;
an interrupted swap resumes idempotently; a stale same-host update lock is
archived rather than blindly deleted.

## Database migration boundary

Program rollback and database rollback are separate. The new process can run a
Phase 6A schema migration before `/health`. Therefore program rollback marks
`databaseRestoreRequired: true` and the operator must restore the matching
pre-upgrade Phase 6A database backup when the old binary cannot read the new
schema. No updater code promises unconditional binary-only downgrade, and the
program backup never copies the whole config directory.

## Authorization

All updater routes are server-side authenticated and root-only. Cookie-backed
POST endpoints additionally require exact same-origin proof; bearer-authenticated
automation is not exposed to ambient-cookie CSRF. Hiding frontend controls is
not an authorization mechanism. Error messages are bounded and do not include
tokens, signing private keys, cookies, config contents or provider credentials.
