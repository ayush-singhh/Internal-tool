/**
 * load_adjustments: itemized deductions and extra pay against a load.
 *
 * The rule worth pinning is validation (a bad kind, an empty description, a non-positive
 * amount all refuse rather than write a row) and tenant scoping, the same shape as every
 * other dispatch table.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { seedOrg, lookupId, type TestOrg } from "./helpers.ts";

const DB = path.join(tmpdir(), `carrier-hub-adjustments-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let adj: typeof import("../src/lib/load-adjustments.ts");
let alpha: TestOrg;
let beta: TestOrg;
let org: import("../src/lib/tenant-db.ts").Org;
let betaOrg: import("../src/lib/tenant-db.ts").Org;
let loadId: number;
let betaLoadId: number;

const now = () => new Date().toISOString();

before(async () => {
  db = await import("../src/lib/db.ts");
  adj = await import("../src/lib/load-adjustments.ts");
  const { Org } = await import("../src/lib/tenant-db.ts");

  alpha = seedOrg(db, "Alpha Dispatch");
  beta = seedOrg(db, "Beta Dispatch");
  org = new Org(alpha.id);
  betaOrg = new Org(beta.id);

  for (const o of [alpha, beta]) {
    db.run(
      `INSERT INTO carriers (organization_id, legal_name, status_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [o.id, `Carrier ${o.id}`, lookupId(db, o.id, "status", "active"), now(), now()],
    );
    const carrierId = db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
    db.run(
      `INSERT INTO loads (organization_id, carrier_id, status, created_at, updated_at)
       VALUES (?, ?, 'delivered', ?, ?)`,
      [o.id, carrierId, now(), now()],
    );
    const id = db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
    if (o.id === alpha.id) loadId = id; else betaLoadId = id;
  }
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

test("adding an adjustment validates kind, description and amount", () => {
  assert.equal(adj.addLoadAdjustment(org, loadId, { kind: "bogus", description: "x", amount: 1 }, alpha.ownerId).ok, false);
  assert.equal(adj.addLoadAdjustment(org, loadId, { kind: "deduction", description: "  ", amount: 1 }, alpha.ownerId).ok, false);
  assert.equal(adj.addLoadAdjustment(org, loadId, { kind: "deduction", description: "Damage", amount: 0 }, alpha.ownerId).ok, false);
  assert.equal(adj.addLoadAdjustment(org, loadId, { kind: "deduction", description: "Damage", amount: -5 }, alpha.ownerId).ok, false);
  assert.equal(adj.addLoadAdjustment(org, 999999, { kind: "deduction", description: "x", amount: 1 }, alpha.ownerId).ok, false);
});

test("a valid adjustment is added and listed, newest last", () => {
  const first = adj.addLoadAdjustment(org, loadId, { kind: "extra_pay", description: "Detention", amount: 270 }, alpha.ownerId);
  assert.equal(first.ok, true);
  const second = adj.addLoadAdjustment(org, loadId, { kind: "deduction", description: "Damage claim", amount: 50 }, alpha.ownerId);
  assert.equal(second.ok, true);

  const list = adj.listLoadAdjustments(org, loadId);
  assert.equal(list.length, 2);
  assert.equal(list[0]!.description, "Detention");
  assert.equal(list[0]!.kind, "extra_pay");
  assert.equal(list[1]!.description, "Damage claim");
});

test("an adjustment cannot be added to another tenant's load", () => {
  const result = adj.addLoadAdjustment(org, betaLoadId, { kind: "extra_pay", description: "x", amount: 10 }, alpha.ownerId);
  assert.equal(result.ok, false);
});

test("adjustments are scoped per tenant", () => {
  assert.equal(adj.listLoadAdjustments(betaOrg, loadId).length, 0);
});
