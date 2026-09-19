import type { DataSource, QueryRunner } from 'typeorm';
import { CONFIG_DIR, DATABASE_PATH } from '../services/paths';

const INTERNAL_TABLES = new Set(['migrations', 'sqlite_sequence']);

export type DatabaseInstallState = 'fresh' | 'existing';

export interface MigrationInspection {
  installState: DatabaseInstallState;
  hasApplicationTables: boolean;
  migrationTablePresent: boolean;
  appliedMigrations: Array<{ name: string; timestamp: number }>;
  schemaVersion: number;
}

export interface MigrationFoundationResult {
  before: MigrationInspection;
  after: MigrationInspection;
  executed: string[];
  backupExpectation: {
    configDir: string;
    databasePath: string;
    requiredBeforeSchemaChange: true;
  };
}

export class MigrationFoundationError extends Error {
  cause?: unknown;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.cause = options?.cause;
    this.name = 'MigrationFoundationError';
  }
}

export function classifyDatabaseTables(tableNames: string[]): DatabaseInstallState {
  return tableNames.some((name) => !INTERNAL_TABLES.has(name.toLowerCase()))
    ? 'existing'
    : 'fresh';
}

async function readMigrationRows(
  queryRunner: QueryRunner,
  migrationTablePresent: boolean,
): Promise<Array<{ name: string; timestamp: number }>> {
  if (!migrationTablePresent) return [];
  try {
    const rows = await queryRunner.query('SELECT name, timestamp FROM "migrations"');
    return (Array.isArray(rows) ? rows : [])
      .map((row: { name?: unknown; timestamp?: unknown }) => ({
        name: typeof row.name === 'string' ? row.name : '',
        timestamp: Number(row.timestamp) || 0,
      }))
      .filter((row) => row.name.length > 0);
  } catch {
    // The table exists but is unreadable: callers must not mistake this for a
    // fresh database. Keep the marker visible and let migration execution fail.
    return [];
  }
}

export async function inspectMigrationState(dataSource: DataSource): Promise<MigrationInspection> {
  const queryRunner = dataSource.createQueryRunner();
  try {
    const tables = await queryRunner.getTables();
    const names = tables.map((table) => table.name);
    const migrationTablePresent = names.some((name) => name.toLowerCase() === 'migrations');
    const appliedMigrations = await readMigrationRows(queryRunner, migrationTablePresent);
    const schemaVersion = appliedMigrations.reduce(
      (max, migration) => Math.max(max, migration.timestamp),
      0,
    );
    return {
      installState: classifyDatabaseTables(names),
      hasApplicationTables: classifyDatabaseTables(names) === 'existing',
      migrationTablePresent,
      appliedMigrations,
      schemaVersion,
    };
  } finally {
    await queryRunner.release();
  }
}

/**
 * Legacy Phase 1 helper retained for its focused compatibility tests.
 * Production startup now uses database-upgrade.ts, the Git-backed schema
 * fingerprints, pre-migration backup, and synchronize:false.
 */
export async function runMigrationFoundation(
  dataSource: DataSource,
  options: { execute?: boolean } = {},
): Promise<MigrationFoundationResult> {
  const before = await inspectMigrationState(dataSource);
  const executed: string[] = [];
  if (options.execute !== false) {
    try {
      const migrations = await dataSource.runMigrations({ transaction: 'all' });
      executed.push(...migrations.map((migration) => migration.name));
    } catch (err) {
      throw new MigrationFoundationError(
        '数据库 migration 执行失败；保持原 migration 记录以便下次重试',
        { cause: err },
      );
    }
  }
  const after = await inspectMigrationState(dataSource);
  return {
    before,
    after,
    executed,
    backupExpectation: {
      configDir: CONFIG_DIR,
      databasePath: DATABASE_PATH,
      requiredBeforeSchemaChange: true,
    },
  };
}
