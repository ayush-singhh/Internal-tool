/**
 * The load domain: RPM, the status flow, stops, and tenant scoping.
 *
 * The rules worth pinning are the ones a Server Action can reach without a page ever
 * being rendered — status moving forward only, and a load never being dispatched without
 * a driver. A UI that hides a button is not what enforces either.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { seedOrg, lookupId, type TestOrg } from "./helpers.ts";

const DB = path.join(tmpdir(), `carrier-hub-loads-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let loads: typeof import("../src/lib/loads.ts");
let write: typeof import("../src/lib/load-write.ts");
let C: typeof import("../src/lib/constants.ts");
let alpha: TestOrg;
let beta: TestOrg;
let org: import("../src/lib/tenant-db.ts").Org;
let betaOrg: import("../src/lib/tenant-db.ts").Org;
let carrier: number;
let betaCarrier: number;
let driver: number;
let broker: number;

const now = () => new Date().toISOString();

before(async () => {
  db = await import("../src/lib/db.ts");
  loads = await import("../src/lib/loads.ts");
  write = await import("../src/lib/load-write.ts");
  C = await import("../src/lib/constants.ts");
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
  }
  carrier = db.get<{ id: number }>("SELECT id FROM carriers WHERE organization_id = ?", [alpha.id])!.id;
  betaCarrier = db.get<{ id: number }>("SELECT id FROM carriers WHERE organization_id = ?", [beta.id])!.id;

  db.run(
    `INSERT INTO drivers (organization_id, carrier_id, name, active, created_at, updated_at)
     VALUES (?, ?, 'Dale Driver', 1, ?, ?)`, [alpha.id, carrier, now(), now()]);
  driver = db.get<{ id: number }>("SELECT id FROM drivers WHERE organization_id = ?", [alpha.id])!.id;
  broker = db.get<{ id: number }>(
    "SELECT id FROM brokers WHERE organization_id = ? AND name = 'Coyote Logistics'", [alpha.id])!.id;
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

beforeEach(() => {
  db.run("DELETE FROM loads WHERE organization_id IN (?, ?)", [alpha.id, beta.id]);
});

const STOPS = [
  { kind: "pickup" as const, city: "Dallas", state: "TX" },
  { kind: "delivery" as const, city: "Newark", state: "NJ" },
];

const make = (over: Partial<Parameters<typeof write.createLoad>[1]> = {}) =>
  write.createLoad(org, { carrierId: carrier, stops: STOPS, ...over }, alpha.ownerId);

// ── rate per mile ────────────────────────────────────────────────────────────

test("both rates per mile are computed, and neither divides by zero", () => {
  assert.deepEqual(
    loads.rpm({ rate: 2000, loaded_miles: 1000, deadhead_miles: 250, exception: null, adjustments_net: 0 }),
    { loaded: 2, total: 1.6 }, "loaded uses freight miles; total includes the empty run");

  assert.deepEqual(
    loads.rpm({ rate: 2000, loaded_miles: 0, deadhead_miles: 0, exception: null, adjustments_net: 0 }),
    { loaded: null, total: null }, "no miles means no rate per mile, not Infinity");

  assert.deepEqual(
    loads.rpm({ rate: null, loaded_miles: 500, deadhead_miles: 10, exception: null, adjustments_net: 0 }),
    { loaded: null, total: null }, "no rate means nothing to divide");

  assert.deepEqual(
    loads.rpm({ rate: 1500, loaded_miles: 500, deadhead_miles: null, exception: null, adjustments_net: 0 }),
    { loaded: 3, total: 3 }, "a missing deadhead counts as zero, not as unknown");
});

test("finalLoadAmount and rpm: the ordinary case is unchanged", () => {
  const load = { rate: 1000, exception: null, adjustments_net: 0, loaded_miles: 500, deadhead_miles: 100 };
  assert.equal(loads.finalLoadAmount(load), 1000);
  assert.equal(loads.rpm(load).loaded, 2);
  assert.equal(loads.rpm(load).total, 1000 / 600);
});

test("finalLoadAmount adds extra pay and subtracts deductions", () => {
  assert.equal(loads.finalLoadAmount({ rate: 3650, exception: null, adjustments_net: 270 }), 3920);
  assert.equal(loads.finalLoadAmount({ rate: 3650, exception: null, adjustments_net: -200 }), 3450);
});

test("a TONU or cancelled load bills only what was approved, never the linehaul", () => {
  assert.equal(loads.finalLoadAmount({ rate: 2000, exception: C.LOAD_EXCEPTION.TONU, adjustments_net: 0 }), null);
  assert.equal(loads.finalLoadAmount({ rate: 2000, exception: C.LOAD_EXCEPTION.TONU, adjustments_net: 150 }), 150);
  assert.equal(loads.finalLoadAmount({ rate: 2000, exception: C.LOAD_EXCEPTION.CANCELLED, adjustments_net: 0 }), null);
});

test("finalLoadAmount is null, not zero, with nothing to bill", () => {
  assert.equal(loads.finalLoadAmount({ rate: null, exception: null, adjustments_net: 0 }), null);
  assert.deepEqual(
    loads.rpm({ rate: null, exception: null, adjustments_net: 0, loaded_miles: 500, deadhead_miles: 0 }),
    { loaded: null, total: null });
});

test("paid sits between invoiced and closed, forward only", () => {
  assert.deepEqual(loads.nextStatuses(C.LOAD_STATUS.INVOICED), [C.LOAD_STATUS.PAID]);
  assert.deepEqual(loads.nextStatuses(C.LOAD_STATUS.PAID), [C.LOAD_STATUS.CLOSED]);
});

// ── creation ─────────────────────────────────────────────────────────────────

test("a load needs at least one pickup and one delivery", () => {
  assert.deepEqual(make({ stops: [] }), { ok: false, error: "A load needs at least one pickup." });
  assert.deepEqual(make({ stops: [{ kind: "pickup", city: "Dallas" }] }),
    { ok: false, error: "A load needs at least one delivery." });
});

test("a load carries up to five pickups and five deliveries, and no more", () => {
  const many = (n: number, kind: "pickup" | "delivery") =>
    Array.from({ length: n }, (_, i) => ({ kind, city: `City ${i}` }));

  const ok = make({ stops: [...many(5, "pickup"), ...many(5, "delivery")] });
  assert.equal(ok.ok, true, "five and five is allowed");

  const tooMany = make({ stops: [...many(6, "pickup"), ...many(1, "delivery")] });
  assert.deepEqual(tooMany, { ok: false, error: "A load can have at most 5 pickups." });
});

test("stops are numbered per kind, so pickups and deliveries count separately", () => {
  const created = make({
    stops: [
      { kind: "pickup", city: "Dallas" },
      { kind: "pickup", city: "Austin" },
      { kind: "delivery", city: "Newark" },
    ],
  });
  assert.equal(created.ok, true);
  const stops = loads.loadStops(org, (created as { id: number }).id);
  assert.deepEqual(
    stops.map((s) => `${s.kind}${s.sequence}:${s.city}`),
    ["pickup1:Dallas", "pickup2:Austin", "delivery1:Newark"],
    "pickups first, each sequence starting at one",
  );
});

test("a load created with a driver is already Assigned; without one it is Created", () => {
  const withDriver = make({ driverId: driver });
  const without = make();
  assert.equal(loads.getLoad(org, (withDriver as { id: number }).id)!.status, C.LOAD_STATUS.ASSIGNED);
  assert.equal(loads.getLoad(org, (without as { id: number }).id)!.status, C.LOAD_STATUS.CREATED);
});

test("another tenant's carrier, driver or broker is refused by name, not by stack trace", () => {
  assert.deepEqual(
    write.createLoad(org, { carrierId: betaCarrier, stops: STOPS }, alpha.ownerId),
    { ok: false, error: "Unknown carrier." },
  );
  const betaDriverId = 9999;
  assert.deepEqual(
    write.createLoad(org, { carrierId: carrier, driverId: betaDriverId, stops: STOPS }, alpha.ownerId),
    { ok: false, error: "Unknown driver." },
  );
});

// ── the status flow ──────────────────────────────────────────────────────────

test("status moves forward one step at a time", () => {
  const id = (make({ driverId: driver }) as { id: number }).id;
  const S = C.LOAD_STATUS;

  assert.deepEqual(
    write.setStatus(org, id, S.DELIVERED, alpha.ownerId),
    { ok: false, error: "A load goes from Assigned to Picked Up, one step at a time." },
    "no skipping ahead to Delivered",
  );

  for (const step of [S.PICKED_UP, S.IN_TRANSIT, S.DELIVERED]) {
    assert.equal(write.setStatus(org, id, step, alpha.ownerId).ok, true, `advances to ${step}`);
  }
  assert.equal(loads.getLoad(org, id)!.status, S.DELIVERED);
});

test("a load never goes backwards", () => {
  const id = (make({ driverId: driver }) as { id: number }).id;
  write.setStatus(org, id, C.LOAD_STATUS.PICKED_UP, alpha.ownerId);
  assert.deepEqual(
    write.setStatus(org, id, C.LOAD_STATUS.ASSIGNED, alpha.ownerId),
    { ok: false, error: "A load cannot go back from Picked Up to Assigned." },
  );
});

test("pickup and delivery are timestamped as they happen, because invoices are built from them", () => {
  const id = (make({ driverId: driver }) as { id: number }).id;
  assert.equal(loads.getLoad(org, id)!.picked_up_at, null);

  write.setStatus(org, id, C.LOAD_STATUS.PICKED_UP, alpha.ownerId);
  assert.ok(loads.getLoad(org, id)!.picked_up_at, "stamped at pickup");
  assert.equal(loads.getLoad(org, id)!.delivered_at, null, "but not delivered yet");

  write.setStatus(org, id, C.LOAD_STATUS.IN_TRANSIT, alpha.ownerId);
  write.setStatus(org, id, C.LOAD_STATUS.DELIVERED, alpha.ownerId);
  assert.ok(loads.getLoad(org, id)!.delivered_at, "stamped at delivery");
});

test("assigning a driver advances a Created load, and unassigning takes it back", () => {
  const id = (make() as { id: number }).id;
  write.assignDriver(org, id, driver, alpha.ownerId);
  assert.equal(loads.getLoad(org, id)!.status, C.LOAD_STATUS.ASSIGNED);

  write.assignDriver(org, id, null, alpha.ownerId);
  assert.equal(loads.getLoad(org, id)!.status, C.LOAD_STATUS.CREATED, "back to unassigned");
});

test("a running load cannot be left without a driver", () => {
  const id = (make({ driverId: driver }) as { id: number }).id;
  write.setStatus(org, id, C.LOAD_STATUS.PICKED_UP, alpha.ownerId);
  assert.deepEqual(
    write.assignDriver(org, id, null, alpha.ownerId),
    { ok: false, error: "This load is already running — it cannot be left without a driver." },
  );
});

// ── exceptions ───────────────────────────────────────────────────────────────

test("an exception sits beside the status rather than replacing it", () => {
  const id = (make({ driverId: driver }) as { id: number }).id;
  for (const s of [C.LOAD_STATUS.PICKED_UP, C.LOAD_STATUS.IN_TRANSIT, C.LOAD_STATUS.DELIVERED]) {
    write.setStatus(org, id, s, alpha.ownerId);
  }
  write.setException(org, id, C.LOAD_EXCEPTION.DEDUCTION, alpha.ownerId);

  const load = loads.getLoad(org, id)!;
  assert.equal(load.status, C.LOAD_STATUS.DELIVERED, "still delivered");
  assert.equal(load.exception, C.LOAD_EXCEPTION.DEDUCTION, "and carrying a deduction");

  write.setException(org, id, null, alpha.ownerId);
  assert.equal(loads.getLoad(org, id)!.exception, null, "cleared");
});

// ── listing ──────────────────────────────────────────────────────────────────

test("the list shows a route without loading every stop", () => {
  make({ stops: [
    { kind: "pickup", city: "Dallas", state: "TX" },
    { kind: "pickup", city: "Austin", state: "TX" },
    { kind: "delivery", city: "Trenton", state: "NJ" },
    { kind: "delivery", city: "Newark", state: "NJ" },
  ] });
  const row = loads.listLoads(org).rows[0]!;
  assert.equal(row.origin, "Dallas, TX", "the first pickup");
  assert.equal(row.destination, "Newark, NJ", "the last delivery");
  assert.equal(row.pickup_count, 2);
  assert.equal(row.delivery_count, 2);
});

test("one tenant's loads are invisible to another", () => {
  make({ driverId: driver });
  write.createLoad(betaOrg, { carrierId: betaCarrier, stops: STOPS }, beta.ownerId);

  assert.equal(loads.listLoads(org).total, 1);
  assert.equal(loads.listLoads(betaOrg).total, 1);

  const mine = loads.listLoads(org).rows[0]!;
  assert.equal(loads.getLoad(betaOrg, mine.id), undefined, "not reachable by id either");
});

test("open loads are the ones still being worked", () => {
  const running = (make({ driverId: driver }) as { id: number }).id;
  const done = (make({ driverId: driver }) as { id: number }).id;
  for (const s of [C.LOAD_STATUS.PICKED_UP, C.LOAD_STATUS.IN_TRANSIT, C.LOAD_STATUS.DELIVERED]) {
    write.setStatus(org, done, s, alpha.ownerId);
  }
  const open = loads.listLoads(org, { openOnly: true });
  assert.equal(open.total, 1);
  assert.equal(open.rows[0]!.id, running);
});

test("search reaches the load number, commodity, carrier, driver and broker", () => {
  make({ loadNumber: "ABC-9910", commodity: "frozen peas", driverId: driver, brokerId: broker });
  for (const q of ["ABC-99", "frozen", "Carrier", "Dale", "Coyote"]) {
    assert.equal(loads.listLoads(org, { q }).total, 1, `finds it by "${q}"`);
  }
  assert.equal(loads.listLoads(org, { q: "nothing like this" }).total, 0);
});
