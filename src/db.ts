import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MIGRATIONS_DIR = join(ROOT, 'migrations');
export const DATA_DIR = process.env.PATCHDUB_DATA ?? join(ROOT, 'data');

export type DB = DatabaseSync;

export function openDb(path?: string): DB {
  const dbPath = path ?? process.env.PATCHDUB_DB ?? join(DATA_DIR, 'patchdub.db');
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map((r) => r.version),
  );
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
  for (const file of files) {
    const version = Number(file.split('_')[0]);
    if (applied.has(version)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    db.exec('BEGIN');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(
        version,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}

/** Run fn inside IMMEDIATE transaction; rolls back on throw. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

export function artifactDir(): string {
  const dir = join(DATA_DIR, 'artifacts');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function exportDir(): string {
  const dir = join(DATA_DIR, 'exports');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
