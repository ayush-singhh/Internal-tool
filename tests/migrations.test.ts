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
