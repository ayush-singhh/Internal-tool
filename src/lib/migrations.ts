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
  {
    version: 5,
    name: "multi-tenant: organizations and tenant columns",
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS organizations (
          id         INTEGER PRIMARY KEY,
          name       TEXT NOT NULL,
          slug       TEXT NOT NULL UNIQUE,
          status     TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL
        )`);

      // Production holds one organisation's data, so it maps unambiguously to one tenant.
      // A database that cannot be attributed to a single organisation is refused rather
      // than guessed — see assertSingleTenantData.
      assertSingleTenantData(db);

      const tenantTables = [
        "users", "carriers", "carrier_notes", "carrier_activity",
        "offboarding_records", "saved_filters", "lookups", "app_settings",
      ];
      for (const table of tenantTables) {
        addColumn(db, table, "organization_id", "INTEGER REFERENCES organizations(id)");
      }

      // Backfill only runs when the database already holds data from the single-tenant
      // era. A genuinely fresh database has nothing to assign — its bootstrap organisation
      // (with seeded vocabularies and an owner) is created by seed() in db.ts instead, so
      // the two paths never both create an org.
      const hasExistingData =
        (db.prepare("SELECT COUNT(*) AS n FROM users").get() as { n: number }).n > 0 ||
        (db.prepare("SELECT COUNT(*) AS n FROM lookups").get() as { n: number }).n > 0;

      if (hasExistingData) {
        const existingName =
          (db.prepare("SELECT value FROM app_settings WHERE key = 'company_name'").get() as
            | { value: string }
            | undefined)?.value ?? "My Organization";
        const orgName = process.env.MIGRATION_ORG_NAME ?? existingName;
        const now = new Date().toISOString();

        let orgId =
          (db.prepare("SELECT id FROM organizations LIMIT 1").get() as { id: number } | undefined)?.id;
        if (orgId === undefined) {
          db.prepare(
            "INSERT INTO organizations (name, slug, status, created_at) VALUES (?, ?, 'active', ?)",
          ).run(orgName, uniqueSlug(db, orgName), now);
          orgId = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
        }
        for (const table of tenantTables) {
          db.prepare(`UPDATE ${table} SET organization_id = ? WHERE organization_id IS NULL`).run(orgId);
        }
      }

      for (const [name, table, cols] of [
        ["idx_users_org", "users", "organization_id"],
        ["idx_carriers_org", "carriers", "organization_id"],
        ["idx_notes_org", "carrier_notes", "organization_id"],
        ["idx_activity_org", "carrier_activity", "organization_id"],
        ["idx_offboard_org", "offboarding_records", "organization_id"],
        ["idx_filters_org", "saved_filters", "organization_id"],
        ["idx_lookups_org", "lookups", "organization_id"],
      ] as const) {
        db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} (${cols})`);
      }

      // Email is unique per organisation now, not globally: two companies may each employ
      // a jane@example.com. SQLite cannot drop a column-level UNIQUE in place, so the
      // table is rebuilt. Same reasoning for the other two constraint changes.
      rebuildUsersPerTenant(db);
      rebuildAppSettingsPerTenant(db);
      rebuildLookupsPerTenant(db);

      // Sessions predate tenancy and cannot be trusted to carry it — force re-login.
      db.exec("DELETE FROM sessions");
    },
  },
  {
    version: 6,
    name: "multi-tenant: composite foreign keys (Layer 1 isolation)",
    up: (db) => {
      // The strongest isolation layer: the database itself refuses a carrier that points
      // at another tenant's lookup or user. A composite FK (organization_id, x_id) can
      // only resolve to a row sharing the same organization_id, so even application code
      // that forgot to scope cannot create a cross-tenant reference.
      //
      // SQLite adds foreign keys only at table-creation time, so each table is rebuilt.
      // All of it runs inside the migration's own transaction (see migrate()), and
      // foreign_key_check is asserted at the end.
      if (hasColumn(db, "carriers", "organization_id") === false) {
        throw new Error("Migration 6 requires migration 5 to have added organization_id.");
      }

      db.exec("PRAGMA foreign_keys = OFF");

      rebuildCarriersWithCompositeFks(db);
      rebuildChildWithCompositeFk(db, "carrier_notes");
      rebuildChildWithCompositeFk(db, "carrier_activity");
      rebuildOffboardingWithCompositeFks(db);

      // Composite uniqueness: MC/USDOT indexes stay non-unique (duplicates are a warning,
      // not a constraint), but they gain organization_id so lookups never scan other
      // tenants' rows.
      db.exec("CREATE INDEX IF NOT EXISTS idx_carriers_org_mc ON carriers (organization_id, mc_number)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_carriers_org_usdot ON carriers (organization_id, usdot)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_carriers_org_status ON carriers (organization_id, status_id)");

      const violations = db.prepare("PRAGMA foreign_key_check").all();
      db.exec("PRAGMA foreign_keys = ON");
      if (violations.length > 0) {
        throw new Error(`Composite FK rebuild left ${violations.length} violation(s): ${JSON.stringify(violations)}`);
      }
    },
  },
  {
    version: 7,
    name: "TOTP multi-factor authentication",
    up: (db) => {
      // The secret and its activation live on the user row: one row per user either way,
      // and every read of it already happens while holding a user id.
      addColumn(db, "users", "mfa_secret", "TEXT");
      addColumn(db, "users", "mfa_activated_at", "TEXT");
      // The last accepted time step. A code is valid for 30 seconds, which is long enough
      // to be replayed by someone watching the wire, so a step is accepted only once.
      addColumn(db, "users", "mfa_last_step", "INTEGER");

      // A session that has passed the password but not the second factor. It exists so the
      // second step has somewhere to hold state, and getCurrentUser() refuses it, so it
      // grants nothing at all until the code is confirmed.
      addColumn(db, "sessions", "mfa_pending", "INTEGER NOT NULL DEFAULT 0");

      // Single-use codes for a lost phone. Stored as SHA-256 like a reset token: the code
      // itself carries 80 bits of entropy, so the digest is not worth attacking offline,
      // and a lookup by digest stays a single indexed read.
      db.exec(`
        CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
          code_hash  TEXT PRIMARY KEY,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          used_at    TEXT
        )`);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_recovery_user ON mfa_recovery_codes (user_id)",
      );
    },
  },
  {
    version: 8,
    name: "email verification for self-signup",
    up: (db) => {
      // NULL means "not confirmed yet", which only self-signup produces. Every account
      // that already exists was created by an administrator who vouched for the address,
      // so they are backfilled as confirmed — nobody is locked out by this migration.
      addColumn(db, "users", "email_verified_at", "TEXT");
      db.exec("UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL");

      db.exec(`
        CREATE TABLE IF NOT EXISTS email_verifications (
          token      TEXT PRIMARY KEY,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          used_at    TEXT
        )`);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_verifications_user ON email_verifications (user_id)",
      );
    },
  },
  {
    version: 9,
    name: "platform support access log",
    up: (db) => {
      // Every cross-tenant read by a platform support account, recorded server-side.
      // Deliberately NOT tenant-owned and deliberately not surfaced in the customer UI:
      // it is the internal record that makes standing access accountable, not a feature
      // customers read. Nothing in the app deletes from it.
      db.exec(`
        CREATE TABLE IF NOT EXISTS support_access_log (
          id              INTEGER PRIMARY KEY,
          user_id         INTEGER NOT NULL REFERENCES users(id),
          organization_id INTEGER NOT NULL REFERENCES organizations(id),
          path            TEXT NOT NULL,
          created_at      TEXT NOT NULL
        )`);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_support_log_time ON support_access_log (created_at DESC)",
      );
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_support_log_org ON support_access_log (organization_id, created_at DESC)",
      );
    },
  },
  {
    version: 10,
    name: "sessions remember where they came from",
    up: (db) => {
      // So somebody can look at their own list and recognise — or fail to recognise — a
      // session, which is the only way "sign out the one I do not know" is possible.
      addColumn(db, "sessions", "user_agent", "TEXT");
      addColumn(db, "sessions", "ip", "TEXT");
      addColumn(db, "sessions", "last_seen_at", "TEXT");
      db.exec("UPDATE sessions SET last_seen_at = created_at WHERE last_seen_at IS NULL");
    },
  },
  {
    version: 11,
    name: "audit log",
    up: (db) => {
      // Who got in, who changed who could get in, and who took data out. `carrier_activity`
      // already answers "what happened to this carrier" — this answers the question a
      // customer's security review asks instead. Tenant-owned, so the guard scopes it.
      //
      // No composite foreign key to `users`, unlike every other tenant-owned table, and
      // deliberately: with one, removing a user is either blocked by the record of what
      // they did, or — with ON DELETE SET NULL, which nulls *every* column of a composite
      // key — takes `organization_id` with it, and that column is NOT NULL. An audit log
      // has to outlive the account it describes, so `user_id` is a soft reference and
      // `actor` carries the identity that has to survive.
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id              INTEGER PRIMARY KEY,
          -- Cascading, so removing an organisation still removes everything it owns. The
          -- log belongs to that customer; it should not outlive them as an orphan.
          organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          user_id         INTEGER,
          actor           TEXT,
          action          TEXT NOT NULL,
          subject         TEXT,
          detail          TEXT,
          ip              TEXT,
          created_at      TEXT NOT NULL
        )`);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_audit_org_time ON audit_log (organization_id, created_at DESC)",
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


/** Slug from a name, made unique against existing organisations. */
function uniqueSlug(db: DatabaseSync, name: string): string {
  const base = slugify(name);
  let slug = base;
  let n = 2;
  while (db.prepare("SELECT 1 FROM organizations WHERE slug = ?").get(slug)) {
    slug = `${base}-${n++}`;
  }
  return slug;
}

export function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return s || "org";
}

/**
 * Refuses to tenant-assign a database that plainly holds more than one organisation's
 * data. This single-tenant schema never produced such a database, so in practice this
 * always passes — but the requirement is explicit: never invent a tenant assignment, stop
 * and flag instead. A heuristic can only be conservative here; it errs toward stopping.
 */
function assertSingleTenantData(db: DatabaseSync): void {
  const orgCount =
    (db.prepare("SELECT COUNT(*) AS n FROM organizations").get() as { n: number }).n;
  if (orgCount > 1) {
    throw new Error(
      "Refusing to migrate: the database already contains multiple organizations, so a " +
        "single-tenant backfill would be ambiguous. Assign tenants explicitly before rerunning.",
    );
  }
}

/** Rebuilds `users` so email is unique per organisation rather than globally. */
function rebuildUsersPerTenant(db: DatabaseSync): void {
  if (hasIndex(db, "users", ["organization_id", "email"])) return;
  // The old table declared `email TEXT NOT NULL UNIQUE`; its auto-index vanishes with the
  // table itself, so it is never dropped by hand (SQLite refuses to drop an auto-index).
  db.exec(`
    CREATE TABLE users_new (
      id              INTEGER PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id),
      name            TEXT NOT NULL,
      email           TEXT NOT NULL,
      password_hash   TEXT NOT NULL,
      role            TEXT NOT NULL,
      phone           TEXT,
      active          INTEGER NOT NULL DEFAULT 1,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    )`);
  db.exec(`
    INSERT INTO users_new (id, organization_id, name, email, password_hash, role, phone, active, created_at, updated_at)
    SELECT id, organization_id, name, email, password_hash, role, phone, active, created_at, updated_at FROM users`);
  db.exec("DROP TABLE users");
  db.exec("ALTER TABLE users_new RENAME TO users");
  db.exec("CREATE UNIQUE INDEX idx_users_org_email ON users (organization_id, email)");
  db.exec("CREATE INDEX idx_users_org ON users (organization_id)");
}

/** Rebuilds `app_settings` so its key is (organization_id, key). */
function rebuildAppSettingsPerTenant(db: DatabaseSync): void {
  const pk = db.prepare("PRAGMA table_info(app_settings)").all() as { name: string; pk: number }[];
  const alreadyComposite = pk.filter((c) => c.pk > 0).length > 1;
  if (alreadyComposite) return;
  db.exec(`
    CREATE TABLE app_settings_new (
      organization_id INTEGER NOT NULL REFERENCES organizations(id),
      key             TEXT NOT NULL,
      value           TEXT NOT NULL,
      PRIMARY KEY (organization_id, key)
    )`);
  db.exec(`
    INSERT INTO app_settings_new (organization_id, key, value)
    SELECT organization_id, key, value FROM app_settings`);
  db.exec("DROP TABLE app_settings");
  db.exec("ALTER TABLE app_settings_new RENAME TO app_settings");
}

/** Rebuilds `lookups` so value is unique per (organization_id, kind). */
function rebuildLookupsPerTenant(db: DatabaseSync): void {
  if (hasIndex(db, "lookups", ["organization_id", "kind", "value"])) return;
  db.exec(`
    CREATE TABLE lookups_new (
      id              INTEGER PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id),
      kind            TEXT NOT NULL,
      value           TEXT NOT NULL,
      label           TEXT NOT NULL,
      tone            TEXT,
      sort            INTEGER NOT NULL DEFAULT 0,
      active          INTEGER NOT NULL DEFAULT 1,
      UNIQUE (organization_id, kind, value)
    )`);
  db.exec(`
    INSERT INTO lookups_new (id, organization_id, kind, value, label, tone, sort, active)
    SELECT id, organization_id, kind, value, label, tone, sort, active FROM lookups`);
  db.exec("DROP TABLE lookups");
  db.exec("ALTER TABLE lookups_new RENAME TO lookups");
  db.exec("CREATE INDEX idx_lookups_org ON lookups (organization_id)");
}

function hasIndex(db: DatabaseSync, table: string, columns: string[]): boolean {
  const indexes = db.prepare(`PRAGMA index_list(${table})`).all() as { name: string; unique: number }[];
  for (const idx of indexes) {
    const cols = (db.prepare(`PRAGMA index_info(${idx.name})`).all() as { name: string }[]).map((c) => c.name);
    if (cols.length === columns.length && columns.every((c, i) => cols[i] === c)) return true;
  }
  return false;
}


function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(
    (c) => c.name === column,
  );
}

/**
 * Rebuilds `carriers` with a composite foreign key on every lookup and user reference,
 * so a carrier can only ever point at rows within its own organisation. This is the
 * table that makes cross-tenant references impossible at the storage layer.
 */
function rebuildCarriersWithCompositeFks(db: DatabaseSync): void {
  const cols = (db.prepare("PRAGMA table_info(carriers)").all() as { name: string }[]).map((c) => c.name);
  const list = cols.join(", ");

  db.exec(`
    CREATE TABLE carriers_new (
      id                   INTEGER PRIMARY KEY,
      organization_id      INTEGER NOT NULL REFERENCES organizations(id),
      serial               TEXT,
      legal_name           TEXT NOT NULL,
      owner_name           TEXT,
      phone                TEXT,
      phone_digits         TEXT,
      email                TEXT,
      address              TEXT,
      status_id            INTEGER,
      dispatcher_id        INTEGER,
      account_manager_id   INTEGER,
      mc_number            TEXT,
      usdot                TEXT,
      trailer_type_id      INTEGER,
      trailer_size         TEXT,
      truck_count          INTEGER,
      born_date            TEXT,
      onboarding_date      TEXT,
      first_load_date      TEXT,
      onboarding_type_id   INTEGER,
      lead_source_id       INTEGER,
      plan_id              INTEGER,
      pricing_type_id      INTEGER,
      rate                 REAL,
      percentage           REAL,
      billing_frequency_id INTEGER,
      subscription_id      INTEGER,
      agreement_status_id  INTEGER,
      invoice_mode_id      INTEGER,
      status_changed_at    TEXT,
      review_flags         TEXT,
      created_at           TEXT NOT NULL,
      updated_at           TEXT NOT NULL,
      created_by           INTEGER,
      updated_by           INTEGER,
      -- Composite FKs: a referenced lookup/user must share this carrier's organization_id.
      FOREIGN KEY (organization_id, status_id)            REFERENCES lookups (organization_id, id),
      FOREIGN KEY (organization_id, trailer_type_id)      REFERENCES lookups (organization_id, id),
      FOREIGN KEY (organization_id, onboarding_type_id)   REFERENCES lookups (organization_id, id),
      FOREIGN KEY (organization_id, lead_source_id)       REFERENCES lookups (organization_id, id),
      FOREIGN KEY (organization_id, plan_id)              REFERENCES lookups (organization_id, id),
      FOREIGN KEY (organization_id, pricing_type_id)      REFERENCES lookups (organization_id, id),
      FOREIGN KEY (organization_id, billing_frequency_id) REFERENCES lookups (organization_id, id),
      FOREIGN KEY (organization_id, subscription_id)      REFERENCES lookups (organization_id, id),
      FOREIGN KEY (organization_id, agreement_status_id)  REFERENCES lookups (organization_id, id),
      FOREIGN KEY (organization_id, invoice_mode_id)      REFERENCES lookups (organization_id, id),
      FOREIGN KEY (organization_id, dispatcher_id)        REFERENCES users (organization_id, id),
      FOREIGN KEY (organization_id, account_manager_id)   REFERENCES users (organization_id, id)
    )`);

  // A composite FK requires a unique index on the parent's referenced columns.
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_lookups_org_id ON lookups (organization_id, id)");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_org_id ON users (organization_id, id)");

  db.exec(`INSERT INTO carriers_new (${list}) SELECT ${list} FROM carriers`);
  db.exec("DROP TABLE carriers");
  db.exec("ALTER TABLE carriers_new RENAME TO carriers");

  db.exec("CREATE INDEX idx_carriers_org ON carriers (organization_id)");
  db.exec("CREATE INDEX idx_carriers_name ON carriers (legal_name)");
  db.exec("CREATE INDEX idx_carriers_phone ON carriers (phone_digits)");
}

/** carrier_notes / carrier_activity: composite FK to their carrier within the tenant. */
function rebuildChildWithCompositeFk(db: DatabaseSync, table: string): void {
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  const list = cols.join(", ");

  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_carriers_org_id ON carriers (organization_id, id)");

  const extra =
    table === "carrier_notes"
      ? `body TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0,`
      : `type TEXT NOT NULL, field TEXT, old_value TEXT, new_value TEXT, summary TEXT NOT NULL,`;

  db.exec(`
    CREATE TABLE ${table}_new (
      id              INTEGER PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id),
      carrier_id      INTEGER NOT NULL,
      user_id         INTEGER,
      ${extra}
      created_at      TEXT NOT NULL,
      FOREIGN KEY (organization_id, carrier_id) REFERENCES carriers (organization_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, user_id)    REFERENCES users (organization_id, id)
    )`);
  db.exec(`INSERT INTO ${table}_new (${list}) SELECT ${list} FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
  db.exec(`CREATE INDEX idx_${table === "carrier_notes" ? "notes" : "activity"}_carrier ON ${table} (carrier_id)`);
  db.exec(`CREATE INDEX idx_${table === "carrier_notes" ? "notes" : "activity"}_org ON ${table} (organization_id)`);
}

