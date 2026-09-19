import crypto from 'node:crypto';
import type { DataSource, QueryRunner } from 'typeorm';

type SqlExecutor = Pick<DataSource, 'query'> | Pick<QueryRunner, 'query'>;

export interface SchemaColumnInventory {
  name: string;
  type: string;
  notNull: boolean;
  defaultValue: string | null;
  primaryKeyPosition: number;
}

export interface SchemaIndexInventory {
  name: string | null;
  unique: boolean;
  origin: string;
  partial: boolean;
  columns: Array<{
    name: string | null;
    descending: boolean;
    collation: string | null;
  }>;
}

export interface SchemaForeignKeyInventory {
  id: number;
  sequence: number;
  referencedTable: string;
  from: string;
  to: string | null;
  onUpdate: string;
  onDelete: string;
  match: string;
}

export interface SchemaTableInventory {
  name: string;
  columns: SchemaColumnInventory[];
  indexes: SchemaIndexInventory[];
  foreignKeys: SchemaForeignKeyInventory[];
}

export interface DatabaseSchemaInventory {
  formatVersion: 1;
  tables: SchemaTableInventory[];
}

const INTERNAL_TABLES = new Set(['migrations', 'sqlite_sequence', 'typeorm_metadata']);

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function normalizeType(value: unknown): string {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function hasBalancedOuterParentheses(value: string): boolean {
  if (!value.startsWith('(') || !value.endsWith(')')) return false;
  let depth = 0;
  let quote: string | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote) {
        if (value[index + 1] === quote) index += 1;
        else quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth === 0 && index < value.length - 1) return false;
  }
  return depth === 0 && quote === null;
}

export function normalizeDefaultValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let normalized = String(value).trim().replace(/\s+/g, ' ');
  while (hasBalancedOuterParentheses(normalized)) {
    normalized = normalized.slice(1, -1).trim();
  }
  if (/^(?:current_timestamp|datetime\('now'\))$/i.test(normalized)) {
    return normalized.toLowerCase();
  }
  return normalized;
}

function numberValue(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function booleanValue(value: unknown): boolean {
  return numberValue(value) !== 0;
}

async function readIndexes(
  executor: SqlExecutor,
  tableName: string,
): Promise<SchemaIndexInventory[]> {
  const rows = await executor.query(`PRAGMA index_list(${quoteIdentifier(tableName)})`);
  const indexes: SchemaIndexInventory[] = [];
  for (const raw of Array.isArray(rows) ? rows : []) {
    const row = raw as Record<string, unknown>;
    const indexName = String(row.name || '');
    if (!indexName) continue;
    const detailRows = await executor.query(`PRAGMA index_xinfo(${quoteIdentifier(indexName)})`);
    const columns = (Array.isArray(detailRows) ? detailRows : [])
      .map((detail) => detail as Record<string, unknown>)
      .filter((detail) => numberValue(detail.key) === 1)
      .sort((left, right) => numberValue(left.seqno) - numberValue(right.seqno))
      .map((detail) => ({
        name: detail.name === null || detail.name === undefined ? null : String(detail.name),
        descending: booleanValue(detail.desc),
        collation: detail.coll === null || detail.coll === undefined ? null : String(detail.coll),
      }));
    const origin = String(row.origin || 'c');
    indexes.push({
      // SQLite-generated names are implementation details. The unique column
      // set is the stable identity for table constraints.
      name: origin === 'c' ? indexName : null,
      unique: booleanValue(row.unique),
      origin,
      partial: booleanValue(row.partial),
      columns,
    });
  }
  return indexes.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

async function readForeignKeys(
  executor: SqlExecutor,
  tableName: string,
): Promise<SchemaForeignKeyInventory[]> {
  const rows = await executor.query(`PRAGMA foreign_key_list(${quoteIdentifier(tableName)})`);
  return (Array.isArray(rows) ? rows : [])
    .map((raw) => raw as Record<string, unknown>)
    .map((row) => ({
      id: numberValue(row.id),
      sequence: numberValue(row.seq),
      referencedTable: String(row.table || ''),
      from: String(row.from || ''),
      to: row.to === null || row.to === undefined ? null : String(row.to),
      onUpdate: String(row.on_update || '').toUpperCase(),
      onDelete: String(row.on_delete || '').toUpperCase(),
      match: String(row.match || '').toUpperCase(),
    }))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export async function inventoryDatabaseSchema(
  executor: SqlExecutor,
): Promise<DatabaseSchemaInventory> {
  const tableRows = await executor.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  const tableNames = (Array.isArray(tableRows) ? tableRows : [])
    .map((row) => String((row as Record<string, unknown>).name || ''))
    .filter((name) => name.length > 0 && !INTERNAL_TABLES.has(name.toLowerCase()));
  const tables: SchemaTableInventory[] = [];
  for (const tableName of tableNames) {
    const columnRows = await executor.query(`PRAGMA table_info(${quoteIdentifier(tableName)})`);
    const columns = (Array.isArray(columnRows) ? columnRows : [])
      .map((raw) => raw as Record<string, unknown>)
      .map((row) => ({
        name: String(row.name || ''),
        type: normalizeType(row.type),
        notNull: booleanValue(row.notnull),
        defaultValue: normalizeDefaultValue(row.dflt_value),
        primaryKeyPosition: numberValue(row.pk),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
    tables.push({
      name: tableName,
      columns,
      indexes: await readIndexes(executor, tableName),
      foreignKeys: await readForeignKeys(executor, tableName),
    });
  }
  return { formatVersion: 1, tables: tables.sort((left, right) => left.name.localeCompare(right.name)) };
}

export function fingerprintSchema(inventory: DatabaseSchemaInventory): string {
  return crypto.createHash('sha256').update(JSON.stringify(inventory)).digest('hex');
}

export async function inspectSchemaFingerprint(
  executor: SqlExecutor,
): Promise<{ inventory: DatabaseSchemaInventory; fingerprint: string }> {
  const inventory = await inventoryDatabaseSchema(executor);
  return { inventory, fingerprint: fingerprintSchema(inventory) };
}

export function schemaTableNames(inventory: DatabaseSchemaInventory): string[] {
  return inventory.tables.map((table) => table.name);
}
