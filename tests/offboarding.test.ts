import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DB = path.join(tmpdir(), `carrier-hub-offboard-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let write: typeof import("../src/lib/carrier-write.ts");
let off: typeof import("../src/lib/offboard-write.ts");
let carriers: typeof import("../src/lib/carriers.ts");
let offboarding: typeof import("../src/lib/offboarding.ts");
let ids: Record<string, number>;
let userId: number;
let org: import("../src/lib/tenant-db.ts").Org;

before(async () => {
  db = await import("../src/lib/db.ts");
  write = await import("../src/lib/carrier-write.ts");
  off = await import("../src/lib/offboard-write.ts");
  carriers = await import("../src/lib/carriers.ts");
  offboarding = await import("../src/lib/offboarding.ts");

  const now = new Date().toISOString();
  const { Org } = await import("../src/lib/tenant-db.ts");
  const orgId = db.get<{ id: number }>("SELECT id FROM organizations LIMIT 1")!.id;
  org = new Org(orgId);
  db.run(
    `INSERT INTO users (organization_id, name, email, password_hash, role, active, created_at, updated_at)
     VALUES (?, 'Exit Handler', 'exit@x.test', 'x', 'admin', 1, ?, ?)`, [orgId, now, now],
  );
  userId = db.get<{ id: number }>("SELECT id FROM users WHERE organization_id = ? AND email='exit@x.test'", [orgId])!.id;

  const look = (k: string, v: string) =>
    db.get<{ id: number }>("SELECT id FROM lookups WHERE organization_id = ? AND kind=? AND value=?", [orgId, k, v])!.id;
  ids = {
    active: look("status", "active"),
    upcoming: look("status", "about_to_be_active"),
    inactive: look("status", "inactive"),
    suspended: look("status", "suspended"),
    blacklisted: look("status", "blacklisted"),
    backoff: look("status", "carrier_back_off"),
    investigation: look("status", "pending_investigation"),
    reasonRates: look("offboard_reason", "rates_too_low"),
    reasonFraud: look("offboard_reason", "fraud_suspected"),
    catVoluntary: look("offboard_category", "voluntary"),
    finalGood: look("final_status", "closed_good_standing"),
    subCancelled: look("subscription", "cancelled"),
    subActive: look("subscription", "active"),
  };
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

let seq = 0;
const makeActive = () =>
  write.createCarrier(
    org,
    {
      legal_name: `Exit Fixture ${++seq}`,
      status_id: ids.active,
      mc_number: String(700000 + seq),
      subscription_id: ids.subActive,
    },
    userId,
  );

const baseInput = (carrierId: number, statusId: number) => ({
  carrierId,
  statusId,
  offboardedOn: "2026-05-01",
  reasonId: ids.reasonRates,
  categoryId: ids.catVoluntary,
  finalStatusId: ids.finalGood,
  handledBy: userId,
  lastLoadDate: "2026-04-20",
  outstandingBalance: 1250.5,
  subscriptionCancelled: true,
  agreementClosed: true,
  canReturn: true,
  notes: "Balance settled by ACH.",
});

test("all four exit statuses open the offboarding workflow, others do not", () => {
  for (const key of ["inactive", "suspended", "blacklisted", "backoff"]) {
    assert.equal(off.isExitStatus(org, ids[key]), true, key);
  }
  for (const key of ["active", "upcoming", "investigation"]) {
    assert.equal(off.isExitStatus(org, ids[key]), false, key);
  }
  assert.equal(off.isExitStatus(org, null), false);
});

test("offboarding retains the carrier and records every captured field", () => {
  const id = makeActive();
  off.offboardCarrier(org, baseInput(id, ids.inactive), userId);

  const carrier = carriers.getCarrier(org, id);
  assert.ok(carrier, "the carrier still exists — offboarding never deletes");
  assert.equal(carrier!.status_id, ids.inactive);

  const rec = offboarding.getOffboarding(org, id)!;
  assert.equal(rec.offboarded_on, "2026-05-01");
  assert.equal(rec.reason_id, ids.reasonRates);
  assert.equal(rec.category_id, ids.catVoluntary);
  assert.equal(rec.final_status_id, ids.finalGood);
  assert.equal(rec.handler_name, "Exit Handler");
  assert.equal(rec.last_load_date, "2026-04-20");
  assert.equal(rec.outstanding_balance, 1250.5);
  assert.equal(rec.subscription_cancelled, 1);
  assert.equal(rec.agreement_closed, 1);
  assert.equal(rec.can_return, 1);
  assert.equal(rec.notes, "Balance settled by ACH.");
});

test("offboarding writes both a status entry and an offboarding entry", () => {
  const id = makeActive();
  off.offboardCarrier(org, baseInput(id, ids.suspended), userId);

  const types = db.all<{ type: string }>(
    "SELECT type FROM carrier_activity WHERE organization_id = ? AND carrier_id = ? ORDER BY id", [org.id, id],
  ).map((r) => r.type);
  assert.deepEqual(types, ["created", "status", "offboarding"]);

  const status = db.get<{ old_value: string; new_value: string }>(
    "SELECT old_value, new_value FROM carrier_activity WHERE organization_id = ? AND carrier_id = ? AND type='status'",
    [org.id, id],
  )!;
  assert.equal(status.old_value, "Active");
  assert.equal(status.new_value, "Suspended");
});

test("cancelling the subscription during offboarding updates the carrier field", () => {
  const id = makeActive();
  assert.equal(carriers.getCarrier(org, id)!.subscription_id, ids.subActive);
  off.offboardCarrier(org, baseInput(id, ids.inactive), userId);
  assert.equal(carriers.getCarrier(org, id)!.subscription_id, ids.subCancelled);
});

test("leaving the subscription alone does not touch it", () => {
  const id = makeActive();
  off.offboardCarrier(org,
    { ...baseInput(id, ids.inactive), subscriptionCancelled: false }, userId,
  );
  assert.equal(carriers.getCarrier(org, id)!.subscription_id, ids.subActive);
});

test("re-running the workflow revises the record instead of duplicating it", () => {
  const id = makeActive();
  off.offboardCarrier(org, baseInput(id, ids.inactive), userId);
  off.offboardCarrier(org,
    {
      ...baseInput(id, ids.blacklisted),
      reasonId: ids.reasonFraud,
      canReturn: false,
      notes: "Escalated after review.",
    },
    userId,
  );

  const count = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM offboarding_records WHERE organization_id = ? AND carrier_id = ?", [org.id, id],
  )!.n;
  assert.equal(count, 1, "one record per carrier");

  const rec = offboarding.getOffboarding(org, id)!;
  assert.equal(rec.reason_id, ids.reasonFraud);
  assert.equal(rec.can_return, 0);
  assert.equal(rec.notes, "Escalated after review.");
  assert.equal(carriers.getCarrier(org, id)!.status_id, ids.blacklisted);
});

test("returning from an exit status is logged as a reactivation, keeping the record", () => {
  const id = makeActive();
  off.offboardCarrier(org, baseInput(id, ids.inactive), userId);
  off.changeStatus(org, id, ids.active, userId, "Owner called back");

  const last = db.get<{ type: string; summary: string }>(
    "SELECT type, summary FROM carrier_activity WHERE organization_id = ? AND carrier_id = ? ORDER BY id DESC", [org.id, id],
  )!;
  assert.equal(last.type, "reactivation");
  assert.match(last.summary, /Owner called back/);
  assert.equal(carriers.getCarrier(org, id)!.status_id, ids.active);
  assert.ok(offboarding.getOffboarding(org, id), "offboarding history is kept, not erased");
});

test("an ordinary status change is a plain status entry", () => {
  const id = write.createCarrier(
    org,
    { legal_name: "Plain Move", status_id: ids.upcoming, mc_number: String(800001) },
    userId,
  );
  off.changeStatus(org, id, ids.active, userId, null);

  const last = db.get<{ type: string }>(
    "SELECT type FROM carrier_activity WHERE organization_id = ? AND carrier_id = ? ORDER BY id DESC", [org.id, id],
  )!;
  assert.equal(last.type, "status");
});

test("changing to the status already set does nothing", () => {
  const id = makeActive();
  const before_ = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM carrier_activity WHERE organization_id = ? AND carrier_id = ?", [org.id, id],
  )!.n;
  off.changeStatus(org, id, ids.active, userId, null);
  const after_ = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM carrier_activity WHERE organization_id = ? AND carrier_id = ?", [org.id, id],
  )!.n;
  assert.equal(after_, before_);
});

test("offboarded carriers still appear in the offboarded view and in search", () => {
  const id = makeActive();
  const name = carriers.getCarrier(org, id)!.legal_name;
  off.offboardCarrier(org, baseInput(id, ids.backoff), userId);

  const grouped = carriers.listCarriers(org, { group: "offboarded" });
  assert.ok(grouped.rows.some((r) => r.id === id), "listed under Offboarded / Inactive");
  assert.equal(carriers.listCarriers(org, { q: name }).total, 1, "still searchable");

  const active = carriers.listCarriers(org, { group: "active" });
  assert.ok(!active.rows.some((r) => r.id === id), "no longer counted as active");
});

test("offboarding an unknown carrier throws rather than writing", () => {
  assert.throws(() => off.offboardCarrier(org, baseInput(999999, ids.inactive), userId), /not found/i);
  assert.throws(() => off.changeStatus(org, 999999, ids.active, userId, null), /not found/i);
});
