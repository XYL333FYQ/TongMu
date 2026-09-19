# Upgrading TongMu to V2 safely

This guide is for normal self-hosted TongMu installations. You do not need to
edit SQLite manually.

## Before the first V2 start

1. Stop the old TongMu process/container. Do not upgrade while the old server is
   still writing its database.
2. Copy the entire persistent `config/` directory to another disk or backup
   location. For Docker, this is the data mounted at `/app/config`.
3. Confirm the copy includes at least:
   - `dev.sqlite` (or your configured database file);
   - `secret-vault.json`, if present;
   - `jwt-secrets.json`, if present;
   - uploads and any certificates/config files you rely on.
4. Keep the database and `secret-vault.json` together. A database containing
   encrypted provider credentials cannot be recovered with a different key.

Do not delete the old installation or its backup until the upgraded server has
been tested with your real rooms, users and providers.

## What the first start does

Before opening the HTTP port, TongMu:

1. locks the installation against another start or restore;
2. checks SQLite integrity and foreign keys;
3. identifies the exact supported historical schema;
4. validates the existing SecretVault key when encrypted credentials exist;
5. creates a small automatic pre-migration backup under `config/backups/`;
6. runs the committed migrations and credential conversion in a transaction;
7. checks the final schema, data constraints, key and migration history;
8. starts the web server only if every check passes.

An already migrated database starts without another migration or backup.

## If startup fails

Do not delete the database, key, lock, marker, or backup. The error includes a
code such as:

- `UNSUPPORTED_DATABASE_SCHEMA`: this database does not exactly match a
  repository-proven TongMu version;
- `DATABASE_INTEGRITY_FAILED`: SQLite reported corruption;
- `DATABASE_FOREIGN_KEY_FAILED`: an orphan or disabled FK boundary was found;
- `DATABASE_SECRET_KEY_INVALID`: the key is missing/wrong or an NCM credential
  is not a supported envelope;
- `DATABASE_MIGRATION_FAILED`: migration rolled back; the message identifies
  the backup;
- `INCOMPLETE_DATABASE_MIGRATION`: a crash marker and the live schema do not
  form a safe automatic retry state.

For a normal migration failure, keep the backup directory and try the same
version again after fixing the reported disk/permission issue. TongMu reuses the
verified backup referenced by its marker. For an unknown/corrupt/ambiguous
schema, stop and preserve the files for manual recovery; do not enable
`synchronize` or add migration records yourself.

## Restore the automatic pre-upgrade backup

The startup log prints the full backup directory. Its final directory name is
the `<backup-id>` used below.

1. Stop TongMu completely.
2. Build the backend if you are running from source:

   ```powershell
   npm run build -w backend
   ```

3. Restore the selected backup:

   ```powershell
   npm run database:restore -w backend -- <backup-id>
   ```

4. Wait for `restore verified`.
5. Start TongMu normally. A restored historical database will be migrated
   again using the same safety checks.

Restore refuses an unsafe path, an active server lock, a missing/tampered file,
a bad manifest/hash, a corrupt database, a fingerprint mismatch, or a missing/
wrong SecretVault key. It stages replacements and rolls back the original live
files if a replace step fails.

## Docker notes

The persistent root remains `/app/config`; container recreation must preserve
that volume. Automatic backups are also below `/app/config/backups`, so they
survive container replacement as long as the volume survives. Keep an external
copy too—a backup inside the same volume does not protect against losing the
volume itself.

Phase 6A does not redesign Docker images, release packages, updater signatures,
or release CI. Those remain Phase 6B work.
