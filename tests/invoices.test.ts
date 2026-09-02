/**
 * Dispatch invoices.
 *
 * computeDispatchFee is pure and gets its own no-database slice at the top; createInvoice
 * and setInvoiceStatus need a real database, seeded once `before()` all of these run.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { seedOrg, lookupId, type TestOrg } from "./helpers.ts";

const DB = path.join(tmpdir(), `carrier-hub-invoices-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let inv: typeof import("../src/lib/invoices.ts");
let iw: typeof import("../src/lib/invoice-write.ts");
let alpha: TestOrg;
let org: import("../src/lib/tenant-db.ts").Org;
let percentCarrier: number;
let flatCarrier: number;
let unsupportedCarrier: number;

const now = () => new Date().toISOString();

before(async () => {
  db = await import("../src/lib/db.ts");
  inv = await import("../src/lib/invoices.ts");
  iw = await import("../src/lib/invoice-write.ts");
  const { Org } = await import("../src/lib/tenant-db.ts");

  alpha = seedOrg(db, "Alpha Dispatch");
  org = new Org(alpha.id);

  const carrier = (pricingValue: string, rate: number | null, percentage: number | null) => {
    db.run(
      `INSERT INTO carriers (organization_id, legal_name, status_id, pricing_type_id, rate, percentage, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [alpha.id, `Carrier ${pricingValue}`, lookupId(db, alpha.id, "status", "active"),
       lookupId(db, alpha.id, "pricing_type", pricingValue), rate, percentage, now(), now()],
    );
    return db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
  };
  percentCarrier = carrier("percentage_per_load", null, 10);
  flatCarrier = carrier("flat_per_load", 75, null);
  unsupportedCarrier = carrier("fixed_monthly", 500, null);
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

function deliveredLoad(carrierId: number, rate: number): number {
  db.run(
    `INSERT INTO loads (organization_id, carrier_id, status, rate, created_at, updated_at)
     VALUES (?, ?, 'delivered', ?, ?, ?)`,
    [alpha.id, carrierId, rate, now(), now()],
  );
  return db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
}

test("computeDispatchFee: percentage of Final Load Amount", () => {
  const result = inv.computeDispatchFee({ pricingType: "percentage_per_load", rate: null, percentage: 10 }, 3920);
  assert.deepEqual(result, { ok: true, basis: "percentage", rateValue: 10, amount: 392 });
});

test("computeDispatchFee: flat fee ignores Final Load Amount", () => {
  const result = inv.computeDispatchFee({ pricingType: "flat_per_load", rate: 75, percentage: null }, 3920);
  assert.deepEqual(result, { ok: true, basis: "flat", rateValue: 75, amount: 75 });
});

test("computeDispatchFee: missing configuration is an error, not a guess", () => {
  assert.equal(inv.computeDispatchFee({ pricingType: "percentage_per_load", rate: null, percentage: null }, 100).ok, false);
  assert.equal(inv.computeDispatchFee({ pricingType: "flat_per_load", rate: null, percentage: null }, 100).ok, false);
});

test("computeDispatchFee: an unsupported pricing type refuses rather than guessing", () => {
  for (const pricingType of ["fixed_monthly", "fixed_weekly", "custom", "not_yet_pitched", null]) {
    const result = inv.computeDispatchFee({ pricingType, rate: 100, percentage: 10 }, 1000);
    assert.equal(result.ok, false);
  }
});

test("computeDispatchFee rounds to the cent", () => {
  const result = inv.computeDispatchFee({ pricingType: "percentage_per_load", rate: null, percentage: 12.5 }, 333.33);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.amount, 41.67);
});

test("createInvoice batches loads for one carrier, snapshots amounts, advances status", () => {
  const a = deliveredLoad(percentCarrier, 1000);
  const b = deliveredLoad(percentCarrier, 2000);

  const result = iw.createInvoice(org, { carrierId: percentCarrier, loadIds: [a, b], issuedOn: "2026-09-02" }, alpha.ownerId);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const header = inv.getInvoice(org, result.id)!;
  assert.equal(header.status, "pending");
  assert.equal(header.total_amount, 300); // 10% of 1000 + 10% of 2000

  const lines = inv.invoiceLines(org, result.id);
  assert.equal(lines.length, 2);

  const loadA = db.get<{ status: string }>("SELECT status FROM loads WHERE organization_id = ? AND id = ?", [alpha.id, a])!;
  assert.equal(loadA.status, "invoiced");
});

test("createInvoice rejects a load that is not Delivered", () => {
  db.run(
    `INSERT INTO loads (organization_id, carrier_id, status, rate, created_at, updated_at)
     VALUES (?, ?, 'assigned', 500, ?, ?)`,
    [alpha.id, percentCarrier, now(), now()],
  );
  const id = db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
  const result = iw.createInvoice(org, { carrierId: percentCarrier, loadIds: [id], issuedOn: "2026-09-02" }, alpha.ownerId);
  assert.equal(result.ok, false);
});

test("createInvoice refuses a carrier whose pricing arrangement isn't per-load", () => {
  const load = deliveredLoad(unsupportedCarrier, 1000);
  const result = iw.createInvoice(org, { carrierId: unsupportedCarrier, loadIds: [load], issuedOn: "2026-09-02" }, alpha.ownerId);
  assert.equal(result.ok, false);
});

test("createInvoice refuses an empty selection", () => {
  const result = iw.createInvoice(org, { carrierId: percentCarrier, loadIds: [], issuedOn: "2026-09-02" }, alpha.ownerId);
  assert.equal(result.ok, false);
});

test("a flat-fee carrier is charged the flat rate regardless of load amount", () => {
  const load = deliveredLoad(flatCarrier, 9999);
  const result = iw.createInvoice(org, { carrierId: flatCarrier, loadIds: [load], issuedOn: "2026-09-02" }, alpha.ownerId);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(inv.getInvoice(org, result.id)!.total_amount, 75);
});

test("marking an invoice Paid advances its loads to Paid; disputing never walks them back", () => {
  const load = deliveredLoad(percentCarrier, 1000);
  const created = iw.createInvoice(org, { carrierId: percentCarrier, loadIds: [load], issuedOn: "2026-09-02" }, alpha.ownerId);
  assert.equal(created.ok, true);
  if (!created.ok) return;

  iw.setInvoiceStatus(org, created.id, "paid", alpha.ownerId);
  assert.equal(db.get<{ status: string }>("SELECT status FROM loads WHERE organization_id = ? AND id = ?", [alpha.id, load])!.status, "paid");
  assert.ok(inv.getInvoice(org, created.id)!.paid_on);

  iw.setInvoiceStatus(org, created.id, "disputed", alpha.ownerId);
  assert.equal(db.get<{ status: string }>("SELECT status FROM loads WHERE organization_id = ? AND id = ?", [alpha.id, load])!.status, "paid",
    "disputing the invoice does not walk the load status backward");
  assert.equal(inv.getInvoice(org, created.id)!.paid_on, null);
});
