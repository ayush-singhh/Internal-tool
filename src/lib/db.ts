import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { LOOKUPS, DEFAULT_SETTINGS, ROLES } from "./constants.ts";
import { hashPassword } from "./password.ts";

const DB_PATH =
  process.env.CARRIER_DB_PATH ?? path.join(process.cwd(), "data", "carrier-hub.db");

// ponytail: node:sqlite is stdlib in Node 22+, so persistence costs zero dependencies.
// Move to Postgres when this outgrows one office; the query layer is plain SQL either way.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL,
  phone         TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lookups (
  id     INTEGER PRIMARY KEY,
  kind   TEXT NOT NULL,
  value  TEXT NOT NULL,
  label  TEXT NOT NULL,
  tone   TEXT,
  sort   INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (kind, value)
);

CREATE TABLE IF NOT EXISTS carriers (
  id                   INTEGER PRIMARY KEY,
  serial               TEXT,
  legal_name           TEXT NOT NULL,
  owner_name           TEXT,
  phone                TEXT,
  phone_digits         TEXT,
  email                TEXT,
  address              TEXT,
  status_id            INTEGER REFERENCES lookups(id),
  dispatcher_id        INTEGER REFERENCES users(id),
  account_manager_id   INTEGER REFERENCES users(id),
  mc_number            TEXT,
  usdot                TEXT,
  trailer_type_id      INTEGER REFERENCES lookups(id),
  trailer_size         TEXT,
  truck_count          INTEGER,
  born_date            TEXT,
  onboarding_date      TEXT,
  first_load_date      TEXT,
  onboarding_type_id   INTEGER REFERENCES lookups(id),
  lead_source_id       INTEGER REFERENCES lookups(id),
  plan_id              INTEGER REFERENCES lookups(id),
  pricing_type_id      INTEGER REFERENCES lookups(id),
  rate                 REAL,
  percentage           REAL,
  billing_frequency_id INTEGER REFERENCES lookups(id),
  subscription_id      INTEGER REFERENCES lookups(id),
  agreement_status_id  INTEGER REFERENCES lookups(id),
  invoice_mode_id      INTEGER REFERENCES lookups(id),
  status_changed_at    TEXT,
  review_flags         TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  created_by           INTEGER REFERENCES users(id),
  updated_by           INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS carrier_notes (
  id         INTEGER PRIMARY KEY,
  carrier_id INTEGER NOT NULL REFERENCES carriers(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id),
  body       TEXT NOT NULL,
  pinned     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS carrier_activity (
  id         INTEGER PRIMARY KEY,
  carrier_id INTEGER NOT NULL REFERENCES carriers(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id),
  type       TEXT NOT NULL,
  field      TEXT,
  old_value  TEXT,
  new_value  TEXT,
  summary    TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS offboarding_records (
  id                    INTEGER PRIMARY KEY,
  carrier_id            INTEGER NOT NULL UNIQUE REFERENCES carriers(id) ON DELETE CASCADE,
  offboarded_on         TEXT,
  reason_id             INTEGER REFERENCES lookups(id),
  category_id           INTEGER REFERENCES lookups(id),
  final_status_id       INTEGER REFERENCES lookups(id),
  handled_by            INTEGER REFERENCES users(id),
  last_load_date        TEXT,
  outstanding_balance   REAL,
  subscription_cancelled INTEGER NOT NULL DEFAULT 0,
  agreement_closed      INTEGER NOT NULL DEFAULT 0,
  can_return            INTEGER NOT NULL DEFAULT 1,
  notes                 TEXT,
  created_at            TEXT NOT NULL,
  created_by            INTEGER REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS saved_filters (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  query      TEXT NOT NULL,
  shared     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
`;

// Indexes are created after migrate() so an index may reference a column that
// migrate() has just added. Duplicate MC/USDOT are warnings the user resolves rather
// than hard constraints, so those indexes exist for lookup speed only.
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_carriers_mc      ON carriers (mc_number);
CREATE INDEX IF NOT EXISTS idx_carriers_usdot   ON carriers (usdot);
CREATE INDEX IF NOT EXISTS idx_carriers_status  ON carriers (status_id);
CREATE INDEX IF NOT EXISTS idx_carriers_name    ON carriers (legal_name);
CREATE INDEX IF NOT EXISTS idx_carriers_phone   ON carriers (phone_digits);
CREATE INDEX IF NOT EXISTS idx_notes_carrier ON carrier_notes (carrier_id);
CREATE INDEX IF NOT EXISTS idx_activity_carrier ON carrier_activity (carrier_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON carrier_activity (created_at);
`;

function connect(): DatabaseSync {
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const database = new DatabaseSync(DB_PATH);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  // Build workers and concurrent requests can collide on the write lock; wait rather
  // than fail immediately.
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec(SCHEMA);
  migrate(database);
  database.exec(INDEXES);
  seed(database);
  return database;
}

/**
 * `CREATE TABLE IF NOT EXISTS` never adds a column to a table that already exists, so
 * columns introduced after a database was created are added here. Additive only —
 * nothing in this function drops or rewrites data.
 * ponytail: an add-column list, not a migration framework. Introduce versioned
 * migrations the first time a change needs to rewrite existing rows.
 */
function migrate(database: DatabaseSync) {
  const ADDITIONS: [table: string, column: string, ddl: string][] = [
    ["carriers", "phone_digits", "TEXT"],
  ];
  for (const [table, column, ddl] of ADDITIONS) {
    const cols = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }
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
