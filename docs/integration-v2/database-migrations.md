# TongMu V2 database migration and recovery

## Safety contract

Phase 6A replaces production `synchronize:true` with a committed, ordered
migration chain. Startup now acquires an exclusive installation lock and runs:

```text
acquire runtime DB lock
  -> load database with synchronize:false
  -> integrity_check + foreign_key_check
  -> exact schema fingerprint classification
  -> validate existing SecretVault envelopes/key
  -> verified backup when an existing database will change
  -> baseline adoption or ordered migrations in transactions
  -> integrity/FK/schema/credential verification
  -> application initialization
  -> HTTP and Socket.IO listen
```

An unrecognized schema, corrupt database, orphaned foreign key, conflicting
migration history, unreadable credential, missing/wrong key, failed backup, or
failed migration stops startup. `synchronize` never repairs an unknown schema.

## Persistence inventory

The default database is `<CONFIG_DIR>/dev.sqlite`; Docker continues to use
`/app/config/dev.sqlite` through the existing `/app/config` volume. The
SecretVault master key is `<CONFIG_DIR>/secret-vault.json`. The database and
that key are one recoverable unit whenever encrypted credentials exist.

`ExpectedSchemaV2` is defined in
`backend/src/migrations/database-upgrade.ts`. Its fingerprint is:

```text
99b1097bff5278e0365bf0336c29a1369fd6abc0345932f98c3c44ac7934a7a9
```

The static inventory covers columns, normalized SQLite types, nullability,
defaults, primary keys, unique/explicit indexes, and foreign keys for:

| Area | Tables / durable identity |
| --- | --- |
| Users and auth | `user` including password hash, role/status, avatar and token invalidation |
| Rooms and sessions | `room`, `session`; room owner, approval/mute/moderator/Voice state |
| Movies/media | `movie`, `playback_states`; legacy source fields remain compatible |
| Provider mounts | `user_mount`; Local has no credential, WebDAV/FTP/OpenList/Emby/Jellyfin fields remain |
| Provider credentials | `bilibili_credential`, `ncm_credentials` |
| Music | `music_queue_items`, `music_room_states`; stable queue IDs/order and independent generation/version |
| Comments/danmaku | `comment`, `danmaku_track`, `room_danmaku_meta` |
| Settings/admin | `system_settings`, `server_folder`, `audit_logs` |

The fixture suite compares a database created by all migrations against an
isolated schema inferred from the current entities. This comparison is
read-only and test-only: entity metadata never repairs production.

## Supported historical schemas

Only TongMu Git evidence is accepted. `references/**` and ZViewer schemas were
not used as historical database evidence.

| Schema ID | Evidence | Fingerprint | Notes |
| --- | --- | --- | --- |
| `tongmu-71ba034` | commit `71ba034`, first preserved TongMu entity snapshot | `fc203e7eca14ae2b67d16fde345ab13d0ac53afbf1c600effc14e06a344ec889` | pre-MediaCore columns; Bilibili Base64 and mount plaintext are represented |
| `tongmu-fe16563-media-core` | commit `fe16563` | `790729dd274e6ed59afe7ac1b8cba2dd63e84f22515071759a6f59400fc2ffc6` | adds `sourceInput` and `mediaDescriptor` |
| `tongmu-f010531-phase1` | commit `f010531`; `c239ca6` only changed credential transformers | `c7cbd128c21cc81ee9497776a6fc6123914f6d6908b7545434306f55b22cddb9` | current settings defaults/`mediaPolicyVersion` |
| `tongmu-0e322a1-voice` | commit `0e322a1` | `38b0726983d1b1e6f35e9f62c6e965895f1d66ff4a15b618e229d26334f525cb` | room moderator/Voice columns |
| `tongmu-98c6e71-realtime` | commit `98c6e71` | `d9a3ebbe0570d8b2c780ee6119b9759dfad751417a1ba5b6a9526bd699c90afd` | playback version/source generation |
| `tongmu-0707e78-music` | commit `0707e78` | `e1f8731bc652498a7c85d6688f9a1c67e4eb7776e88c4ef8ead894934cbc861c` | Music queue/state tables |
| `tongmu-8eea2bc-current-v2` | commits `8eea2bc` and `75ed7bd` | `99b1097bff5278e0365bf0336c29a1369fd6abc0345932f98c3c44ac7934a7a9` | NCM table/current synchronize-created schema |

An existing empty file and a missing file are fresh installs. Any database with
application tables whose fingerprint is absent from this table fails with
`UNSUPPORTED_DATABASE_SCHEMA`. Earlier TongMu releases not represented by the
repository history remain **UNKNOWN** and do not receive guessed migrations.

## Ordered migration chain

| Timestamp | Migration | Purpose |
| ---: | --- | --- |
| `1789160000000` | `AddMediaCoreMetadata1789160000000` | retained committed transitional media migration |
| `1790000000000` | `CreateHistoricalBaseline1790000000000` | creates the exact `71ba034` static baseline for a fresh install |
| `1790100000000` | `CompletePhase1Schema1790100000000` | ensures media columns and uses a verified shadow table for settings defaults |
| `1790200000000` | `AddRealtimePersistence1790200000000` | room Voice/moderator and playback ordering columns |
| `1790300000000` | `AddMusicPersistence1790300000000` | Music queue/state tables, constraints and foreign keys |
| `1790400000000` | `AddNcmCredential1790400000000` | fresh NCM credential schema only |
| `1790500000000` | `EncryptLegacyCredentials1790500000000` | authenticated credential conversion and envelope verification |

