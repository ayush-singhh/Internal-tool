import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Raw DatabaseSync rather than db.ts: this is about what the migration does to a
// database, so nothing may seed or connect on our behalf.
const paths: string[] = [];
const fresh = (label: string) => {
  const p = path.join(tmpdir(), `carrier-hub-billing-${label}-${process.pid}.db`);
  for (const s of ["", "-wal", "-shm"]) rmSync(`${p}${s}`, { force: true });
  paths.push(p);
  return new DatabaseSync(p);
};

let m: typeof import("../src/lib/migrations.ts");
before(async () => { m = await import("../src/lib/migrations.ts"); });
after(() => {
  for (const p of paths) for (const s of ["", "-wal", "-shm"]) rmSync(`${p}${s}`, { force: true });
});

const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

/** Migrates to `version` and no further — an older deployment on the morning of an upgrade. */
function upTo(db: DatabaseSync, version: number): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  for (const migration of m.MIGRATIONS.filter((x) => x.version <= version)) {
    migration.up(db);
    db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)")
      .run(migration.version, migration.name, new Date().toISOString());
  }
}

const addOrg = (db: DatabaseSync, name: string) =>
  db.prepare(
    "INSERT INTO organizations (name, slug, status, created_at) VALUES (?, ?, 'active', ?)",
  ).run(name, name.toLowerCase().replace(/\W+/g, "-"), new Date().toISOString());

const modeOf = (db: DatabaseSync, name: string) =>
  (db.prepare("SELECT billing_mode FROM organizations WHERE name = ?").get(name) as
    { billing_mode: string }).billing_mode;

test("migration 24 adds the billing columns and the event ledger", () => {
  const db = fresh("columns");
  m.migrate(db);
  for (const c of [
    "stripe_customer_id", "stripe_subscription_id", "plan",
    "trial_ends_at", "current_period_end", "billing_mode",
  ]) {
    assert.ok(columns(db, "organizations").includes(c), `organizations.${c} exists`);
  }
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as
    { name: string }[]).map((r) => r.name);
  assert.ok(tables.includes("stripe_events"));
  db.close();
});

test("every organisation that predates billing is comped, and keeps working", () => {
  const db = fresh("grandfather");
  upTo(db, 23);
  addOrg(db, "Live Tenant");
  addOrg(db, "Bootstrap Admin");

  const { applied } = m.migrate(db);
  // Named, not counted: what matters is that 24 ran against a pre-billing database, and
  // a count breaks every time a later migration is added for unrelated reasons.
  assert.ok(
    applied.some((name) => name.includes("billing:")),
    `migration 24 ran (applied: ${applied.join(", ")})`,
  );
  assert.equal(modeOf(db, "Live Tenant"), "comped");
  assert.equal(modeOf(db, "Bootstrap Admin"), "comped");
  db.close();
});

test("an organisation created after migration 24 is billable by default", () => {
  const db = fresh("default");
  m.migrate(db);
  addOrg(db, "New Signup");
  // Fails closed: a future code path that forgets to say lands in the paying lane
  // rather than becoming free forever.
  assert.equal(modeOf(db, "New Signup"), "stripe");
  db.close();
});

test("re-running the migration does not re-comp a paying organisation", () => {
  const db = fresh("rerun");
  m.migrate(db);
  addOrg(db, "Paying");
  // Simulate a re-application, which the ledger normally prevents: the backfill must be
  // guarded by whether the column was actually just added, not run unconditionally.
  m.MIGRATIONS.find((x) => x.version === 24)!.up(db);
  assert.equal(modeOf(db, "Paying"), "stripe");
  db.close();
});

test("the event ledger refuses a duplicate delivery", () => {
  const db = fresh("events");
  m.migrate(db);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)",
  );
  assert.equal(Number(insert.run("evt_1", "x", "2026-09-06").changes), 1);
  assert.equal(Number(insert.run("evt_1", "x", "2026-09-06").changes), 0, "second delivery is a no-op");
  db.close();
});
