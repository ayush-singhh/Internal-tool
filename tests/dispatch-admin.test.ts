/**
 * Drivers and brokers.
 *
 * The rule worth pinning is the broker split: a dispatcher may add one the shipped list is
 * missing, and only an administrator may correct one. That is what stops a misspelling
 * becoming a second permanent broker, and it only works if "add" and "edit" are genuinely
 * different operations rather than the same one behind two buttons.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { seedOrg, lookupId, type TestOrg } from "./helpers.ts";

const DB = path.join(tmpdir(), `carrier-hub-dispadmin-${process.pid}.db`);
for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let admin: typeof import("../src/lib/dispatch-admin.ts");
let write: typeof import("../src/lib/load-write.ts");
let alpha: TestOrg;
let beta: TestOrg;
let org: import("../src/lib/tenant-db.ts").Org;
let carrier: number;
let betaCarrier: number;

const now = () => new Date().toISOString();

before(async () => {
  db = await import("../src/lib/db.ts");
  admin = await import("../src/lib/dispatch-admin.ts");
  write = await import("../src/lib/load-write.ts");
  const { Org } = await import("../src/lib/tenant-db.ts");
  alpha = seedOrg(db, "Alpha Dispatch");
  beta = seedOrg(db, "Beta Dispatch");
  org = new Org(alpha.id);
  for (const o of [alpha, beta]) {
    db.run(
      `INSERT INTO carriers (organization_id, legal_name, status_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [o.id, `Carrier ${o.id}`, lookupId(db, o.id, "status", "active"), now(), now()],
    );
  }
  carrier = db.get<{ id: number }>("SELECT id FROM carriers WHERE organization_id = ?", [alpha.id])!.id;
  betaCarrier = db.get<{ id: number }>("SELECT id FROM carriers WHERE organization_id = ?", [beta.id])!.id;
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

beforeEach(() => {
  db.run("DELETE FROM loads WHERE organization_id = ?", [alpha.id]);
  db.run("DELETE FROM drivers WHERE organization_id = ?", [alpha.id]);
  db.run("DELETE FROM brokers WHERE organization_id = ? AND seeded = 0", [alpha.id]);
});

// ── phone ────────────────────────────────────────────────────────────────────

test("a phone number keeps ten digits and nothing else", () => {
  // The previous form accepted letters, +, & and -. Digits only, capped at ten.
  assert.deepEqual(admin.phoneDigits("+1 (555) 010-9999 ext"), { value: "(155) 501-0999", digits: "1555010999" });
  assert.deepEqual(admin.phoneDigits("555abc0109999"), { value: "(555) 010-9999", digits: "5550109999" });
  assert.deepEqual(admin.phoneDigits("5550109999123456"), { value: "(555) 010-9999", digits: "5550109999" },
    "extra digits are dropped, not stored");
  assert.deepEqual(admin.phoneDigits(""), { value: null, digits: null });
  assert.deepEqual(admin.phoneDigits("abc"), { value: null, digits: null }, "letters alone are no phone number");
});

// ── drivers ──────────────────────────────────────────────────────────────────

test("a driver needs a name, and belongs to a carrier in the same tenant", () => {
  assert.deepEqual(admin.saveDriver(org, { name: "  " }), { ok: false, error: "A driver needs a name." });
  assert.deepEqual(
    admin.saveDriver(org, { name: "Dale", carrierId: betaCarrier }),
    { ok: false, error: "Unknown carrier." },
  );
  assert.equal(admin.saveDriver(org, { name: "Dale", carrierId: carrier, phone: "555-010-9999" }).ok, true);

  const [driver] = admin.listDrivers(org);
  assert.equal(driver!.name, "Dale");
  assert.equal(driver!.phone, "(555) 010-9999");
  assert.equal(driver!.carrier_name, `Carrier ${alpha.id}`);
});

test("a driver on an open load cannot be deactivated out from under it", () => {
  const id = (admin.saveDriver(org, { name: "Dale", carrierId: carrier }) as { id: number }).id;
  write.createLoad(org, {
    carrierId: carrier, driverId: id,
    stops: [{ kind: "pickup", city: "Dallas" }, { kind: "delivery", city: "Newark" }],
  }, alpha.ownerId);

  assert.deepEqual(
    admin.setDriverActive(org, id, false),
    { ok: false, error: "This driver is still on 1 open load." },
  );

  const load = db.get<{ id: number }>("SELECT id FROM loads WHERE organization_id = ?", [alpha.id])!.id;
  for (const s of ["picked_up", "in_transit", "delivered"] as const) {
    write.setStatus(org, load, s, alpha.ownerId);
  }
  assert.equal(admin.setDriverActive(org, id, false).ok, true, "delivered is not open work");
  assert.equal(admin.listDrivers(org)[0]!.active, 0);
});

// ── brokers: the add / edit split ────────────────────────────────────────────

test("the shipped hundred are marked as ours; an added one is not", () => {
  const before = admin.listBrokers(org);
  assert.equal(before.length, 100);
  assert.ok(before.every((b) => b.seeded === 1), "everything shipped is flagged as shipped");

  admin.addBroker(org, "Bob's Freight Co", alpha.ownerId);
  const added = admin.listBrokers(org).find((b) => b.name === "Bob's Freight Co")!;
  assert.equal(added.seeded, 0, "so an administrator can tell it from the shipped list");
});

test("a broker cannot be added twice, whatever the casing", () => {
  assert.deepEqual(
    admin.addBroker(org, "coyote logistics", alpha.ownerId),
    { ok: false, error: "Coyote Logistics is already on the list." },
    "case-insensitive, or the dropdown grows a second Coyote",
  );
  admin.addBroker(org, "Bob's Freight Co", alpha.ownerId);
  assert.equal(admin.addBroker(org, "BOB'S FREIGHT CO", alpha.ownerId).ok, false);
});

test("correcting a broker is an edit, not a second broker", () => {
  const id = (admin.addBroker(org, "Coyot Logisitcs", alpha.ownerId) as { id: number }).id;
  assert.equal(admin.listBrokers(org).length, 101);

  assert.equal(admin.updateBroker(org, id, { name: "Coyote Freight Partners" }).ok, true);
  assert.equal(admin.listBrokers(org).length, 101, "corrected in place — no new row");
  assert.ok(admin.listBrokers(org).some((b) => b.name === "Coyote Freight Partners"));
});

test("an edit cannot collide with an existing broker", () => {
  const id = (admin.addBroker(org, "Bob's Freight Co", alpha.ownerId) as { id: number }).id;
  assert.deepEqual(
    admin.updateBroker(org, id, { name: "coyote logistics" }),
    { ok: false, error: "Another broker already uses that name." },
  );
});

test("retiring a broker keeps it on the loads that used it", () => {
  const id = (admin.addBroker(org, "Bob's Freight Co", alpha.ownerId) as { id: number }).id;
  write.createLoad(org, {
    carrierId: carrier, brokerId: id,
    stops: [{ kind: "pickup", city: "Dallas" }, { kind: "delivery", city: "Newark" }],
  }, alpha.ownerId);

  assert.equal(admin.updateBroker(org, id, { active: false }).ok, true);
  const retired = admin.listBrokers(org).find((b) => b.id === id)!;
  assert.equal(retired.active, 0);
  assert.equal(retired.load_count, 1, "the load still points at it");
});

test("one tenant's drivers and brokers are invisible to the other", async () => {
  const { Org } = await import("../src/lib/tenant-db.ts");
  admin.saveDriver(org, { name: "Alpha Only", carrierId: carrier });
  admin.addBroker(org, "Alpha Only Freight", alpha.ownerId);

  const betaOrg = new Org(beta.id);
  assert.ok(!admin.listDrivers(betaOrg).some((d) => d.name === "Alpha Only"));
  assert.ok(!admin.listBrokers(betaOrg).some((b) => b.name === "Alpha Only Freight"));
  assert.equal(admin.setDriverActive(betaOrg, admin.listDrivers(org)[0]!.id, false).ok, false,
    "and cannot be reached by id either");
});
