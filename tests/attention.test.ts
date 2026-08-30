import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DB = path.join(tmpdir(), `carrier-hub-attention-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let attention: typeof import("../src/lib/attention.ts");
let write: typeof import("../src/lib/carrier-write.ts");
let ids: Record<string, number>;
let userId: number;
let org: import("../src/lib/tenant-db.ts").Org;

const daysAgo = (n: number) =>
  new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);
const isoDaysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString();

before(async () => {
  db = await import("../src/lib/db.ts");
  attention = await import("../src/lib/attention.ts");
  write = await import("../src/lib/carrier-write.ts");
  const { Org } = await import("../src/lib/tenant-db.ts");
  const orgId = db.get<{ id: number }>("SELECT id FROM organizations LIMIT 1")!.id;
  org = new Org(orgId);

  const now = new Date().toISOString();
  db.run(
    `INSERT INTO users (organization_id, name, email, password_hash, role, active, created_at, updated_at)
     VALUES (?, 'Queue Owner', 'queue@x.test', 'x', 'admin', 1, ?, ?)`, [orgId, now, now],
  );
  userId = db.get<{ id: number }>("SELECT id FROM users WHERE organization_id = ? AND email='queue@x.test'", [orgId])!.id;

  const look = (k: string, v: string) =>
    db.get<{ id: number }>("SELECT id FROM lookups WHERE organization_id = ? AND kind=? AND value=?", [org.id, k, v])!.id;
  ids = {
    active: look("status", "active"),
    upcoming: look("status", "about_to_be_active"),
    investigation: look("status", "pending_investigation"),
    inactive: look("status", "inactive"),
    signed: look("agreement_status", "signed"),
    notRequired: look("agreement_status", "not_required"),
    pending: look("agreement_status", "pending"),
    notPitched: look("pricing_type", "not_yet_pitched"),
    pctLoad: look("pricing_type", "percentage_per_load"),
    notSet: look("invoice_mode", "not_set"),
    factoring: look("invoice_mode", "factoring"),
  };
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

beforeEach(() => {
  db.run("DELETE FROM carrier_activity WHERE organization_id = ?", [org.id]);
  db.run("DELETE FROM carriers WHERE organization_id = ?", [org.id]);
  db.run("UPDATE app_settings SET value = '14' WHERE organization_id = ? AND key = 'about_to_be_active_days'", [org.id]);
  db.run("UPDATE app_settings SET value = '21' WHERE organization_id = ? AND key = 'missing_first_load_days'", [org.id]);
  db.run("UPDATE app_settings SET value = '7' WHERE organization_id = ? AND key = 'investigation_stale_days'", [org.id]);
  db.run("UPDATE app_settings SET value = '30' WHERE organization_id = ? AND key = 'insurance_expiry_days'", [org.id]);
});

let seq = 0;
function carrier(fields: Record<string, unknown> = {}): number {
  seq++;
  return write.createCarrier(
    org,
    {
      legal_name: `Queue Fixture ${seq}`,
      status_id: ids.active,
      mc_number: String(600000 + seq),
      usdot: String(3600000 + seq),
      agreement_status_id: ids.signed,
      pricing_type_id: ids.pctLoad,
      invoice_mode_id: ids.factoring,
      first_load_date: daysAgo(5),
      onboarding_date: daysAgo(60),
      ...fields,
    },
    userId,
  );
}

const rule = (key: string) => attention.needsAttention(org).find((r) => r.key === key);

test("a clean book of carriers produces an empty queue", () => {
  carrier();
  carrier();
  assert.deepEqual(attention.needsAttention(org), [], "rules with no hits are omitted entirely");
});

test("about-to-be-active fires only past the configured threshold", () => {
  const stale = carrier({ status_id: ids.upcoming });
  db.run("UPDATE carriers SET status_changed_at = ? WHERE organization_id = ? AND id = ?", [isoDaysAgo(30), org.id, stale]);
  const recent = carrier({ status_id: ids.upcoming });
  db.run("UPDATE carriers SET status_changed_at = ? WHERE organization_id = ? AND id = ?", [isoDaysAgo(3), org.id, recent]);

  assert.equal(rule("stale_upcoming")!.count, 1, "only the stale one");
  assert.equal(rule("stale_upcoming")!.items[0]!.id, stale);
});

test("raising the threshold in Settings removes items from the queue", () => {
  const c = carrier({ status_id: ids.upcoming });
  db.run("UPDATE carriers SET status_changed_at = ? WHERE organization_id = ? AND id = ?", [isoDaysAgo(20), org.id, c]);
  assert.equal(rule("stale_upcoming")!.count, 1);

  db.run("UPDATE app_settings SET value = '45' WHERE organization_id = ? AND key = 'about_to_be_active_days'", [org.id]);
  assert.equal(rule("stale_upcoming"), undefined, "no longer overdue at a 45-day threshold");

  db.run("UPDATE app_settings SET value = '10' WHERE organization_id = ? AND key = 'about_to_be_active_days'", [org.id]);
  assert.equal(rule("stale_upcoming")!.count, 1, "overdue again at 10 days");
});

test("an invalid threshold falls back to the default instead of breaking", () => {
  const c = carrier({ status_id: ids.upcoming });
  db.run("UPDATE carriers SET status_changed_at = ? WHERE organization_id = ? AND id = ?", [isoDaysAgo(20), org.id, c]);
  db.run("UPDATE app_settings SET value = 'not a number' WHERE organization_id = ? AND key = 'about_to_be_active_days'", [org.id]);
  assert.equal(rule("stale_upcoming")!.count, 1, "default of 14 days still applies");
});

test("unsigned agreements cover live carriers only, and exempt Not Required", () => {
  const unsigned = carrier({ agreement_status_id: ids.pending });
  const missing = carrier({ agreement_status_id: null });
  carrier({ agreement_status_id: ids.signed });
  carrier({ agreement_status_id: ids.notRequired });
  carrier({ agreement_status_id: ids.pending, status_id: ids.inactive });

  const found = rule("agreement_unsigned")!;
  assert.equal(found.count, 2);
  assert.deepEqual(found.items.map((i) => i.id).sort(), [unsigned, missing].sort());
});

test("missing first load applies to active carriers past the threshold", () => {
  const overdue = carrier({ first_load_date: null, onboarding_date: daysAgo(60) });
  carrier({ first_load_date: null, onboarding_date: daysAgo(3) });
  carrier({ first_load_date: null, onboarding_date: daysAgo(60), status_id: ids.upcoming });
  carrier({ first_load_date: daysAgo(1), onboarding_date: daysAgo(60) });

  const found = rule("missing_first_load")!;
  assert.equal(found.count, 1);
  assert.equal(found.items[0]!.id, overdue);
});

test("missing identifiers distinguishes MC, USDOT and both", () => {
  carrier({ mc_number: null });
  carrier({ usdot: null });
  carrier({ mc_number: null, usdot: null });
  carrier();

  const found = rule("missing_identifiers")!;
  assert.equal(found.count, 3);
  assert.deepEqual(
    found.items.map((i) => i.detail).sort(),
    ["Both missing", "MC missing", "USDOT missing"],
  );
});

test("plan not pitched and missing billing each catch their own case", () => {
  carrier({ pricing_type_id: ids.notPitched });
  carrier({ invoice_mode_id: ids.notSet });
  carrier({ invoice_mode_id: null });

  assert.equal(rule("not_pitched")!.count, 1);
  assert.equal(rule("missing_billing")!.count, 2, "Not Set and null both count");
});

test("import-flagged records surface for review", () => {
  const flagged = carrier({ review_flags: JSON.stringify(["Unknown trailer type: Flatbd"]) });
  carrier();
  const found = rule("flagged_import")!;
  assert.equal(found.count, 1);
  assert.equal(found.items[0]!.id, flagged);
});

test("stale investigations respect their own threshold", () => {
  const stale = carrier({ status_id: ids.investigation });
  db.run("UPDATE carriers SET status_changed_at = ? WHERE organization_id = ? AND id = ?", [isoDaysAgo(14), org.id, stale]);
  const fresh = carrier({ status_id: ids.investigation });
  db.run("UPDATE carriers SET status_changed_at = ? WHERE organization_id = ? AND id = ?", [isoDaysAgo(2), org.id, fresh]);

  assert.equal(rule("stale_investigation")!.count, 1);
  assert.equal(rule("stale_investigation")!.items[0]!.id, stale);
});

test("the queue is ordered by size and samples at most five per rule", () => {
  for (let i = 0; i < 8; i++) carrier({ mc_number: null });
  carrier({ pricing_type_id: ids.notPitched });

  const rules = attention.needsAttention(org);
  assert.ok(rules[0]!.count >= rules[rules.length - 1]!.count, "largest rule first");

  const identifiers = rules.find((r) => r.key === "missing_identifiers")!;
  assert.equal(identifiers.count, 8, "the count is the full total");
  assert.equal(identifiers.items.length, 5, "only five are listed");
  assert.equal(attention.attentionTotal(rules), rules.reduce((n, r) => n + r.count, 0));
});

// ── insurance ────────────────────────────────────────────────────────────────
//
// Split into lapsed and lapsing on purpose: they ask for different things. A lapsed
// certificate means stop giving that carrier loads today; a lapsing one means chase the
// broker this week. The boundary cases are what these pin down, because "expires today"
// belongs in exactly one of them.

const daysAhead = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

test("expired insurance is separated from insurance about to expire", () => {
  const lapsed = carrier({ insurance_expires_on: daysAgo(1) });
  const soon = carrier({ insurance_expires_on: daysAhead(10) });
  carrier({ insurance_expires_on: daysAhead(200) });   // comfortably valid
  carrier({ insurance_expires_on: null });             // not recorded — deliberately silent

  assert.equal(rule("insurance_expired")!.count, 1);
  assert.equal(rule("insurance_expired")!.items[0]!.id, lapsed);
  assert.equal(rule("insurance_expiring")!.count, 1);
  assert.equal(rule("insurance_expiring")!.items[0]!.id, soon);
});

test("a certificate expiring today is expiring, not yet expired", () => {
  const today = carrier({ insurance_expires_on: daysAhead(0) });

  assert.equal(rule("insurance_expired"), undefined, "cover today is still cover");
  assert.equal(rule("insurance_expiring")!.items[0]!.id, today);
});

test("the warning window comes from Settings", () => {
  carrier({ insurance_expires_on: daysAhead(45) });
  assert.equal(rule("insurance_expiring"), undefined, "outside the default 30 days");

  db.run("UPDATE app_settings SET value = '60' WHERE organization_id = ? AND key = 'insurance_expiry_days'", [org.id]);
  assert.equal(rule("insurance_expiring")!.count, 1, "inside a 60-day window");
});

test("insurance is only chased for carriers still working", () => {
  carrier({ insurance_expires_on: daysAgo(30), status_id: ids.inactive });
  carrier({ insurance_expires_on: daysAgo(30), status_id: ids.investigation });
  assert.equal(rule("insurance_expired"), undefined, "an offboarded carrier's lapsed cover is not work");

  const live = carrier({ insurance_expires_on: daysAgo(30), status_id: ids.upcoming });
  assert.equal(rule("insurance_expired")!.items[0]!.id, live, "onboarding carriers count as live");
});

test("the queue names the insurer, so the alert can be acted on", () => {
  carrier({ insurance_expires_on: daysAgo(2), insurance_provider: "Progressive" });
  assert.match(rule("insurance_expired")!.items[0]!.detail!, /Expired .* · Progressive/);

  db.run("DELETE FROM carriers WHERE organization_id = ?", [org.id]);
  carrier({ insurance_expires_on: daysAgo(2) });
  assert.match(rule("insurance_expired")!.items[0]!.detail!, /^Expired \d{4}-\d{2}-\d{2}$/,
    "and reads cleanly when no insurer is on file");
});
