/**
 * The dispatch tables, held to the same standard as the carrier tables.
 *
 * Three layers protect tenancy here, and this file checks the two that live in the
 * database and the guard, because they are the ones a future query cannot opt out of:
 *
 *   Layer 1  composite foreign keys — a load may not point at another tenant's carrier,
 *            driver or broker, and SQLite refuses the row outright
 *   Layer 2  the fail-closed query guard — an unscoped query against a dispatch table
 *            throws rather than returning somebody else's loads
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { seedOrg, lookupId, type TestOrg } from "./helpers.ts";

const DB = path.join(tmpdir(), `carrier-hub-dispatch-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let alpha: TestOrg;
let beta: TestOrg;
let alphaCarrier: number;
let betaCarrier: number;
let alphaDriver: number;

const now = () => new Date().toISOString();

before(async () => {
  db = await import("../src/lib/db.ts");
  alpha = seedOrg(db, "Alpha Dispatch");
  beta = seedOrg(db, "Beta Dispatch");

  for (const org of [alpha, beta]) {
    db.run(
      `INSERT INTO carriers (organization_id, legal_name, status_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [org.id, `Carrier of ${org.id}`, lookupId(db, org.id, "status", "active"), now(), now()],
    );
  }
  alphaCarrier = db.get<{ id: number }>(
    "SELECT id FROM carriers WHERE organization_id = ?", [alpha.id])!.id;
  betaCarrier = db.get<{ id: number }>(
    "SELECT id FROM carriers WHERE organization_id = ?", [beta.id])!.id;

  db.run(
    `INSERT INTO drivers (organization_id, carrier_id, name, active, created_at, updated_at)
     VALUES (?, ?, 'Alpha Driver', 1, ?, ?)`,
    [alpha.id, alphaCarrier, now(), now()],
  );
  alphaDriver = db.get<{ id: number }>(
    "SELECT id FROM drivers WHERE organization_id = ?", [alpha.id])!.id;
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

test("every organisation gets its own copy of the broker list", () => {
  const count = (orgId: number) =>
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM brokers WHERE organization_id = ?", [orgId])!.n;

  assert.equal(count(alpha.id), 100, "the shipped list is seeded");
  assert.equal(count(beta.id), 100);

  // Alpha correcting a name must not touch Beta's dropdown.
  db.run(
    "UPDATE brokers SET name = 'Renamed By Alpha' WHERE organization_id = ? AND name = 'Coyote Logistics'",
    [alpha.id],
  );
  assert.ok(
    db.get("SELECT 1 FROM brokers WHERE organization_id = ? AND name = 'Coyote Logistics'", [beta.id]),
    "Beta still has the original name",
  );
});

test("a load cannot be given another tenant's carrier", () => {
  assert.throws(
    () =>
      db.run(
        `INSERT INTO loads (organization_id, carrier_id, status, created_at, updated_at)
         VALUES (?, ?, 'created', ?, ?)`,
        [alpha.id, betaCarrier, now(), now()],
      ),
    /FOREIGN KEY constraint failed/,
    "the database refuses it, whatever the application layer believes",
  );
});

test("a load cannot be given another tenant's driver", () => {
  assert.throws(
    () =>
      db.run(
        `INSERT INTO loads (organization_id, carrier_id, driver_id, status, created_at, updated_at)
         VALUES (?, ?, ?, 'created', ?, ?)`,
        [beta.id, betaCarrier, alphaDriver, now(), now()],
      ),
    /FOREIGN KEY constraint failed/,
  );
});

test("a driver cannot be attached to another tenant's carrier", () => {
  assert.throws(
    () =>
      db.run(
        `INSERT INTO drivers (organization_id, carrier_id, name, created_at, updated_at)
         VALUES (?, ?, 'Impostor', ?, ?)`,
        [beta.id, alphaCarrier, now(), now()],
      ),
    /FOREIGN KEY constraint failed/,
  );
});

test("stops belong to a load in the same tenant, and go when it goes", () => {
  db.run(
    `INSERT INTO loads (organization_id, carrier_id, status, created_at, updated_at)
     VALUES (?, ?, 'created', ?, ?)`,
    [alpha.id, alphaCarrier, now(), now()],
  );
  const load = db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;

  for (const [kind, seq, city] of [["pickup", 1, "Dallas"], ["delivery", 1, "Newark"]] as const) {
    db.run(
      `INSERT INTO load_stops (organization_id, load_id, kind, sequence, city)
       VALUES (?, ?, ?, ?, ?)`,
      [alpha.id, load, kind, seq, city],
    );
  }

  assert.throws(
    () =>
      db.run(
        `INSERT INTO load_stops (organization_id, load_id, kind, sequence, city)
         VALUES (?, ?, 'pickup', 2, 'Somewhere')`,
        [beta.id, load],
      ),
    /FOREIGN KEY constraint failed/,
    "another tenant cannot bolt a stop onto this load",
  );

  // One stop of each kind may hold a given position, and only one.
  assert.throws(
    () =>
      db.run(
        `INSERT INTO load_stops (organization_id, load_id, kind, sequence, city)
         VALUES (?, ?, 'pickup', 1, 'Duplicate')`,
        [alpha.id, load],
      ),
    /UNIQUE constraint failed/,
  );

  db.run("DELETE FROM loads WHERE organization_id = ? AND id = ?", [alpha.id, load]);
  assert.equal(
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM load_stops WHERE organization_id = ? AND load_id = ?",
      [alpha.id, load],
    )!.n,
    0,
    "the stops went with the load",
  );
});

test("the fail-closed guard covers the dispatch tables too", async () => {
  const { tenantTablesLackingScope, TENANT_TABLES } = await import("../src/lib/tenant-db.ts");

  for (const table of ["drivers", "brokers", "loads", "load_stops"]) {
    assert.ok(
      (TENANT_TABLES as readonly string[]).includes(table),
      `${table} is declared tenant-owned`,
    );
    assert.deepEqual(
      tenantTablesLackingScope(`SELECT * FROM ${table}`),
      [table],
      `an unscoped read of ${table} is refused`,
    );
  }

  // And the guard is live, not merely declared.
  assert.throws(
    () => db.all("SELECT * FROM loads"),
    /Tenant isolation guard/,
    "a query that forgets organization_id throws instead of leaking",
  );
});
