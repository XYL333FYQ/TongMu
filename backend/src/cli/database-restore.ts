#!/usr/bin/env node
import { restoreDatabaseBackup } from '../migrations/database-restore';

async function main(): Promise<void> {
  const backupId = process.argv[2];
  if (!backupId) {
    console.error('Usage: node dist/cli/database-restore.js <backup-id>');
    process.exitCode = 2;
    return;
  }
  const result = await restoreDatabaseBackup({ backupId });
  console.log(`[database-restore] restored ${backupId}; schema ${result.schemaFingerprint}`);
  console.log('[database-restore] restore verified. Start TongMu to run any required migrations.');
}

main().catch((error) => {
  console.error(`[database-restore] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
