import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { LOOKUPS, DEFAULT_SETTINGS, ROLES } from "./constants.ts";
import { hashPassword } from "./password.ts";
import { migrate, INDEXES } from "./migrations.ts";

const DB_PATH =
  process.env.CARRIER_DB_PATH ?? path.join(process.cwd(), "data", "carrier-hub.db");

// ponytail: node:sqlite is stdlib in Node 22+, so persistence costs zero dependencies.
// Move to Postgres when this outgrows one office; the query layer is plain SQL either way.
function connect(): DatabaseSync {
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const database = new DatabaseSync(DB_PATH);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  // Build workers and concurrent requests can collide on the write lock; wait rather
  // than fail immediately.
  database.exec("PRAGMA busy_timeout = 5000");
  const { applied } = migrate(database);
  if (applied.length > 0 && process.env.NODE_ENV !== "test") {
    console.log(`[carrier-hub] applied ${applied.length} migration(s):`);
    for (const line of applied) console.log(`  ${line}`);
  }
  database.exec(INDEXES);
  seed(database);
  return database;
}

function seed(database: DatabaseSync) {
  const insertLookup = database.prepare(
    `INSERT INTO lookups (kind, value, label, tone, sort) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (kind, value) DO UPDATE SET label = excluded.label, tone = excluded.tone`,
  );
  LOOKUPS.forEach((l, i) => insertLookup.run(l.kind, l.value, l.label, l.tone ?? null, i));

  const insertSetting = database.prepare(
    "INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)",
  );
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(key, value);

  const { count } = database.prepare("SELECT COUNT(*) AS count FROM users").get() as {
    count: number;
  };
  if (count === 0) {
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO users (name, email, password_hash, role, active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        process.env.ADMIN_NAME ?? "System Administrator",
        (process.env.ADMIN_EMAIL ?? "admin@carrierhub.local").toLowerCase(),
        hashPassword(process.env.ADMIN_PASSWORD ?? "ChangeMe123!"),
        ROLES.ADMIN,
        now,
        now,
      );
  }
}

/**
 * Connected lazily on the first query, not at module evaluation. `next build` imports
 * every module to collect page config; opening and seeding the database from nine build
 * workers at once is how you get "database is locked" for no reason at all.
 * The handle is cached on globalThis so dev hot-reloads reuse one connection.
 */
const globalForDb = globalThis as unknown as { __carrierDb?: DatabaseSync };

function conn(): DatabaseSync {
  if (!globalForDb.__carrierDb) globalForDb.__carrierDb = connect();
  return globalForDb.__carrierDb;
}

type Row = Record<string, unknown>;

/** node:sqlite hands back null-prototype rows; React and spread both prefer plain objects. */
function plain<T>(row: unknown): T {
  return { ...(row as Row) } as T;
}

export function all<T = Row>(sql: string, params: unknown[] = []): T[] {
  return (conn().prepare(sql).all(...(params as never[])) as unknown[]).map((r) => plain<T>(r));
}

export function get<T = Row>(sql: string, params: unknown[] = []): T | undefined {
  const row = conn().prepare(sql).get(...(params as never[]));
  return row === undefined ? undefined : plain<T>(row);
}

export function run(sql: string, params: unknown[] = []) {
  return conn().prepare(sql).run(...(params as never[]));
}

export function exec(sql: string): void {
  conn().exec(sql);
}

/**
 * Runs `fn` in a single transaction and rolls back on any throw. Imports and multi-row
 * mutations use this so a partial write can never land.
 */
export function transaction<T>(fn: () => T): T {
  const database = conn();
  database.exec("BEGIN");
  try {
    const result = fn();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export function getSetting(key: string): string {
  return (
    get<{ value: string }>("SELECT value FROM app_settings WHERE key = ?", [key])?.value ??
    DEFAULT_SETTINGS[key] ??
    ""
  );
}

export function getSettings(): Record<string, string> {
  const rows = all<{ key: string; value: string }>("SELECT key, value FROM app_settings");
  return { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
}
