import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const paths: string[] = [];
const fresh = (label: string) => {
  const p = path.join(tmpdir(), `carrier-hub-mig-${label}-${process.pid}.db`);
  for (const s of ["", "-wal", "-shm"]) rmSync(`${p}${s}`, { force: true });
  paths.push(p);
  return new DatabaseSync(p);
};

let m: typeof import("../src/lib/migrations.ts");
before(async () => { m = await import("../src/lib/migrations.ts"); });
after(() => {
  for (const p of paths) for (const s of ["", "-wal", "-shm"]) rmSync(`${p}${s}`, { force: true });
});

const tables = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
    .map((r) => r.name);

test("an empty file becomes a complete database", () => {
  const db = fresh("empty");
  assert.equal(m.currentVersion(db), 0, "asking is safe before any migration");

  const { applied, version } = m.migrate(db);
  assert.equal(applied.length, m.MIGRATIONS.length);
  assert.equal(version, m.LATEST_VERSION);

  for (const t of [
    "users", "carriers", "lookups", "carrier_notes", "carrier_activity",
    "offboarding_records", "app_settings", "saved_filters", "sessions",
    "password_resets", "login_attempts", "schema_migrations",
  ]) {
    assert.ok(tables(db).includes(t), `${t} exists`);
  }
  db.close();
});

test("migrating twice changes nothing", () => {
  const db = fresh("twice");
  m.migrate(db);
  const second = m.migrate(db);
  assert.deepEqual(second.applied, []);
  assert.equal(second.version, m.LATEST_VERSION);
  db.close();
});

test("a database stopped part-way resumes from where it left off", () => {
  const db = fresh("partial");
  // Simulate an older deployment: baseline applied, later migrations not.
  m.MIGRATIONS.filter((x) => x.version === 1).forEach((x) => x.up(db));
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  db.prepare("INSERT INTO schema_migrations VALUES (1, 'baseline schema', ?)")
    .run(new Date().toISOString());

  assert.equal(m.currentVersion(db), 1);
  const { applied, version } = m.migrate(db);
  assert.equal(version, m.LATEST_VERSION);
  assert.ok(!applied.some((a) => a.startsWith("1.")), "the baseline is not re-run");
  assert.ok(applied.some((a) => a.includes("password reset")), "later ones are");
  db.close();
});