/** offboarding_records: composite FK to its carrier and to the lookups it references. */
function rebuildOffboardingWithCompositeFks(db: DatabaseSync): void {
  const cols = (db.prepare("PRAGMA table_info(offboarding_records)").all() as { name: string }[]).map((c) => c.name);
  const list = cols.join(", ");

  db.exec(`
    CREATE TABLE offboarding_records_new (
      id                     INTEGER PRIMARY KEY,
      organization_id        INTEGER NOT NULL REFERENCES organizations(id),
      carrier_id             INTEGER NOT NULL UNIQUE,
      offboarded_on          TEXT,
      reason_id              INTEGER,
      category_id            INTEGER,
      final_status_id        INTEGER,
      handled_by             INTEGER,
      last_load_date         TEXT,
      outstanding_balance    REAL,
      subscription_cancelled INTEGER NOT NULL DEFAULT 0,
      agreement_closed       INTEGER NOT NULL DEFAULT 0,
      can_return             INTEGER NOT NULL DEFAULT 1,
      notes                  TEXT,
      created_at             TEXT NOT NULL,
      created_by             INTEGER,
      FOREIGN KEY (organization_id, carrier_id)      REFERENCES carriers (organization_id, id) ON DELETE CASCADE,
      FOREIGN KEY (organization_id, reason_id)       REFERENCES lookups (organization_id, id),
      FOREIGN KEY (organization_id, category_id)     REFERENCES lookups (organization_id, id),
      FOREIGN KEY (organization_id, final_status_id) REFERENCES lookups (organization_id, id),
      FOREIGN KEY (organization_id, handled_by)      REFERENCES users (organization_id, id)
    )`);
  db.exec(`INSERT INTO offboarding_records_new (${list}) SELECT ${list} FROM offboarding_records`);
  db.exec("DROP TABLE offboarding_records");
  db.exec("ALTER TABLE offboarding_records_new RENAME TO offboarding_records");
}
