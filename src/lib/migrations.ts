import type { DatabaseSync } from "node:sqlite";

/**
 * Versioned, ordered, run-once migrations.
 *
 * The previous approach — a list of columns to add if missing — was fine while the only
 * database was the author's. Once other companies are running this, a schema change has
 * to be repeatable, ordered, and recorded, so an upgrade can never half-apply or apply
 * twice. Each migration runs inside a transaction: it lands completely or not at all.
 *
 * Rules:
 *   - Never edit a migration that has shipped. Add a new one.
 *   - Never renumber. The version is the identity.
 *   - Migrations must be safe on a database that already contains real customer data.
 */
export type Migration = {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
};

/** Version 1 creates the schema from nothing. Written idempotently with
 *  `IF NOT EXISTS`, so a database that predates the migration ledger simply records it
 *  as applied and moves on. Because it is a real migration rather than something the
 *  caller must remember to run first, `migrate()` alone can build a database from an
 *  empty file — which is what a restore or a provisioning script needs. */
const BASELINE = `
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

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "baseline schema",
    up: (db) => {
      db.exec(BASELINE);
    },
  },
  {
    version: 2,
    name: "carriers.phone_digits",
    up: (db) => {
      addColumn(db, "carriers", "phone_digits", "TEXT");
    },
  },
  {
    version: 3,
    name: "password reset tokens",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS password_resets (
          token      TEXT PRIMARY KEY,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          used_at    TEXT,
          issued_by  INTEGER REFERENCES users(id)
        )`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets (user_id)");
    },
  },
  {
    version: 4,
    name: "login attempt throttling",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS login_attempts (
          id          INTEGER PRIMARY KEY,
          identifier  TEXT NOT NULL,
          succeeded   INTEGER NOT NULL,
          attempted_at TEXT NOT NULL
        )`);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_attempts_id_time ON login_attempts (identifier, attempted_at)",
      );
    },
  },
];

export function addColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  ddl: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

/** Version of a database, including one that has never been migrated. Asking is always
 *  safe: a database with no ledger yet is simply at version 0. */
export function currentVersion(db: DatabaseSync): number {
  const ledger = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!ledger) return 0;
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as
    | { v: number | null }
    | undefined;
  return row?.v ?? 0;
}

/** Applies every migration newer than the recorded version, in order. */
export function migrate(db: DatabaseSync): { applied: string[]; version: number } {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )`);

  const from = currentVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > from).sort(
    (a, b) => a.version - b.version,
  );
  const applied: string[] = [];

  for (const migration of pending) {
    db.exec("BEGIN");
    try {
      migration.up(db);
      db.prepare(
        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      ).run(migration.version, migration.name, new Date().toISOString());
      db.exec("COMMIT");
      applied.push(`${migration.version}. ${migration.name}`);
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed and was rolled back: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return { applied, version: currentVersion(db) };
}

export const LATEST_VERSION = Math.max(...MIGRATIONS.map((m) => m.version));

/** Indexes are (re)created after migrations so an index may reference a column a
 *  migration has only just added. Cheap and idempotent, so it runs on every boot. */
export const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_carriers_mc      ON carriers (mc_number);
CREATE INDEX IF NOT EXISTS idx_carriers_usdot   ON carriers (usdot);
CREATE INDEX IF NOT EXISTS idx_carriers_status  ON carriers (status_id);
CREATE INDEX IF NOT EXISTS idx_carriers_name    ON carriers (legal_name);
CREATE INDEX IF NOT EXISTS idx_carriers_phone   ON carriers (phone_digits);
CREATE INDEX IF NOT EXISTS idx_notes_carrier ON carrier_notes (carrier_id);
CREATE INDEX IF NOT EXISTS idx_activity_carrier ON carrier_activity (carrier_id);
CREATE INDEX IF NOT EXISTS idx_activity_created ON carrier_activity (created_at);
`;
