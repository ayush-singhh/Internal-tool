import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DB = path.join(tmpdir(), `carrier-hub-write-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let write: typeof import("../src/lib/carrier-write.ts");
let carriers: typeof import("../src/lib/carriers.ts");
let org: import("../src/lib/tenant-db.ts").Org;
let ids: Record<string, number>;
let userA: number;
let userB: number;

before(async () => {
  db = await import("../src/lib/db.ts");
  write = await import("../src/lib/carrier-write.ts");
  carriers = await import("../src/lib/carriers.ts");
  const { Org } = await import("../src/lib/tenant-db.ts");

  const now = new Date().toISOString();
  // The first db touch triggers connect() → seed(), creating the bootstrap organisation
  // with its lookups. Tests run inside that organisation.
  const orgId = db.get<{ id: number }>("SELECT id FROM organizations LIMIT 1")!.id;
  org = new Org(orgId);
  for (const [name, email] of [["Alice Dispatch", "a@x.test"], ["Bob Manager", "b@x.test"]]) {
    db.run(
      `INSERT INTO users (organization_id, name, email, password_hash, role, active, created_at, updated_at)
       VALUES (?, ?, ?, 'x', 'dispatcher', 1, ?, ?)`,
      [orgId, name, email, now, now],
    );
  }
  userA = db.get<{ id: number }>("SELECT id FROM users WHERE organization_id = ? AND email = 'a@x.test'", [orgId])!.id;
  userB = db.get<{ id: number }>("SELECT id FROM users WHERE organization_id = ? AND email = 'b@x.test'", [orgId])!.id;

  const look = (kind: string, value: string) =>
    db.get<{ id: number }>(
      "SELECT id FROM lookups WHERE organization_id = ? AND kind = ? AND value = ?",
      [org.id, kind, value],
    )!.id;
  ids = {
    active: look("status", "active"),
    upcoming: look("status", "about_to_be_active"),
    suspended: look("status", "suspended"),
    royal: look("plan", "royal"),
    imperial: look("plan", "imperial"),
    pctLoad: look("pricing_type", "percentage_per_load"),
    signed: look("agreement_status", "signed"),
    pending: look("agreement_status", "pending"),
    subActive: look("subscription", "active"),
  };
});

after(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB}${suffix}`, { force: true });
});

function makeCarrier(overrides: Record<string, unknown> = {}): number {
  return write.createCarrier(
    org,
    {
      legal_name: "Fixture Freight LLC",
      status_id: ids.upcoming,
      dispatcher_id: userA,
      mc_number: "100001",
      usdot: "2000001",
      percentage: 12,
      plan_id: ids.royal,
      agreement_status_id: ids.pending,
      ...overrides,
    },
    userA,
  );
}

test("creating a carrier records a creation entry naming the status", () => {
  const id = makeCarrier({ mc_number: "111111", usdot: "2111111" });
  const row = carriers.getCarrier(org, id)!;
  assert.equal(row.legal_name, "Fixture Freight LLC");
  assert.equal(row.status_id, ids.upcoming);
  assert.ok(row.created_at && row.updated_at && row.status_changed_at);

  const act = db.all<{ type: string; summary: string; user_id: number }>(
    "SELECT type, summary, user_id FROM carrier_activity WHERE organization_id = ? AND carrier_id = ?", [org.id, id],
  );
  assert.equal(act.length, 1);
  assert.equal(act[0]!.type, "created");
  assert.equal(act[0]!.user_id, userA);
  assert.match(act[0]!.summary, /About to Be Active/);
});

test("a patch never blanks fields it does not mention", () => {
  const id = makeCarrier({ mc_number: "222222", usdot: "2222222", owner_name: "Dana Owner" });
  const before_ = carriers.getCarrier(org, id)!;

  write.updateCarrier(org, id, { status_id: ids.active }, userB);

  const after_ = carriers.getCarrier(org, id)!;
  assert.equal(after_.status_id, ids.active, "the named field changed");
  assert.equal(after_.owner_name, before_.owner_name, "owner survived");
  assert.equal(after_.mc_number, before_.mc_number, "MC survived");
  assert.equal(after_.percentage, before_.percentage, "percentage survived");
  assert.equal(after_.plan_id, before_.plan_id, "plan survived");
  assert.equal(after_.dispatcher_id, before_.dispatcher_id, "dispatcher survived");
});

test("an explicit null clears a field, unlike an absent key", () => {
  const id = makeCarrier({ mc_number: "333333", usdot: "2333333", owner_name: "Clear Me" });
  write.updateCarrier(org, id, { owner_name: null }, userA);
  assert.equal(carriers.getCarrier(org, id)!.owner_name, null);
});

