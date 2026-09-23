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
  const p = path.join(tmpdir(), `carrier-hub-applications-${label}-${process.pid}.db`);
  for (const s of ["", "-wal", "-shm"]) rmSync(`${p}${s}`, { force: true });
  paths.push(p);
  return new DatabaseSync(p);
};

let m: typeof import("../src/lib/migrations.ts");
let t: typeof import("../src/lib/tenant-db.ts");
before(async () => {
  m = await import("../src/lib/migrations.ts");
  t = await import("../src/lib/tenant-db.ts");
});
after(() => {
  for (const p of paths) for (const s of ["", "-wal", "-shm"]) rmSync(`${p}${s}`, { force: true });
});

const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

const tables = (db: DatabaseSync) =>
  (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
    .map((r) => r.name);

const addOrg = (db: DatabaseSync, name: string): number => {
  db.prepare("INSERT INTO organizations (name, slug, status, created_at) VALUES (?, ?, 'active', ?)")
    .run(name, name.toLowerCase().replace(/\W+/g, "-"), new Date().toISOString());
  return (db.prepare("SELECT id FROM organizations WHERE name = ?").get(name) as { id: number }).id;
};

/** Inserts a draft application. Returns the new id. */
const addDraft = (db: DatabaseSync, orgId: number, usdot: string, status = "draft"): number => {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO carrier_applications
       (organization_id, usdot, legal_name, phone, phone_digits, email, status, step,
        created_at, updated_at)
     VALUES (?, ?, 'Test Carrier LLC', '555-0100', '5550100', 'a@b.test', ?, 'account', ?, ?)`,
  ).run(orgId, usdot, status, now, now);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
};

test("migration 25 creates the application, session and OTP tables", () => {
  const db = fresh("tables");
  m.migrate(db);

  const present = tables(db);
  for (const name of ["carrier_applications", "applicant_sessions", "applicant_otps"]) {
    assert.ok(present.includes(name), `${name} exists`);
  }

  for (const c of [
    "organization_id", "usdot", "legal_name", "dba_name", "operating_state",
    "allowed_to_operate", "name_source", "phone", "phone_digits", "email",
    "status", "step", "review_notes", "rejected_reason",
    "converted_carrier_id", "converted_at", "converted_by", "submitted_at",
  ]) {
    assert.ok(columns(db, "carrier_applications").includes(c), `carrier_applications.${c}`);
  }
  for (const c of ["id", "organization_id", "application_id", "created_at", "expires_at"]) {
    assert.ok(columns(db, "applicant_sessions").includes(c), `applicant_sessions.${c}`);
  }
  for (const c of ["organization_id", "phone_digits", "code_hash", "expires_at", "attempts", "consumed_at"]) {
    assert.ok(columns(db, "applicant_otps").includes(c), `applicant_otps.${c}`);
  }
  db.close();
});

test("only one open application per carrier per organisation", () => {
  const db = fresh("unique");
  m.migrate(db);
  const org = addOrg(db, "Acme Dispatch");

  addDraft(db, org, "1234567");
  // A second open application for the same USDOT is the same carrier applying twice —
  // usually a lost tab, never two real applications.
  assert.throws(() => addDraft(db, org, "1234567"), /UNIQUE|constraint/i);

  // A submitted one still counts as open.
  const other = addDraft(db, org, "7654321", "submitted");
  assert.throws(() => addDraft(db, org, "7654321"), /UNIQUE|constraint/i);

  // Once it leaves the open states, the carrier may apply again — a rejected applicant
  // who fixed the problem is not barred forever.
  db.prepare("UPDATE carrier_applications SET status = 'rejected' WHERE id = ?").run(other);
  assert.doesNotThrow(() => addDraft(db, org, "7654321"));
  db.close();
});

test("the same carrier may apply to two different organisations", () => {
  const db = fresh("cross-org");
  m.migrate(db);
  const a = addOrg(db, "Org A");
  const b = addOrg(db, "Org B");
  addDraft(db, a, "1234567");
  // The index is scoped per organisation; a carrier shopping two dispatchers is normal.
  assert.doesNotThrow(() => addDraft(db, b, "1234567"));
  db.close();
});

test("migration 25 leaves no dangling references", () => {
  const db = fresh("fk");
  m.migrate(db);
  const org = addOrg(db, "Acme Dispatch");
  addDraft(db, org, "1234567");
  assert.equal((db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length, 0);
  db.close();
});

test("carrier_applications is guarded as a tenant table; session tables are not", () => {
  // The guard in db.ts refuses a query that touches a tenant table without scoping it.
  assert.ok(t.TENANT_TABLES.includes("carrier_applications" as never));
  assert.deepEqual(
    t.tenantTablesLackingScope("SELECT * FROM carrier_applications"),
    ["carrier_applications"],
  );
  assert.deepEqual(
    t.tenantTablesLackingScope("SELECT * FROM carrier_applications WHERE organization_id = ?"),
    [],
  );
  // applicant_sessions is read before an organisation is known — the cookie is all there
  // is — so it is a system table like `sessions`, not a tenant one.
  assert.deepEqual(t.tenantTablesLackingScope("SELECT * FROM applicant_sessions WHERE id = ?"), []);
});
