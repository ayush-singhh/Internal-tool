/**
 * Carrier applications — the staging table between a public form and `carriers`.
 *
 * Three rules are worth pinning here, because getting any of them wrong is silent:
 *   1. Portal input never becomes a carrier on its own. Conversion is a staff act.
 *   2. A USDOT number is public. Resuming an application must prove the *phone*, or
 *      knowing a competitor's DOT number is enough to read their onboarding.
 *   3. A converted application is history. It stops accepting edits, like a won lead.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { seedOrg, type TestOrg } from "./helpers.ts";

const DB = path.join(tmpdir(), `carrier-hub-applications-lifecycle-${process.pid}.db`);
for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let apps: typeof import("../src/lib/applications.ts");
let STATUS: typeof import("../src/lib/constants.ts")["STATUS"];
let alpha: TestOrg;
let beta: TestOrg;
let org: import("../src/lib/tenant-db.ts").Org;
let betaOrg: import("../src/lib/tenant-db.ts").Org;

const PHONE = { phone: "(555) 123-4567", phone_digits: "5551234567" };

const input = (over: Record<string, unknown> = {}) => ({
  usdot: "1234567",
  legal_name: "ACME TRUCKING LLC",
  dba_name: "ACME EXPRESS",
  operating_state: "TX",
  allowed_to_operate: true,
  name_source: "fmcsa" as const,
  ...PHONE,
  email: "dispatch@acme.test",
  ...over,
});

before(async () => {
  db = await import("../src/lib/db.ts");
  apps = await import("../src/lib/applications.ts");
  ({ STATUS } = await import("../src/lib/constants.ts"));
  const { Org } = await import("../src/lib/tenant-db.ts");
  alpha = seedOrg(db, "Alpha Portal");
  beta = seedOrg(db, "Beta Portal");
  org = new Org(alpha.id);
  betaOrg = new Org(beta.id);
});

beforeEach(() => {
  db.systemQuery(() => {
    db.run("DELETE FROM applicant_sessions", []);
    db.run("DELETE FROM carrier_applications", []);
    db.run("DELETE FROM carrier_activity", []);
    db.run("DELETE FROM carriers", []);
  });
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

const openOne = (over: Record<string, unknown> = {}) => {
  const result = apps.openApplication(org, input(over));
  assert.ok(result.ok, "application opened");
  return result.id;
};

test("an application opens as a draft carrying what the carrier gave", () => {
  const id = openOne();
  const row = apps.getApplication(org, id)!;
  assert.equal(row.status, "draft");
  assert.equal(row.step, "account");
  assert.equal(row.legal_name, "ACME TRUCKING LLC");
  assert.equal(row.usdot, "1234567");
  assert.equal(row.name_source, "fmcsa");
  assert.equal(row.allowed_to_operate, 1);
  assert.equal(row.converted_carrier_id, null);
});

test("the same carrier returning to the same number resumes, it does not duplicate", () => {
  const first = openOne();
  const again = apps.openApplication(org, input());
  assert.ok(again.ok);
  assert.equal(again.id, first, "resumed the draft rather than starting a second");
  assert.equal(apps.listApplications(org).length, 1);
});

test("a USDOT already being onboarded from another number is refused", () => {
  openOne();
  // USDOT numbers are public. If knowing one were enough to resume, a competitor could
  // read somebody else's onboarding — so the phone is what proves it is the same carrier.
  const hijack = apps.openApplication(org, input({ phone: "(555) 999-0000", phone_digits: "5559990000" }));
  assert.equal(hijack.ok, false);
  assert.match((hijack as { error: string }).error, /already in progress/i);
});

test("converting creates a carrier at About to Be Active and nothing invented", () => {
  const id = openOne();
  const result = apps.convertApplication(org, id, alpha.ownerId);
  assert.ok(result.ok);

  const carrier = db.get<Record<string, unknown>>(
    "SELECT * FROM carriers WHERE organization_id = ? AND id = ?", [alpha.id, result.id])!;
  assert.equal(carrier.legal_name, "ACME TRUCKING LLC");
  assert.equal(carrier.usdot, "1234567");
  assert.equal(carrier.phone_digits, "5551234567");
  assert.equal(carrier.email, "dispatch@acme.test");
  const statusValue = db.get<{ value: string }>(
    "SELECT value FROM lookups WHERE organization_id = ? AND id = ?",
    [alpha.id, carrier.status_id])!.value;
  assert.equal(statusValue, STATUS.ABOUT_TO_BE_ACTIVE);
  // Fields the portal never collected stay empty for staff to fill in.
  assert.equal(carrier.dispatcher_id, null);
  assert.equal(carrier.rate, null);
  assert.equal(carrier.plan_id, null);
});

test("conversion is visible on the carrier's own timeline", () => {
  const id = openOne();
  const result = apps.convertApplication(org, id, alpha.ownerId);
  assert.ok(result.ok);
  const entries = db.all<{ summary: string }>(
    "SELECT summary FROM carrier_activity WHERE organization_id = ? AND carrier_id = ?",
    [alpha.id, result.id]);
  assert.ok(
    entries.some((e) => /onboarding portal/i.test(e.summary)),
    `provenance recorded (got: ${entries.map((e) => e.summary).join(" | ")})`,
  );
});

test("an application is converted once, and is read-only afterwards", () => {
  const id = openOne();
  assert.ok(apps.convertApplication(org, id, alpha.ownerId).ok);

  const again = apps.convertApplication(org, id, alpha.ownerId);
  assert.equal(again.ok, false);

  const edit = apps.updateApplication(org, id, { legal_name: "RENAMED LLC" });
  assert.equal(edit.ok, false, "history does not get rewritten");
  assert.equal(apps.getApplication(org, id)!.legal_name, "ACME TRUCKING LLC");
});

test("rejection needs a reason, and closes the application", () => {
  const id = openOne();
  assert.equal(apps.rejectApplication(org, id, alpha.ownerId, "   ").ok, false);

  const done = apps.rejectApplication(org, id, alpha.ownerId, "Authority revoked.");
  assert.ok(done.ok);
  const row = apps.getApplication(org, id)!;
  assert.equal(row.status, "rejected");
  assert.equal(row.rejected_reason, "Authority revoked.");
  assert.equal(apps.convertApplication(org, id, alpha.ownerId).ok, false);
});

test("an existing carrier on the same USDOT is surfaced, not silently merged", () => {
  const id = openOne();
  assert.ok(apps.convertApplication(org, id, alpha.ownerId).ok);
  // A second application for a carrier already on file. Cleanup is a human decision
  // (AI Rules §2), so this reports rather than blocks or merges.
  const dup = apps.duplicateCarrierFor(org, "1234567");
  assert.ok(dup);
  assert.equal(dup.legal_name, "ACME TRUCKING LLC");
  assert.equal(apps.duplicateCarrierFor(org, "7654321"), undefined);
});

test("submitting marks it for review and stamps the time", () => {
  const id = openOne();
  assert.ok(apps.submitApplication(org, id).ok);
  const row = apps.getApplication(org, id)!;
  assert.equal(row.status, "submitted");
  assert.ok(row.submitted_at);
});

test("one organisation cannot see, convert or reject another's application", () => {
  const id = openOne();
  assert.equal(apps.getApplication(betaOrg, id), undefined);
  assert.equal(apps.listApplications(betaOrg).length, 0);
  assert.equal(apps.convertApplication(betaOrg, id, beta.ownerId).ok, false);
  assert.equal(apps.rejectApplication(betaOrg, id, beta.ownerId, "nope").ok, false);
  // And the application is untouched by the attempts.
  assert.equal(apps.getApplication(org, id)!.status, "draft");
});

test("the queue is oldest first, because the oldest is the one going cold", () => {
  const a = openOne({ usdot: "1111111" });
  const b = openOne({ usdot: "2222222", phone_digits: "5552222222", phone: "555-222-2222" });
  db.run("UPDATE carrier_applications SET created_at = ? WHERE organization_id = ? AND id = ?",
    ["2026-01-01T00:00:00.000Z", alpha.id, b]);
  assert.deepEqual(apps.listApplications(org).map((r) => r.id), [b, a]);
});
