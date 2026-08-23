import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import config from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(here, 'schema.sql');

if (config.databaseFile !== ':memory:') {
  fs.mkdirSync(path.dirname(config.databaseFile), { recursive: true });
}

export const db = new Database(config.databaseFile);

// WAL gives us concurrent readers alongside a writer; busy_timeout makes
// competing writers wait for the lock instead of failing immediately.
if (config.databaseFile !== ':memory:') db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

/** Create every table/index if missing. Safe to call repeatedly. */
export function migrate() {
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
}

// Apply the schema as soon as the connection is opened. Service modules
// prepare their statements at import time, so the tables have to exist before
// any of them are evaluated.
migrate();

/** Drop everything and rebuild from scratch. */
export function resetSchema() {
  db.pragma('foreign_keys = OFF');
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all();
  for (const { name } of tables) db.exec(`DROP TABLE IF EXISTS "${name}"`);
  db.pragma('foreign_keys = ON');
  migrate();
}

/**
 * Run `fn` inside an IMMEDIATE transaction. IMMEDIATE takes the write lock
 * up-front, so two concurrent writers are serialised by SQLite rather than
 * discovering the conflict at COMMIT time.
 */
export function tx(fn) {
  return db.transaction(fn).immediate();
}

/** Wrap a function so it always runs in an IMMEDIATE transaction. */
export function transactional(fn) {
  return db.transaction(fn).immediate;
}

/** Current time as an ISO-8601 UTC string, matching what we store. */
export const nowIso = () => new Date().toISOString();

/** ISO timestamp `seconds` in the future. */
export const isoIn = (seconds) => new Date(Date.now() + seconds * 1000).toISOString();

export default db;