Fresh installs run the same chain. A current V2 database without migration
records is adopted only when its complete fingerprint exactly equals
`ExpectedSchemaV2`; schema migrations are then recorded and the credential
migration still runs. A normal second startup does not re-add columns, rewrite
credentials, create another backup, or advance the version.

Destructive `down()` migrations are intentionally unsupported. Downgrade and
recovery use a verified pre-upgrade backup instead of dropping new data.

## Credential migration

The final migration reads and validates every value before issuing updates:

- historical Bilibili Cookie/refresh token: strict legacy Base64 decode;
- WebDAV, FTP, OpenList, Emby and Jellyfin `UserMount.password`/`apiKey`:
  historical plaintext;
- existing SecretVault envelopes: decrypt validation with the installation key;
- NCM: schema-only addition for pre-NCM versions; existing NCM rows must already
  be SecretVault envelopes because no historical plaintext NCM format exists.

New envelopes are AES-256-GCM values. Each is encrypted, decrypted, and compared
with its original plaintext before database updates execute. TypeORM runs the
chain with one SQLite transaction; validation or write failure rolls back data
and migration records. A completed migration history with residual plaintext is
also rejected, so manually inserting migration rows cannot bypass the secret
gate. Raw credentials are never logged.

If encrypted rows exist and `secret-vault.json` is missing or wrong, startup
fails and does not generate a replacement key. A key may be created only when
the supported database contains legacy plaintext/Base64 values and no encrypted
record requiring an older key.

## Backup

Before the first mutation of any existing database, TongMu exports the loaded
sql.js database image into:

```text
<CONFIG_DIR>/backups/<UTC timestamp>-<schema prefix>-<nonce>/
```

The backup contains:

- `database.sqlite` (consistent sql.js export; this driver has no WAL/SHM);
- `secret-vault.json` when it existed;
- `jwt-secrets.json` when it existed;
- `manifest.json` with timestamp, source/target paths, source schema ID and
  fingerprint, target migration, file sizes, and SHA-256 hashes.

The manifest never contains secret values or database rows. The staging
directory is renamed into place only after every file and manifest are written.
Backup failure blocks migration. A marker references the successful backup so a
retry after a failed migration reuses it instead of producing unlimited copies.

Retention is capped at 20 verified automatic backups by default, always keeping
at least two. Only directories matching TongMu's backup ID format and containing
a matching valid manifest are eligible for pruning. Operators should still take
an external copy of the complete `config/` directory before upgrading; uploads,
certificates, media, custom files, `.env`, and external environment secrets are
outside the small automatic schema backup.

## Restore

Stop TongMu, then run from the repository/release directory:

```powershell
npm run build -w backend
npm run database:restore -w backend -- <backup-id>
```

The restore command acquires the same runtime database lock, so it refuses to
run while TongMu is active. It validates the backup ID/path, manifest, every
size/hash, SQLite integrity, foreign keys, schema fingerprint, and DB/key
decryption coupling. Files are staged beside their live targets. Live files are
renamed to recoverable `restore-old` names before staged files are installed;
any caught failure rolls back the already replaced files. A key/config file
that did not exist in the backup is removed from the restored state, preventing
a newly generated post-upgrade key from being paired with a historical DB.

After a successful restore, start TongMu normally. Restoring a historical
backup intentionally runs the supported migration chain again.

## Failure and interruption behavior

- `PRAGMA integrity_check` must return exactly `ok` before and after migration.
- `PRAGMA foreign_keys` must be enabled and `foreign_key_check` must be empty.
- sql.js export resets connection PRAGMAs, so TongMu's auto-save callback
  re-enables foreign keys immediately after every persisted export.
- A process-lifetime `database-migration.lock` contains PID, host, timestamp and
  nonce. A live same-host PID blocks another initializer/restore. A dead
  same-host lock is archived with a stale suffix; a different-host or malformed
  lock fails closed because liveness cannot be proven safely.
- `database-migration-state.json` is written after backup and before mutation.
  A restart retries only when the DB still has the recorded source fingerprint,
  or accepts a completed current schema/migration history that crashed before
  marker cleanup. Any third state is `INCOMPLETE_DATABASE_MIGRATION` and requires
  restore.
- TypeORM/sql.js does not auto-save while inspection and backup are running.
  Auto-save is restored only immediately before the first baseline/migration
  mutation.
- HTTP and Socket.IO are constructed and listen only after final verification.

## Verification matrix

`backend/test/phase6a-database-migrations.suite.js` covers missing DB, existing
empty DB, every schema above with representative data, current baseline
adoption, existing migration records, fully migrated repeated startup, schema
drift, corrupt/unknown DB, wrong/missing key, backup failure, migration failure
and retry, multiple interruption points, Unicode/space paths, active/stale lock,
atomic restore rollback, missing/wrong restore key, and the full
backup→migrate→mutate→restore→migrate flow.

Docker is not available on the current Windows validation host. `/app/config`
path semantics are covered through configurable temporary directories, but the
container migration smoke remains a separate environment gate.
