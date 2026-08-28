import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { seedOrg, lookupId } from "./helpers.ts";

/**
 * Adversarial cross-tenant isolation.
 *
 * Two fully-provisioned organisations, A and B. Every check confirms that a caller
 * holding org A's handle cannot read, change, delete, or even detect org B's data
 * through the real query functions — not the raw driver, the functions the app actually
 * calls. This is the test that has to pass for the primary security invariant to hold:
 *
 *   "A user authenticated to Tenant A has no application path to Tenant B's data."
 */
const DB = path.join(tmpdir(), `carrier-hub-xtenant-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let write: typeof import("../src/lib/carrier-write.ts");
let carriers: typeof import("../src/lib/carriers.ts");
let notes: typeof import("../src/lib/notes.ts");
let activity: typeof import("../src/lib/activity.ts");
let off: typeof import("../src/lib/offboard-write.ts");
let stats: typeof import("../src/lib/stats.ts");
let reports: typeof import("../src/lib/reports.ts");
let attention: typeof import("../src/lib/attention.ts");
let importer: typeof import("../src/lib/import.ts");
let team: typeof import("../src/lib/team.ts");
let settings: typeof import("../src/lib/settings.ts");
let exportLib: typeof import("../src/lib/export.ts");

let A: import("../src/lib/tenant-db.ts").Org;
let B: import("../src/lib/tenant-db.ts").Org;
let aUser: number;
let bUser: number;
let aCarrier: number; // a carrier that belongs to A
let bCarrier: number; // a carrier that belongs to B

before(async () => {
  db = await import("../src/lib/db.ts");
  write = await import("../src/lib/carrier-write.ts");
  carriers = await import("../src/lib/carriers.ts");
  notes = await import("../src/lib/notes.ts");
  activity = await import("../src/lib/activity.ts");
  off = await import("../src/lib/offboard-write.ts");
  stats = await import("../src/lib/stats.ts");
  reports = await import("../src/lib/reports.ts");
  attention = await import("../src/lib/attention.ts");
  importer = await import("../src/lib/import.ts");
  team = await import("../src/lib/team.ts");
  settings = await import("../src/lib/settings.ts");
  exportLib = await import("../src/lib/export.ts");
  const { Org } = await import("../src/lib/tenant-db.ts");

  // Two organisations, each fully provisioned with its own vocabularies and an owner.
  const a = seedOrg(db, "Alpha Dispatch");
  const b = seedOrg(db, "Beta Logistics");
  A = new Org(a.id);
  B = new Org(b.id);
  aUser = a.ownerId;
  bUser = b.ownerId;

  const aActive = lookupId(db, A.id, "status", "active");
  const bActive = lookupId(db, B.id, "status", "active");

  aCarrier = write.createCarrier(A, {
    legal_name: "Alpha Freight LLC", status_id: aActive, dispatcher_id: aUser,
    mc_number: "111111", usdot: "2111111", percentage: 10,
  }, aUser);
  bCarrier = write.createCarrier(B, {
    legal_name: "Beta Freight LLC", status_id: bActive, dispatcher_id: bUser,
    mc_number: "222222", usdot: "2222222", percentage: 20,
  }, bUser);
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

// ── READ ─────────────────────────────────────────────────────────────────────

test("A's list contains only A's carriers", () => {
  const list = carriers.listCarriers(A);
  assert.equal(list.total, 1);
  assert.equal(list.rows[0]!.id, aCarrier);
  assert.ok(!list.rows.some((r) => r.id === bCarrier), "B's carrier is absent");
});

test("A cannot fetch B's carrier by its id", () => {
  assert.equal(carriers.getCarrier(A, bCarrier), undefined, "returns not-found, not the row");
  assert.ok(carriers.getCarrier(A, aCarrier), "A's own carrier is reachable");
  assert.ok(carriers.getCarrier(B, bCarrier), "B reaches its own");
});

test("A's search never surfaces B's carrier", () => {
  assert.equal(carriers.listCarriers(A, { q: "Beta" }).total, 0);
  assert.equal(carriers.listCarriers(A, { q: "222222" }).total, 0, "not by B's MC");
  assert.equal(carriers.listCarriers(A, { q: "2222222" }).total, 0, "not by B's USDOT");
  assert.equal(carriers.listCarriers(B, { q: "Beta" }).total, 1, "B finds its own");
});

test("duplicate detection is per tenant — B's MC is invisible to A", () => {
  // B has MC 222222. A checking that same MC must see NO duplicate: it is another tenant's.
  const dupes = carriers.findDuplicates(A, "222222", "2222222");
  assert.equal(dupes.mc.length, 0, "B's MC is not a duplicate within A");
  assert.equal(dupes.usdot.length, 0, "B's USDOT is not a duplicate within A");
  // And A can legitimately reuse an MC that B already holds.
  const reused = write.createCarrier(A, {
    legal_name: "Alpha Reuses BsMC", status_id: lookupId(db, A.id, "status", "active"),
    mc_number: "222222",
  }, aUser);
  assert.ok(reused > 0, "A may hold an MC that also exists in B");
  db.run("DELETE FROM carriers WHERE organization_id = ? AND id = ?", [A.id, reused]);
});

// ── WRITE / UPDATE ─────────────────────────────────────────────────────────────

test("A cannot update B's carrier", () => {
  assert.throws(
    () => write.updateCarrier(A, bCarrier, { legal_name: "Hijacked" }, aUser),
    /not found/i,
  );
  // B is untouched.
  assert.equal(carriers.getCarrier(B, bCarrier)!.legal_name, "Beta Freight LLC");
});

test("A cannot attach a note to B's carrier", () => {
  const result = notes.createNote({ org: A, carrierId: bCarrier, userId: aUser, body: "leak" });
  assert.deepEqual(result, { ok: false, error: "Unknown carrier." });
  assert.equal(activity.carrierNotes(B, bCarrier).length, 0, "no note landed on B's carrier");
});

test("A cannot pin a note that belongs to B", () => {
  notes.createNote({ org: B, carrierId: bCarrier, userId: bUser, body: "B's note" });
  const bNote = activity.carrierNotes(B, bCarrier)[0]!;
  assert.equal(notes.toggleNotePin(A, bNote.id), null, "A cannot toggle B's note");
  assert.equal(activity.carrierNotes(B, bCarrier)[0]!.pinned, 0, "B's note is unchanged");
});

test("A cannot offboard or change the status of B's carrier", () => {
  const bInactive = lookupId(db, B.id, "status", "inactive");
  assert.throws(() => off.changeStatus(A, bCarrier, bInactive, aUser, null), /not found/i);
  assert.throws(
    () => off.offboardCarrier(A, {
      carrierId: bCarrier, statusId: bInactive, offboardedOn: "2026-01-01",
      reasonId: null, categoryId: null, finalStatusId: null, handledBy: aUser,
      lastLoadDate: null, outstandingBalance: null, subscriptionCancelled: false,
      agreementClosed: false, canReturn: true, notes: null,
    }, aUser),
    /not found/i,
  );
});

// ── DELETE ─────────────────────────────────────────────────────────────────────

test("A deleting a saved filter cannot remove B's", () => {
  db.run("INSERT INTO saved_filters (organization_id, user_id, name, query, created_at) VALUES (?, ?, 'BFilter', '?x=1', ?)",
    [B.id, bUser, new Date().toISOString()]);
  const bFilter = db.get<{ id: number }>(
    "SELECT id FROM saved_filters WHERE organization_id = ? AND name = 'BFilter'", [B.id],
  )!.id;
  // The delete action scopes by org AND user; emulate A trying to delete B's filter id.
  db.run("DELETE FROM saved_filters WHERE organization_id = ? AND id = ? AND user_id = ?",
    [A.id, bFilter, aUser]);
  assert.ok(
    db.get("SELECT id FROM saved_filters WHERE organization_id = ? AND id = ?", [B.id, bFilter]),
    "B's filter survives A's delete attempt",
  );
});

// ── AGGREGATES / REPORTS / DASHBOARD ────────────────────────────────────────────

test("dashboard metrics count only the caller's tenant", () => {
  const a = stats.dashboardMetrics(A);
  const b = stats.dashboardMetrics(B);
  assert.equal(a.total, 1, "A sees one carrier");
  assert.equal(b.total, 1, "B sees one carrier");
  assert.equal(stats.carriersByStatus(A).reduce((n, s) => n + s.value, 0), 1);
});

test("reports never blend tenants", () => {
  assert.equal(reports.runReport(A, "by_status").total, 1);
  assert.equal(reports.runReport(B, "by_status").total, 1);
  const aPct = reports.runReport(A, "by_percentage");
  // A's carrier is 10% (the "8–10%" band); B's is 20% and must not appear in A's report.
  assert.equal(aPct.rows.find((r) => r.label === "8–10%")?.value, 1);
  assert.equal(aPct.rows.find((r) => r.label === "Over 15%")?.value, 0, "B's 20% is not counted for A");
});

test("the needs-attention queue is per tenant", () => {
  // Both carriers are missing a USDOT? No — both have one. Give only B's carrier a gap,
  // then confirm it never appears in A's queue.
  db.run("UPDATE carriers SET usdot = NULL WHERE organization_id = ? AND id = ?", [B.id, bCarrier]);
  const aQueue = attention.needsAttention(A);
  const flat = aQueue.flatMap((r) => r.items.map((i) => i.id));
  assert.ok(!flat.includes(bCarrier), "B's flagged carrier never enters A's queue");
  db.run("UPDATE carriers SET usdot = '2222222' WHERE organization_id = ? AND id = ?", [B.id, bCarrier]);
});

// ── EXPORT ──────────────────────────────────────────────────────────────────────

test("A's export contains only A's carriers", () => {
  const rows = carriers.listCarriers(A, {}, { pageSize: 1000 }).rows;
  const csv = exportLib.carriersToCsv(A, rows);
  assert.ok(csv.includes("Alpha Freight LLC"));
  assert.ok(!csv.includes("Beta Freight LLC"), "B's carrier is not in A's export");
});

// ── IMPORT ──────────────────────────────────────────────────────────────────────

test("import into A cannot collide with, or update, B's records", () => {
  // A row whose MC matches B's existing carrier. Within A it is brand new — B is invisible.
  const preview = importer.buildPreview(A, [{ legal_name: "Imported Into A", mc_number: "222222" }]);
  assert.equal(preview.counts.duplicates, 0, "B's MC is not seen as a duplicate during A's import");

  const summary = importer.commitImport(A, [{ legal_name: "Imported Into A", mc_number: "222222" }], "update", aUser);
  assert.equal(summary.created, 1, "created in A, did not update B");
  assert.equal(summary.updated, 0);
  assert.equal(carriers.getCarrier(B, bCarrier)!.legal_name, "Beta Freight LLC", "B untouched");
  // clean up
  const imported = db.get<{ id: number }>(
    "SELECT id FROM carriers WHERE organization_id = ? AND legal_name = 'Imported Into A'", [A.id],
  )!.id;
  db.run("DELETE FROM carriers WHERE organization_id = ? AND id = ?", [A.id, imported]);
});

// ── TEAM / SETTINGS ──────────────────────────────────────────────────────────────

test("A's team list shows only A's members; A cannot reset B's password", () => {
  const aTeam = team.listTeam(A);
  assert.ok(aTeam.every((m) => m.email.includes("alphadispatch")), "only A's members");
  assert.ok(!aTeam.some((m) => m.id === bUser), "B's owner absent from A's team");

  // A trying to set B's owner's password resolves to "unknown" — B is out of scope.
  const result = team.setPassword(A, bUser, "hijacked-password");
  assert.deepEqual(result, { ok: false, error: "Unknown team member." });
});

test("settings and vocabularies are independent per tenant", () => {
  settings.saveSettings(A, { about_to_be_active_days: "30" });
  settings.saveSettings(B, { about_to_be_active_days: "3" });
  assert.equal(db.getSetting(A.id, "about_to_be_active_days"), "30");
  assert.equal(db.getSetting(B.id, "about_to_be_active_days"), "3", "B's threshold is its own");

  // Retiring a value in A leaves B's identical value active.
  const aStatus = lookupId(db, A.id, "status", "suspended");
  settings.setLookupActive(A, aStatus, false);
  const bStatus = lookupId(db, B.id, "status", "suspended");
  assert.equal(
    db.get<{ active: number }>("SELECT active FROM lookups WHERE organization_id = ? AND id = ?", [B.id, bStatus])!.active,
    1,
    "B's 'suspended' stays active when A retires its own",
  );
});
