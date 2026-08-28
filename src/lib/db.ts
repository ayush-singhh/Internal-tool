import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { LOOKUPS, DEFAULT_SETTINGS, ROLES } from "./constants.ts";
import { hashPassword } from "./password.ts";
import { migrate, INDEXES } from "./migrations.ts";
import { tenantTablesLackingScope } from "./tenant-db.ts";

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
  // Multi-tenant seeding lives in provision.ts (per organisation). At the database level
  // the only first-run concern is: if there are no organisations at all, create the
  // bootstrap organisation and its owner from the ADMIN_* environment, so a fresh install
  // has somewhere to sign in. Existing databases already have their org from migration 5.
  const orgCount = (database.prepare("SELECT COUNT(*) AS n FROM organizations").get() as { n: number }).n;
  if (orgCount > 0) return;

  const now = new Date().toISOString();
  const orgName = process.env.ADMIN_ORG ?? process.env.MIGRATION_ORG_NAME ?? "My Organization";
  const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "org";

  database.prepare(
    "INSERT INTO organizations (name, slug, status, created_at) VALUES (?, ?, 'active', ?)",
  ).run(orgName, slug, now);
  const orgId = (database.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;

  const insertLookup = database.prepare(
    `INSERT INTO lookups (organization_id, kind, value, label, tone, sort)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (organization_id, kind, value) DO UPDATE SET label = excluded.label`,
  );
  LOOKUPS.forEach((l, i) => insertLookup.run(orgId, l.kind, l.value, l.label, l.tone ?? null, i));

  const insertSetting = database.prepare(
    "INSERT OR IGNORE INTO app_settings (organization_id, key, value) VALUES (?, ?, ?)",
  );
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) insertSetting.run(orgId, key, value);

  database.prepare(
    `INSERT INTO users (organization_id, name, email, password_hash, role, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    orgId,
    process.env.ADMIN_NAME ?? "System Administrator",
    (process.env.ADMIN_EMAIL ?? "admin@carrierhub.local").toLowerCase(),
    hashPassword(process.env.ADMIN_PASSWORD ?? "ChangeMe123!"),
    ROLES.OWNER,
    now,
    now,
  );
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


/**
 * Layer 2 isolation — the fail-closed guard.
 *
 * Every query naming a tenant-owned table must constrain organization_id. If one does
 * not, this throws rather than returning another tenant's rows. A developer who forgets
 * to scope gets a loud error in development, never a silent leak in production.
 *
 * The guard is bypassed only inside `systemQuery()`, whose call sites are few, all
 * concern genuinely global tables (sessions, organizations, login_attempts, migrations)
 * or the deliberate cross-tenant support path, and are asserted by test.
 */
let bypassGuard = false;

function guard(sql: string): void {
  if (bypassGuard) return;
  const unscoped = tenantTablesLackingScope(sql);
  if (unscoped.length > 0) {
    throw new Error(
      `Tenant isolation guard: query touches ${unscoped.join(", ")} without an ` +
        `organization_id predicate. Scope it, or route genuinely global access through ` +
        `systemQuery(). SQL: ${sql.replace(/\s+/g, " ").trim().slice(0, 120)}`,
    );
  }
}

/**
 * Runs `fn` with the tenant guard disabled. For system/global tables and the audited
 * cross-tenant support path ONLY. Never wrap ordinary tenant queries in this.
 */
export function systemQuery<T>(fn: () => T): T {
  const previous = bypassGuard;
  bypassGuard = true;
  try {
    return fn();
  } finally {
    bypassGuard = previous;
  }
}

export function all<T = Row>(sql: string, params: unknown[] = []): T[] {
  guard(sql);
  return (conn().prepare(sql).all(...(params as never[])) as unknown[]).map((r) => plain<T>(r));
}

export function get<T = Row>(sql: string, params: unknown[] = []): T | undefined {
  guard(sql);
  const row = conn().prepare(sql).get(...(params as never[]));
  return row === undefined ? undefined : plain<T>(row);
}

export function run(sql: string, params: unknown[] = []) {
  guard(sql);
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

export function getSetting(orgId: number, key: string): string {
  return (
    get<{ value: string }>(
      "SELECT value FROM app_settings WHERE organization_id = ? AND key = ?",
      [orgId, key],
    )?.value ??
    DEFAULT_SETTINGS[key] ??
    ""
  );
}

export function getSettings(orgId: number): Record<string, string> {
  const rows = all<{ key: string; value: string }>(
    "SELECT key, value FROM app_settings WHERE organization_id = ?",
    [orgId],
  );
  return { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
}