test("migrations never destroy existing rows", () => {
  const db = fresh("preserve");
  m.MIGRATIONS.filter((x) => x.version === 1).forEach((x) => x.up(db));
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  db.prepare("INSERT INTO schema_migrations VALUES (1, 'baseline schema', ?)")
    .run(new Date().toISOString());

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO users (name, email, password_hash, role, active, created_at, updated_at)
     VALUES ('Existing Person', 'keep@x.test', 'hash', 'admin', 1, ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO carriers (legal_name, mc_number, created_at, updated_at)
     VALUES ('Existing Carrier LLC', '123456', ?, ?)`,
  ).run(now, now);

  m.migrate(db);

  const carrier = db.prepare("SELECT legal_name, mc_number FROM carriers").get() as
    { legal_name: string; mc_number: string };
  const user = db.prepare("SELECT name, email FROM users").get() as
    { name: string; email: string };
  assert.equal(carrier.legal_name, "Existing Carrier LLC");
  assert.equal(carrier.mc_number, "123456");
  assert.equal(user.email, "keep@x.test");
  db.close();
});

test("a failing migration rolls back and reports which one", () => {
  const db = fresh("failing");
  m.migrate(db);
  const before = m.currentVersion(db);

  const broken = {
    version: 9999,
    name: "deliberately broken",
    up: (d: DatabaseSync) => {
      d.exec("CREATE TABLE will_be_rolled_back (id INTEGER)");
      d.exec("THIS IS NOT SQL");
    },
  };
  m.MIGRATIONS.push(broken);
  try {
    assert.throws(() => m.migrate(db), /Migration 9999 \(deliberately broken\) failed/);
    assert.equal(m.currentVersion(db), before, "version did not advance");
    assert.ok(
      !tables(db).includes("will_be_rolled_back"),
      "the half-finished work was rolled back",
    );
  } finally {
    m.MIGRATIONS.splice(m.MIGRATIONS.indexOf(broken), 1);
  }
  db.close();
});

test("versions are unique and ordered", () => {
  const versions = m.MIGRATIONS.map((x) => x.version);
  assert.equal(new Set(versions).size, versions.length, "no duplicate versions");
  assert.deepEqual([...versions].sort((a, b) => a - b), versions, "declared in order");
  assert.equal(Math.max(...versions), m.LATEST_VERSION);
});

/**
 * The upgrade this whole branch exists to serve: a single-tenant database full of a real
 * customer's data, carried across into multi-tenancy.
 *
 * Migrations 5 and 6 change table constraints, which SQLite can only do by rebuilding the
 * table — and `DROP TABLE` with foreign keys enforced fires the children's ON DELETE
 * CASCADE. Enforcement therefore has to be off, which `migrate()` arranges outside the
 * transaction, because `PRAGMA foreign_keys` does nothing inside one. Without that,
 * migration 5 failed outright (carriers → users is NO ACTION) and migration 6 silently
 * emptied every note, activity row and offboarding record.
 */
test("a single-tenant database keeps all of its data through the tenancy migrations", () => {
  const db = fresh("upgrade");
  db.exec("PRAGMA foreign_keys = ON");
  const now = new Date().toISOString();

  // Stop at version 4 — the last single-tenant schema — and fill it the way a real
  // install looks: carriers assigned to a user, each with notes, history and an exit.
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  for (const x of m.MIGRATIONS.filter((x) => x.version <= 4)) {
    x.up(db);
    db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(x.version, x.name, now);
  }
  db.exec(`INSERT INTO users (id,name,email,password_hash,role,active,created_at,updated_at)
           VALUES (1,'Dispatcher One','d1@x.com','h','dispatcher',1,'${now}','${now}')`);
  db.exec(`INSERT INTO lookups (id,kind,value,label,sort,active)
           VALUES (1,'status','active','Active',0,1)`);
  db.exec(`INSERT INTO app_settings (key,value) VALUES ('company_name','Real Customer Inc')`);
  for (let i = 1; i <= 3; i++) {
    db.exec(`INSERT INTO carriers (id,legal_name,status_id,dispatcher_id,created_at,updated_at)
             VALUES (${i},'Carrier ${i}',1,1,'${now}','${now}')`);
    db.exec(`INSERT INTO carrier_notes (carrier_id,user_id,body,pinned,created_at)
             VALUES (${i},1,'note ${i}',0,'${now}')`);
    db.exec(`INSERT INTO carrier_activity (carrier_id,user_id,type,summary,created_at)
             VALUES (${i},1,'created','Carrier record created','${now}')`);
  }
  db.exec(`INSERT INTO offboarding_records (carrier_id,offboarded_on,created_at)
           VALUES (3,'2026-01-15','${now}')`);
  db.exec(`INSERT INTO saved_filters (user_id,name,query,shared,created_at)
           VALUES (1,'My view','?status=1',0,'${now}')`);

  const counted = ["users", "carriers", "carrier_notes", "carrier_activity",
                   "offboarding_records", "saved_filters"];
  const count = (t: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  const before = Object.fromEntries(counted.map((t) => [t, count(t)]));

  m.migrate(db);

  for (const t of counted) {
    assert.equal(count(t), before[t], `${t} survived the upgrade intact`);
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE organization_id IS NULL`)
        .get() as { n: number }).n,
      0,
      `${t} was attributed to the organisation`,
    );
  }
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), [],
    "no dangling references were left behind");
  assert.equal(
    (db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1,
    "enforcement was switched back on afterwards",
  );
  db.close();
});

test("migration 17 backfills flat-per-load pricing into an existing organisation", () => {
  const db = fresh("backfill");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const now = new Date().toISOString();
  for (const x of m.MIGRATIONS.filter((x) => x.version <= 16)) {
    x.up(db);
    db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(x.version, x.name, now);
  }
  db.exec(`INSERT INTO organizations (name, slug, status, created_at)
           VALUES ('Existing Co', 'existing-co', 'active', '${now}')`);
  const orgId = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  db.prepare(
    `INSERT INTO lookups (organization_id, kind, value, label, sort)
     VALUES (?, 'pricing_type', 'percentage_per_load', 'Percentage Per Load', 0)`,
  ).run(orgId);

  m.migrate(db);

  const row = db.prepare(
    "SELECT label FROM lookups WHERE organization_id = ? AND kind = 'pricing_type' AND value = 'flat_per_load'",
  ).get(orgId) as { label: string } | undefined;
  assert.ok(row, "the pre-existing organisation gained the new pricing type");
  assert.equal(row!.label, "Flat Fee Per Load");
  db.close();
});