test("a status change is recorded with both old and new labels", () => {
  const id = makeCarrier({ mc_number: "444444", usdot: "2444444" });
  write.updateCarrier(org, id, { status_id: ids.suspended }, userB);

  const act = db.get<{ type: string; summary: string; old_value: string; new_value: string; user_id: number }>(
    "SELECT type, summary, old_value, new_value, user_id FROM carrier_activity WHERE organization_id = ? AND carrier_id = ? ORDER BY id DESC",
    [org.id, id],
  )!;
  assert.equal(act.type, "status");
  assert.equal(act.old_value, "About to Be Active");
  assert.equal(act.new_value, "Suspended");
  assert.equal(act.user_id, userB, "the change is attributed to whoever made it");
  assert.equal(act.summary, "Status changed from About to Be Active to Suspended");
});

test("status_changed_at only moves when the status actually moves", () => {
  const id = makeCarrier({ mc_number: "555555", usdot: "2555555" });
  const original = carriers.getCarrier(org, id)!.status_changed_at;

  write.updateCarrier(org, id, { owner_name: "Someone Else" }, userA);
  assert.equal(
    carriers.getCarrier(org, id)!.status_changed_at, original,
    "unchanged by an unrelated edit",
  );

  write.updateCarrier(org, id, { status_id: ids.active }, userA);
  const afterStatusChange = carriers.getCarrier(org, id)!;
  // Asserting the invariant rather than "the string differs": two writes can land in
  // the same millisecond, which would make a timestamp comparison flaky.
  assert.equal(
    afterStatusChange.status_changed_at, afterStatusChange.updated_at,
    "a status change stamps status_changed_at with the same instant as the edit",
  );
});

test("each kind of change is filed under the right activity type", () => {
  const id = makeCarrier({ mc_number: "666666", usdot: "2666666" });
  db.run("DELETE FROM carrier_activity WHERE organization_id = ? AND carrier_id = ?", [org.id, id]);

  write.updateCarrier(
    org,
    id,
    {
      account_manager_id: userB,
      percentage: 15,
      agreement_status_id: ids.signed,
      subscription_id: ids.subActive,
      trailer_size: "48'",
    },
    userA,
  );

  const byType = new Map(
    db.all<{ type: string; field: string }>(
      "SELECT type, field FROM carrier_activity WHERE organization_id = ? AND carrier_id = ?", [org.id, id],
    ).map((r) => [r.field, r.type]),
  );
  assert.equal(byType.get("Account Manager"), "assignment");
  assert.equal(byType.get("Percentage"), "pricing");
  assert.equal(byType.get("Agreement Status"), "agreement");
  assert.equal(byType.get("Subscription"), "subscription");
  assert.equal(byType.get("Trailer Size"), "field");
});

test("re-saving identical values writes nothing", () => {
  const id = makeCarrier({ mc_number: "777777", usdot: "2777777" });
  const before_ = carriers.getCarrier(org, id)!;
  db.run("DELETE FROM carrier_activity WHERE organization_id = ? AND carrier_id = ?", [org.id, id]);

  const result = write.updateCarrier(
    org,
    id,
    { legal_name: "Fixture Freight LLC", status_id: ids.upcoming, percentage: 12 },
    userA,
  );

  assert.deepEqual(result.changed, []);
  assert.equal(
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM carrier_activity WHERE organization_id = ? AND carrier_id = ?", [org.id, id])!.n,
    0,
    "no phantom history entries",
  );
  assert.equal(carriers.getCarrier(org, id)!.updated_at, before_.updated_at, "updated_at untouched");
});

test("a string from a form equals the number already stored", () => {
  const id = makeCarrier({ mc_number: "888888", usdot: "2888888" });
  const result = write.updateCarrier(org, id, { status_id: String(ids.upcoming) }, userA);
  assert.deepEqual(result.changed, [], "\"3\" and 3 are the same status");
});

test("duplicate MC and USDOT are found regardless of formatting", () => {
  makeCarrier({ mc_number: "999999", usdot: "2999999", legal_name: "Original Hauling LLC" });

  const byMc = carriers.findDuplicates(org, "999999", null);
  assert.equal(byMc.mc.length, 1);
  assert.equal(byMc.mc[0]!.legal_name, "Original Hauling LLC");

  assert.equal(carriers.findDuplicates(org, "MC-999999", null).mc.length, 1, "formatting ignored");
  assert.equal(carriers.findDuplicates(org, null, "2999999").usdot.length, 1);
  assert.equal(carriers.findDuplicates(org, "123123123", null).mc.length, 0);
  assert.equal(carriers.findDuplicates(org, null, null).mc.length, 0);
});

test("a carrier is not flagged as a duplicate of itself when edited", () => {
  const id = makeCarrier({ mc_number: "121212", usdot: "2121212" });
  assert.equal(carriers.findDuplicates(org, "121212", "2121212", id).mc.length, 0);
  assert.equal(carriers.findDuplicates(org, "121212", "2121212", id).usdot.length, 0);
  assert.equal(carriers.findDuplicates(org, "121212", null).mc.length, 1, "still found for others");
});

test("updating an unknown carrier throws rather than writing", () => {
  assert.throws(() => write.updateCarrier(org, 987654, { status_id: ids.active }, userA), /not found/i);
});
