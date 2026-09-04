import type { DatabaseSync } from "node:sqlite";
// `constants.ts` imports nothing, so this cannot cycle back through the migration ledger.
import { SEED_CHANNELS } from "./constants.ts";

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
      // All of it runs inside the migration's own transaction, with enforcement already
      // switched off by migrate() — it cannot be switched here, a PRAGMA inside a
      // transaction does nothing — and migrate() runs foreign_key_check afterwards.
      if (hasColumn(db, "carriers", "organization_id") === false) {
        throw new Error("Migration 6 requires migration 5 to have added organization_id.");
      }

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
  {
    version: 12,
    name: "error log",
    up: (db) => {
      // A server error caught by Next's onRequestError, so a customer's 500 is visible
      // from here instead of invisible. Genuinely global, not tenant-owned: the request
      // that failed might not have resolved a session yet (a bad /login attempt, a broken
      // proxy), so there is often no organisation to attach it to.
      db.exec(`
        CREATE TABLE IF NOT EXISTS error_log (
          id          INTEGER PRIMARY KEY,
          message     TEXT NOT NULL,
          digest      TEXT,
          path        TEXT,
          method      TEXT,
          route_type  TEXT,
          created_at  TEXT NOT NULL
        )`);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_error_log_time ON error_log (created_at DESC)",
      );
    },
  },
  {
    version: 13,
    name: "backup outcomes",
    up: (db) => {
      // Backups were reported to stdout and nowhere else, so a schedule that had stopped
      // months ago looked exactly like one that was working. On one machine with one
      // volume the backup *is* the disaster plan, which makes "did last night's run
      // succeed" a question the product has to be able to answer.
      //
      // Global, like error_log: a backup is of the whole file, not of one tenant.
      db.exec(`
        CREATE TABLE IF NOT EXISTS backup_log (
          id         INTEGER PRIMARY KEY,
          -- offsite | local | degraded | failed. Four rather than ok/not-ok because the
          -- interesting failure is the quiet one: a good snapshot whose upload is being
          -- refused, which "ok" would happily call a success.
          status     TEXT NOT NULL,
          detail     TEXT NOT NULL,
          bytes      INTEGER,
          created_at TEXT NOT NULL
        )`);
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_backup_log_time ON backup_log (created_at DESC)",
      );
    },
  },
  {
    version: 14,
    name: "carrier insurance expiry",
    up: (db) => {
      // A lapsed certificate of insurance is the one carrier fact with liability attached
      // to it, and the spreadsheet this product replaced did not track it either. Two
      // columns rather than a table: one policy date per carrier is what the work queue
      // needs, and a policy history nobody has asked for is a table to keep in step.
      addColumn(db, "carriers", "insurance_expires_on", "TEXT");
      // Kept because the alert has to be actionable — knowing a certificate lapsed is not
      // much use without knowing who to call about it.
      addColumn(db, "carriers", "insurance_provider", "TEXT");
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_carriers_org_insurance
           ON carriers (organization_id, insurance_expires_on)`,
      );
    },
  },
  {
    version: 15,
    name: "dispatch: drivers, brokers, loads and stops",
    up: (db) => {
      // The dispatch domain, on the tenancy the carrier tables already use: organization_id
      // on every table, and composite foreign keys throughout, so the database itself
      // refuses a load pointing at another tenant's carrier, driver or broker.
      //
      // A driver is NOT a user. The driver login was removed outright -- drivers send
      // documents by SMS and a dispatcher uploads them -- so a driver is a record about a
      // person, not an account that signs in. Modelling them as users would force a
      // credential row into existence for somebody who will never have one, and put them
      // in the middle of every permission decision.
      db.exec(`
        CREATE TABLE IF NOT EXISTS drivers (
          id              INTEGER PRIMARY KEY,
          organization_id INTEGER NOT NULL,
          -- The carrier they drive for. Nullable: a driver can be recorded before the
          -- carrier relationship is settled.
          carrier_id      INTEGER,
          name            TEXT NOT NULL,
          phone           TEXT,
          phone_digits    TEXT,
          email           TEXT,
          truck_number    TEXT,
          cdl_number      TEXT,
          cdl_expires_on  TEXT,
          active          INTEGER NOT NULL DEFAULT 1,
          notes           TEXT,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          FOREIGN KEY (organization_id) REFERENCES organizations (id),
          FOREIGN KEY (organization_id, carrier_id) REFERENCES carriers (organization_id, id)
        )`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_drivers_org ON drivers (organization_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_drivers_org_carrier ON drivers (organization_id, carrier_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_drivers_org_phone ON drivers (organization_id, phone_digits)");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_drivers_org_id ON drivers (organization_id, id)");

      db.exec(`
        CREATE TABLE IF NOT EXISTS brokers (
          id              INTEGER PRIMARY KEY,
          organization_id INTEGER NOT NULL,
          name            TEXT NOT NULL,
          mc_number       TEXT,
          contact_name    TEXT,
          phone           TEXT,
          email           TEXT,
          -- Seeded from the shipped list, or typed by a dispatcher. Kept apart so an
          -- administrator reviewing spellings can see which ones a person invented.
          seeded          INTEGER NOT NULL DEFAULT 0,
          active          INTEGER NOT NULL DEFAULT 1,
          created_at      TEXT NOT NULL,
          created_by      INTEGER,
          FOREIGN KEY (organization_id) REFERENCES organizations (id),
          UNIQUE (organization_id, name)
        )`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_brokers_org ON brokers (organization_id)");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_brokers_org_id ON brokers (organization_id, id)");

      db.exec(`
        CREATE TABLE IF NOT EXISTS loads (
          id                   INTEGER PRIMARY KEY,
          organization_id      INTEGER NOT NULL,
          -- Typed, never generated. Load number formats differ per broker, so this starts
          -- empty rather than being pre-filled with a format nobody uses.
          load_number          TEXT,
          carrier_id           INTEGER NOT NULL,
          driver_id            INTEGER,
          broker_id            INTEGER,
          dispatcher_id        INTEGER,
          status               TEXT NOT NULL,
          -- Beside the main status, not instead of it. See LOAD_EXCEPTION.
          exception            TEXT,
          commodity            TEXT,
          weight_lbs           INTEGER,
          -- Reefer loads only; NULL means the question does not apply.
          temperature_f        REAL,
          deadhead_miles       REAL,
          loaded_miles         REAL,
          rate                 REAL,
          special_instructions TEXT,
          picked_up_at         TEXT,
          delivered_at         TEXT,
          status_changed_at    TEXT,
          created_at           TEXT NOT NULL,
          updated_at           TEXT NOT NULL,
          created_by           INTEGER,
          updated_by           INTEGER,
          FOREIGN KEY (organization_id) REFERENCES organizations (id),
          FOREIGN KEY (organization_id, carrier_id)    REFERENCES carriers (organization_id, id),
          FOREIGN KEY (organization_id, driver_id)     REFERENCES drivers  (organization_id, id),
          FOREIGN KEY (organization_id, broker_id)     REFERENCES brokers  (organization_id, id),
          FOREIGN KEY (organization_id, dispatcher_id) REFERENCES users    (organization_id, id)
        )`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_loads_org ON loads (organization_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_loads_org_status ON loads (organization_id, status)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_loads_org_carrier ON loads (organization_id, carrier_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_loads_org_driver ON loads (organization_id, driver_id)");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_loads_org_id ON loads (organization_id, id)");

      // Stops are rows, not columns. Up to five pickups and five drops per load cannot be
      // expressed as origin/destination without ten nullable column groups; a one-pick
      // one-drop load is simply two rows here.
      db.exec(`
        CREATE TABLE IF NOT EXISTS load_stops (
          id              INTEGER PRIMARY KEY,
          organization_id INTEGER NOT NULL,
          load_id         INTEGER NOT NULL,
          kind            TEXT NOT NULL,
          sequence        INTEGER NOT NULL,
          city            TEXT,
          state           TEXT,
          address         TEXT,
          scheduled_at    TEXT,
          arrived_at      TEXT,
          notes           TEXT,
          FOREIGN KEY (organization_id) REFERENCES organizations (id),
          FOREIGN KEY (organization_id, load_id) REFERENCES loads (organization_id, id) ON DELETE CASCADE,
          UNIQUE (load_id, kind, sequence)
        )`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_stops_load ON load_stops (load_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_stops_org ON load_stops (organization_id)");
    },
  },
  {
    version: 16,
    name: "load documents: RC, BOL, POD, Other",
    up: (db) => {
      // Load-scoped, not per-stop: a multi-stop load's PODs just live together, unlabeled
      // by which delivery produced them. Append-only — no update/delete column or path
      // anywhere, the same rule carrier_activity already follows, for the same reason: a
      // POD or RC is potential evidence in a payment dispute.
      //
      // `kind` is a fixed four-value taxonomy (see DOCUMENT_KIND in constants.ts), kept
      // out of `lookups` the same way LOAD_STATUS and LOAD_EXCEPTION are: it's not a
      // per-tenant vocabulary a customer would rename or retire.
      db.exec(`
        CREATE TABLE IF NOT EXISTS load_documents (
          id              INTEGER PRIMARY KEY,
          organization_id INTEGER NOT NULL,
          load_id         INTEGER NOT NULL,
          kind            TEXT NOT NULL,
          -- The name as uploaded. Display and download filename only — never used to
          -- build the storage key or any filesystem/URL path.
          filename        TEXT NOT NULL,
          storage_key     TEXT NOT NULL,
          content_type    TEXT NOT NULL,
          size_bytes      INTEGER NOT NULL,
          uploaded_by     INTEGER NOT NULL,
          created_at      TEXT NOT NULL,
          FOREIGN KEY (organization_id) REFERENCES organizations (id),
          FOREIGN KEY (organization_id, load_id)     REFERENCES loads (organization_id, id),
          FOREIGN KEY (organization_id, uploaded_by) REFERENCES users (organization_id, id)
        )`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_load_documents_org ON load_documents (organization_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_load_documents_load ON load_documents (organization_id, load_id)");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_load_documents_org_id ON load_documents (organization_id, id)");
    },
  },
  {
    version: 17,
    name: "invoicing: load adjustments, dispatch invoices, flat-per-load pricing",
    up: (db) => {
      // Existing organisations never re-run provision.ts's seed (seed() in db.ts only
      // seeds the bootstrap org, and only on a database with zero organisations), so a
      // LOOKUPS entry added today only reaches a tenant created after this ships unless
      // it is inserted here too. ON CONFLICT DO NOTHING: a tenant provisioned after the
      // LOOKUPS change but before this migration ran already has the row.
      const orgs = db.prepare("SELECT id FROM organizations").all() as { id: number }[];
      const insertLookup = db.prepare(
        `INSERT INTO lookups (organization_id, kind, value, label, tone, sort)
         VALUES (?, 'pricing_type', 'flat_per_load', 'Flat Fee Per Load', NULL,
           (SELECT COALESCE(MAX(sort), 0) + 1 FROM lookups
             WHERE organization_id = ? AND kind = 'pricing_type'))
         ON CONFLICT (organization_id, kind, value) DO NOTHING`,
      );
      for (const o of orgs) insertLookup.run(o.id, o.id);

      // Itemized deductions/extra pay tied to a load — what Final Load Amount is built
      // from (see loads.ts's finalLoadAmount). Append-only, like load_documents: a
      // detention charge or an approved TONU fee is evidence in a payment dispute, not a
      // value to quietly edit later. No cascade from loads on purpose, matching
      // load_documents (see BUGS.md 2026-09-02) — tenant-lifecycle.ts deletes it
      // explicitly, in order, rather than relying on a cascade a future migration can't
      // retrofit without a table rebuild.
      db.exec(`
        CREATE TABLE IF NOT EXISTS load_adjustments (
          id              INTEGER PRIMARY KEY,
          organization_id INTEGER NOT NULL,
          load_id         INTEGER NOT NULL,
          kind            TEXT NOT NULL,
          description     TEXT NOT NULL,
          amount          REAL NOT NULL,
          created_at      TEXT NOT NULL,
          created_by      INTEGER,
          FOREIGN KEY (organization_id) REFERENCES organizations (id),
          FOREIGN KEY (organization_id, load_id)    REFERENCES loads (organization_id, id),
          FOREIGN KEY (organization_id, created_by) REFERENCES users (organization_id, id)
        )`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_load_adjustments_org ON load_adjustments (organization_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_load_adjustments_load ON load_adjustments (organization_id, load_id)");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_load_adjustments_org_id ON load_adjustments (organization_id, id)");

      // Asterism -> Carrier dispatch invoices today. `invoice_type` leaves room for
      // Carrier -> Broker freight invoices later without a rebuild — the same
      // one-table-many-kinds shape `lookups` already uses in this schema. See the design
      // doc §1: only 'dispatch' is ever inserted by this phase's code.
      db.exec(`
        CREATE TABLE IF NOT EXISTS invoices (
          id              INTEGER PRIMARY KEY,
          organization_id INTEGER NOT NULL,
          invoice_type    TEXT NOT NULL DEFAULT 'dispatch',
          carrier_id      INTEGER NOT NULL,
          status          TEXT NOT NULL DEFAULT 'pending',
          issued_on       TEXT NOT NULL,
          paid_on         TEXT,
          total_amount    REAL NOT NULL,
          notes           TEXT,
          created_at      TEXT NOT NULL,
          created_by      INTEGER,
          updated_at      TEXT NOT NULL,
          updated_by      INTEGER,
          FOREIGN KEY (organization_id) REFERENCES organizations (id),
          FOREIGN KEY (organization_id, carrier_id) REFERENCES carriers (organization_id, id),
          FOREIGN KEY (organization_id, created_by) REFERENCES users    (organization_id, id),
          FOREIGN KEY (organization_id, updated_by) REFERENCES users    (organization_id, id)
        )`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_invoices_org ON invoices (organization_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_invoices_org_carrier ON invoices (organization_id, carrier_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_invoices_org_status ON invoices (organization_id, status)");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_org_id ON invoices (organization_id, id)");

      // One row per included load, amounts snapshotted at creation — an invoice is a
      // historical financial document, so it must not silently reflow if the load's rate
      // or adjustments change later. Cascades from invoices (a line has no existence
      // apart from its invoice, same shape as load_stops cascading from loads); no
      // cascade from loads, same reasoning as load_adjustments above.
      db.exec(`
        CREATE TABLE IF NOT EXISTS invoice_lines (
          id                 INTEGER PRIMARY KEY,
          organization_id    INTEGER NOT NULL,
          invoice_id         INTEGER NOT NULL,
          load_id            INTEGER NOT NULL,
          final_load_amount  REAL NOT NULL,
          fee_basis          TEXT NOT NULL,
          fee_rate           REAL NOT NULL,
          amount             REAL NOT NULL,
          created_at         TEXT NOT NULL,
          FOREIGN KEY (organization_id) REFERENCES organizations (id),
          FOREIGN KEY (organization_id, invoice_id) REFERENCES invoices (organization_id, id) ON DELETE CASCADE,
          FOREIGN KEY (organization_id, load_id)    REFERENCES loads    (organization_id, id),
          UNIQUE (organization_id, invoice_id, load_id)
        )`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_invoice_lines_org ON invoice_lines (organization_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines (organization_id, invoice_id)");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_lines_org_id ON invoice_lines (organization_id, id)");
    },
  },
  {
    version: 18,
    name: "leads: the sales pipeline ahead of a carrier record",
    up: (db) => {
      // A lead is a prospect a sales rep is working, before anything in `carriers` exists.
      // Deliberately a separate table rather than a carrier with a "prospect" status: a
      // lead has no dispatcher, no plan, no rate and no agreement, and every attention
      // rule, report and export in the product treats a carriers row as a real customer.
      // Widening `carriers` would have quietly changed the meaning of all of them.
      //
      // `owner_id` is the sales rep, and the only thing that scopes a sales user's view —
      // see permissions.ts's Scope. `converted_carrier_id` is the whole conversion record:
      // a converted lead is kept forever as the history of how that carrier arrived.
      db.exec(`
        CREATE TABLE IF NOT EXISTS leads (
          id                   INTEGER PRIMARY KEY,
          organization_id      INTEGER NOT NULL,
          company_name         TEXT NOT NULL,
          contact_name         TEXT,
          phone                TEXT,
          phone_digits         TEXT,
          email                TEXT,
          mc_number            TEXT,
          usdot                TEXT,
          truck_count          INTEGER,
          trailer_type_id      INTEGER,
          lead_source_id       INTEGER,
          status               TEXT NOT NULL DEFAULT 'new',
          notes                TEXT,
          owner_id             INTEGER,
          converted_carrier_id INTEGER,
          converted_at         TEXT,
          created_at           TEXT NOT NULL,
          created_by           INTEGER,
          updated_at           TEXT NOT NULL,
          updated_by           INTEGER,
          FOREIGN KEY (organization_id) REFERENCES organizations (id),
          FOREIGN KEY (organization_id, trailer_type_id)      REFERENCES lookups  (organization_id, id),
          FOREIGN KEY (organization_id, lead_source_id)       REFERENCES lookups  (organization_id, id),
          FOREIGN KEY (organization_id, owner_id)             REFERENCES users    (organization_id, id),
          FOREIGN KEY (organization_id, converted_carrier_id) REFERENCES carriers (organization_id, id),
          FOREIGN KEY (organization_id, created_by)           REFERENCES users    (organization_id, id),
          FOREIGN KEY (organization_id, updated_by)           REFERENCES users    (organization_id, id)
        )`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_leads_org ON leads (organization_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_leads_org_owner ON leads (organization_id, owner_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_leads_org_status ON leads (organization_id, status)");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_org_id ON leads (organization_id, id)");
    },
  },
  {
    version: 19,
    name: "tasks and announcements (alerts stay derived)",
    up: (db) => {
      // Assigned work with a due date. `carrier_id` is the only link, deliberately: a task
      // about a load or a lead can name it in the title, and three nullable foreign keys
      // for links nobody has asked for is scaffolding.
      // ponytail: no recurrence and no sub-tasks. Add either when somebody asks twice.
      db.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id              INTEGER PRIMARY KEY,
          organization_id INTEGER NOT NULL,
          title           TEXT NOT NULL,
          details         TEXT,
          assigned_to     INTEGER,
          carrier_id      INTEGER,
          due_on          TEXT,
          priority        TEXT NOT NULL DEFAULT 'normal',
          status          TEXT NOT NULL DEFAULT 'open',
          completed_at    TEXT,
          completed_by    INTEGER,
          created_at      TEXT NOT NULL,
          created_by      INTEGER,
          updated_at      TEXT NOT NULL,
          updated_by      INTEGER,
          FOREIGN KEY (organization_id) REFERENCES organizations (id),
          FOREIGN KEY (organization_id, assigned_to)  REFERENCES users    (organization_id, id),
          FOREIGN KEY (organization_id, carrier_id)   REFERENCES carriers (organization_id, id),
          FOREIGN KEY (organization_id, completed_by) REFERENCES users    (organization_id, id),
          FOREIGN KEY (organization_id, created_by)   REFERENCES users    (organization_id, id),
          FOREIGN KEY (organization_id, updated_by)   REFERENCES users    (organization_id, id)
        )`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_org ON tasks (organization_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_org_assignee ON tasks (organization_id, assigned_to, status)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_org_due ON tasks (organization_id, status, due_on)");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_org_id ON tasks (organization_id, id)");

      // The noticeboard. Everyone in the organisation reads every announcement — no
      // audience column, because targeting a message at one team is Communication's job
      // (sub-project D), not a broadcast's.
      db.exec(`
        CREATE TABLE IF NOT EXISTS announcements (
          id              INTEGER PRIMARY KEY,
          organization_id INTEGER NOT NULL,
          title           TEXT NOT NULL,
          body            TEXT NOT NULL,
          published_at    TEXT NOT NULL,
          created_at      TEXT NOT NULL,
          created_by      INTEGER,
          updated_at      TEXT NOT NULL,
          updated_by      INTEGER,
          FOREIGN KEY (organization_id) REFERENCES organizations (id),
          FOREIGN KEY (organization_id, created_by) REFERENCES users (organization_id, id),
          FOREIGN KEY (organization_id, updated_by) REFERENCES users (organization_id, id)
        )`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_announcements_org ON announcements (organization_id, published_at)");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_announcements_org_id ON announcements (organization_id, id)");

      // One timestamp per person instead of a read-receipt table: unread means "published
      // since you last opened the page". That answers the only question anything asks —
      // the sidebar badge and the alerts feed — in one column and no per-row writes.
      // ponytail: per-announcement receipts ("who has read this?") need the table. Add it
      // if somebody actually wants to chase individuals.
      addColumn(db, "users", "announcements_seen_at", "TEXT");
    },
  },
  {
    version: 20,
    name: "communication: team channels and messages",
    up: (db) => {
      // `audience` is 'all' or a role name. Administrators hold every action, so they read
      // every channel without the audience column having to enumerate them — the same way
      // nothing else in the schema lists who the admin is.
      db.exec(`
        CREATE TABLE IF NOT EXISTS channels (
          id              INTEGER PRIMARY KEY,
          organization_id INTEGER NOT NULL,
          name            TEXT NOT NULL,
          description     TEXT,
          audience        TEXT NOT NULL DEFAULT 'all',
          seeded          INTEGER NOT NULL DEFAULT 0,
          archived        INTEGER NOT NULL DEFAULT 0,
          created_at      TEXT NOT NULL,
          created_by      INTEGER,
          FOREIGN KEY (organization_id) REFERENCES organizations (id),
          FOREIGN KEY (organization_id, created_by) REFERENCES users (organization_id, id),
          UNIQUE (organization_id, name)
        )`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_channels_org ON channels (organization_id, archived)");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_org_id ON channels (organization_id, id)");

      // Append-only, like carrier_notes and load_documents and for the same reason: a
      // message somebody has already acted on must not be quietly rewritten afterwards.
      // A correction is a second message, which is also how people actually work.
      db.exec(`
        CREATE TABLE IF NOT EXISTS messages (
          id              INTEGER PRIMARY KEY,
          organization_id INTEGER NOT NULL,
          channel_id      INTEGER NOT NULL,
          body            TEXT NOT NULL,
          author_id       INTEGER,
          created_at      TEXT NOT NULL,
          FOREIGN KEY (organization_id) REFERENCES organizations (id),
          FOREIGN KEY (organization_id, channel_id) REFERENCES channels (organization_id, id),
          FOREIGN KEY (organization_id, author_id)  REFERENCES users    (organization_id, id)
        )`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_messages_org ON messages (organization_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages (organization_id, channel_id, created_at)");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_org_id ON messages (organization_id, id)");

      // Per channel, not one watermark per person: with several channels you have to know
      // *which* one has something new, and a single timestamp would mark them all read the
      // moment you opened any of them. This is the case the announcements shortcut
      // (users.announcements_seen_at, migration 19) does not stretch to.
      db.exec(`
        CREATE TABLE IF NOT EXISTS channel_reads (
          organization_id INTEGER NOT NULL,
          channel_id      INTEGER NOT NULL,
          user_id         INTEGER NOT NULL,
          last_read_at    TEXT NOT NULL,
          PRIMARY KEY (organization_id, channel_id, user_id),
          FOREIGN KEY (organization_id) REFERENCES organizations (id),
          FOREIGN KEY (organization_id, channel_id) REFERENCES channels (organization_id, id),
          FOREIGN KEY (organization_id, user_id)    REFERENCES users    (organization_id, id)
        )`);

      // Existing organisations never re-run provision.ts's seed, so a channel added to the
      // constant today only reaches a tenant created after this ships unless it is
      // inserted here too — the same reasoning as migration 17's lookup backfill.
      const orgs = db.prepare("SELECT id FROM organizations").all() as { id: number }[];
      const insertChannel = db.prepare(
        `INSERT INTO channels (organization_id, name, description, audience, seeded, archived, created_at)
         VALUES (?, ?, ?, ?, 1, 0, ?)
         ON CONFLICT (organization_id, name) DO NOTHING`,
      );
      const now = new Date().toISOString();
      for (const o of orgs) {
        for (const channel of SEED_CHANNELS) {
          insertChannel.run(o.id, channel.name, channel.description, channel.audience, now);
        }
      }
    },
  },
  {
    version: 21,
    name: "brokers: the Do Not Use list",
    up: (db) => {
      // DNU is **not** the same as `active = 0`, which already exists.
      //
      //   `active = 0`  — retired. Tidying: the broker is gone from the list and nobody
      //                   needs to think about them again.
      //   `dnu = 1`     — do not book with these people, and here is why.
      //
      // The difference is visibility. A retired broker should disappear; a DNU broker must
      // stay in front of whoever is about to pick them, carrying its reason — the whole
      // value of the list is that the next person learns *why not* rather than finding a
      // name mysteriously missing and adding it back under a slightly different spelling.
      addColumn(db, "brokers", "dnu", "INTEGER NOT NULL DEFAULT 0");
      addColumn(db, "brokers", "dnu_reason", "TEXT");
      addColumn(db, "brokers", "dnu_at", "TEXT");
      // A soft reference, like `audit_log.user_id` and for the same reason: a composite
      // foreign key to users would either block removing the administrator who made the
      // call, or null `organization_id` along with them. Who flagged it must outlive their
      // account — that is the point of recording it.
      addColumn(db, "brokers", "dnu_by", "INTEGER");
      db.exec("CREATE INDEX IF NOT EXISTS idx_brokers_org_dnu ON brokers (organization_id, dnu)");
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
  if (pending.length === 0) return { applied, version: from };

  // Foreign key enforcement is switched here, around the whole run, because
  // `PRAGMA foreign_keys` is a **no-op inside a transaction** and every migration below
  // runs in one. It has to be OFF: SQLite cannot alter a table's constraints in place, so
  // a migration that changes them rebuilds the table — and `DROP TABLE` with enforcement
  // on performs an implicit DELETE that fires the children's `ON DELETE CASCADE`. That
  // silently empties carrier_notes, carrier_activity and offboarding_records (migration 6),
  // and fails outright where a child's reference is NO ACTION (migration 5, carriers →
  // users). Nothing is taken on trust in exchange: `foreign_key_check` below proves each
  // migration left no dangling reference, and rolls it back if it did.
  const enforcing =
    (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys === 1;
  if (enforcing) db.exec("PRAGMA foreign_keys = OFF");

  try {
    for (const migration of pending) {
      db.exec("BEGIN");
      try {
        migration.up(db);
        // Enforcement is off, so each migration proves for itself that it left the
        // database referentially intact. This is a manual scan, independent of the pragma.
        const violations = db.prepare("PRAGMA foreign_key_check").all();
        if (violations.length > 0) {
          throw new Error(
            `left ${violations.length} foreign key violation(s): ${JSON.stringify(
              violations.slice(0, 5),
            )}`,
          );
        }
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
  } finally {
    if (enforcing) db.exec("PRAGMA foreign_keys = ON");
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
