import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DB = path.join(tmpdir(), `carrier-hub-import-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let imp: typeof import("../src/lib/import.ts");
let targets: typeof import("../src/lib/import-targets.ts");
let carriers: typeof import("../src/lib/carriers.ts");
let userId: number;
let org: import("../src/lib/tenant-db.ts").Org;

before(async () => {
  db = await import("../src/lib/db.ts");
  imp = await import("../src/lib/import.ts");
  targets = await import("../src/lib/import-targets.ts");
  carriers = await import("../src/lib/carriers.ts");

  const now = new Date().toISOString();
  const { Org } = await import("../src/lib/tenant-db.ts");
  const orgId = db.get<{ id: number }>("SELECT id FROM organizations LIMIT 1")!.id;
  org = new Org(orgId);
  for (const [n, e] of [["Marcus Reed", "mr@x.test"], ["Renee Castille", "rc@x.test"]]) {
    db.run(
      `INSERT INTO users (organization_id, name, email, password_hash, role, active, created_at, updated_at)
       VALUES (?, ?, ?, 'x', 'dispatcher', 1, ?, ?)`, [orgId, n, e, now, now],
    );
  }
  userId = db.get<{ id: number }>("SELECT id FROM users WHERE organization_id = ? AND email='mr@x.test'", [orgId])!.id;
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

beforeEach(() => {
  db.run("DELETE FROM carrier_activity WHERE organization_id = ?", [org.id]);
  db.run("DELETE FROM carriers WHERE organization_id = ?", [org.id]);
});

const flagsOf = (id: number) =>
  JSON.parse(db.get<{ review_flags: string }>(
    "SELECT review_flags FROM carriers WHERE organization_id = ? AND id = ?", [org.id, id],
  )!.review_flags ?? "[]") as string[];

// ── Header mapping ───────────────────────────────────────────────────────────

test("real spreadsheet headers auto-map to the right fields", () => {
  const mapping = targets.suggestMapping([
    "Sr No", "Assigned Dispatcher", "Lead Legal Name", "Owner Name", "Phone Number",
    "Email", "Status", "Account Manager", "MC#", "USDOT", "Trailer Type",
    "No of Trucks", "Plan Offered", "Agreement Status",
  ]);
  assert.equal(mapping[0], "serial");
  assert.equal(mapping[1], "dispatcher");
  assert.equal(mapping[2], "legal_name");
  assert.equal(mapping[3], "owner_name");
  assert.equal(mapping[4], "phone");
  assert.equal(mapping[5], "email");
  assert.equal(mapping[6], "status");
  assert.equal(mapping[7], "account_manager");
  assert.equal(mapping[8], "mc_number");
  assert.equal(mapping[9], "usdot");
  assert.equal(mapping[10], "trailer_type");
  assert.equal(mapping[11], "truck_count");
  assert.equal(mapping[12], "plan");
  assert.equal(mapping[13], "agreement_status");
});

test("no two columns are ever mapped to the same field", () => {
  const mapping = targets.suggestMapping(["Name", "Company Name", "Carrier Name"]);
  const used = Object.values(mapping);
  assert.equal(new Set(used).size, used.length);
});

test("unrecognised headers are left unmapped rather than guessed", () => {
  const mapping = targets.suggestMapping(["Legal Name", "Xyzzy Internal Code"]);
  assert.equal(mapping[0], "legal_name");
  assert.equal(mapping[1], undefined);
});

// ── Date parsing ─────────────────────────────────────────────────────────────

test("spreadsheet date shapes are understood; nonsense is not invented", () => {
  assert.equal(imp.parseLooseDate("2025-03-04"), "2025-03-04");
  assert.equal(imp.parseLooseDate("3/4/2025"), "2025-03-04", "US M/D/Y");
  assert.equal(imp.parseLooseDate("12/31/24"), "2024-12-31", "two-digit year");
  assert.equal(imp.parseLooseDate("1.2.2025"), "2025-01-02");
  assert.equal(imp.parseLooseDate("Mar 4, 2025"), "2025-03-04");
  // Regression: a named date is parsed as local midnight, so converting it through
  // UTC used to move it a day earlier in any timezone east of Greenwich.
  assert.equal(imp.parseLooseDate("January 1, 2025"), "2025-01-01");
  assert.equal(imp.parseLooseDate("31 Dec 2024"), "2024-12-31");
  assert.equal(imp.parseLooseDate(""), null);
  assert.equal(imp.parseLooseDate("sometime last spring"), null);
  assert.equal(imp.parseLooseDate("2/31/2025"), null, "a date that does not exist");
});

// ── Row parsing: preserve, never silently correct ────────────────────────────

test("a clean row imports with no flags", () => {
  const parsed = imp.parseImportRow(org, {
    legal_name: "Ironline Freight LLC", owner_name: "Elena Petrov",
    phone: "(555) 240-1188", email: "ops@ironline.com", mc_number: "874512",
    usdot: "3100447", status: "Active", trailer_type: "Dry Van", truck_count: "12",
    onboarding_date: "3/15/2024",
  });
  assert.deepEqual(parsed.issues, []);
  assert.equal(parsed.input.review_flags, null);
  assert.equal(parsed.input.legal_name, "Ironline Freight LLC");
  assert.equal(parsed.input.onboarding_date, "2024-03-15");
});

test("a misspelled status is preserved and flagged, never guessed into a value", () => {
  const parsed = imp.parseImportRow(org, { legal_name: "Typo Freight", status: "Acitve" });
  assert.equal(parsed.input.status_id, null, "no status is invented");
  const flags = JSON.parse(parsed.input.review_flags as string) as string[];
  assert.equal(flags.length, 1);
  assert.match(flags[0]!, /Acitve/, "the original text is quoted back");
  assert.match(flags[0]!, /did not match a known option/);
});

test("close-enough vocabulary values still match", () => {
  assert.equal(
    imp.parseImportRow(org, { legal_name: "X", status: "  ACTIVE  " }).input.review_flags,
    null, "case and padding are not a mismatch",
  );
  assert.equal(
    imp.parseImportRow(org, { legal_name: "X", trailer_type: "dry van" }).input.review_flags,
    null,
  );
});

test("dispatcher names resolve, including by first name", () => {
  assert.equal(
    imp.parseImportRow(org, { legal_name: "X", dispatcher: "Marcus Reed" }).input.dispatcher_id,
    userId,
  );
  assert.equal(
    imp.parseImportRow(org, { legal_name: "X", dispatcher: "marcus" }).input.dispatcher_id,
    userId,
  );
  const unknown = imp.parseImportRow(org, { legal_name: "X", dispatcher: "Nobody At All" });
  assert.equal(unknown.input.dispatcher_id, null);
  assert.match((unknown.input.review_flags as string), /did not match a team member/);
});

test("a non-numeric MC is not imported, and the original is recorded", () => {
  const parsed = imp.parseImportRow(org, { legal_name: "X", mc_number: "pending", usdot: "n/a" });
  assert.equal(parsed.input.mc_number, null);
  assert.equal(parsed.input.usdot, null);
  const flags = JSON.parse(parsed.input.review_flags as string) as string[];
  assert.ok(flags.some((f) => f.includes("pending")), "original MC text preserved");
  assert.ok(flags.some((f) => f.includes("n/a")), "original USDOT text preserved");
});

test("an odd phone number is kept exactly as written", () => {
  const parsed = imp.parseImportRow(org, { legal_name: "X", phone: "call the yard" });
  assert.equal(parsed.input.phone, "call the yard", "nothing is discarded");
  assert.equal(parsed.input.phone_digits, null);
  assert.match(parsed.input.review_flags as string, /kept as entered/);
});

test("an out-of-range percentage is flagged rather than clamped", () => {
  const parsed = imp.parseImportRow(org, { legal_name: "X", percentage: "150" });
  assert.equal(parsed.input.percentage, null, "not silently changed to 100");
  assert.match(parsed.input.review_flags as string, /150/);
});

test("only a missing legal name blocks a row", () => {
  const bad = imp.parseImportRow(org, { legal_name: "   ", mc_number: "123" });
  assert.equal(bad.issues.filter((i) => i.severity === "error").length, 1);
  const messy = imp.parseImportRow(org, {
    legal_name: "Messy But Importable", status: "???", mc_number: "abc", percentage: "999",
  });
  assert.equal(messy.issues.filter((i) => i.severity === "error").length, 0);
  assert.ok(messy.issues.filter((i) => i.severity === "flag").length >= 3);
});

// ── Preview ──────────────────────────────────────────────────────────────────

test("preview detects duplicates against the database and within the file", () => {
  imp.commitImport(org, [{ legal_name: "Existing Hauling", mc_number: "555001" }], "skip", userId);

  const { preview, counts } = imp.buildPreview(org, [
    { legal_name: "New One", mc_number: "555002" },
    { legal_name: "Clash With Database", mc_number: "555001" },
    { legal_name: "Repeat A", mc_number: "555003" },
    { legal_name: "Repeat B", mc_number: "555003" },
    { legal_name: "" },
  ]);

  assert.equal(counts.total, 5);
  assert.equal(counts.errors, 1, "the nameless row");
  assert.equal(preview[1]!.duplicateOf?.legal_name, "Existing Hauling");
  assert.equal(preview[1]!.duplicateOf?.on, "MC");
  assert.equal(preview[3]!.duplicateInFile, true);
  assert.equal(preview[0]!.duplicateInFile, false);
  assert.equal(preview[4]!.skip, true);
});

test("preview writes nothing to the database", () => {
  const before_ = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM carriers WHERE organization_id = ?", [org.id])!.n;
  imp.buildPreview(org, [{ legal_name: "Never Saved", mc_number: "999111" }]);
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM carriers WHERE organization_id = ?", [org.id])!.n, before_);
});

// ── Commit ───────────────────────────────────────────────────────────────────

test("skip mode leaves the existing carrier completely untouched", () => {
  imp.commitImport(org, 
    [{ legal_name: "Original Name", mc_number: "600001", owner_name: "First Owner", truck_count: "5" }],
    "skip", userId,
  );
  const id = db.get<{ id: number }>("SELECT id FROM carriers WHERE organization_id = ? AND mc_number='600001'", [org.id])!.id;

  const summary = imp.commitImport(org, 
    [{ legal_name: "Changed Name", mc_number: "600001", owner_name: "Second Owner" }],
    "skip", userId,
  );

  assert.deepEqual(summary, { created: 0, updated: 0, skipped: 1, failed: 0, flagged: 0 });
  const row = carriers.getCarrier(org, id)!;
  assert.equal(row.legal_name, "Original Name");
  assert.equal(row.owner_name, "First Owner");
  assert.equal(row.truck_count, 5);
});

test("update mode fills in values but an empty cell never erases data", () => {
  imp.commitImport(org, 
    [{
      legal_name: "Fill Me In", mc_number: "600002", owner_name: "Keep This Owner",
      truck_count: "7", email: "keep@example.com",
    }],
    "create", userId,
  );
  const id = db.get<{ id: number }>("SELECT id FROM carriers WHERE organization_id = ? AND mc_number='600002'", [org.id])!.id;

  const summary = imp.commitImport(org, 
    [{
      legal_name: "Fill Me In", mc_number: "600002",
      owner_name: "", email: "", truck_count: "9", usdot: "3600002",
    }],
    "update", userId,
  );

  assert.equal(summary.updated, 1);
  const row = carriers.getCarrier(org, id)!;
  assert.equal(row.truck_count, 9, "a provided value is applied");
  assert.equal(row.usdot, "3600002", "a newly provided value is added");
  assert.equal(row.owner_name, "Keep This Owner", "an empty cell did not erase the owner");
  assert.equal(row.email, "keep@example.com", "an empty cell did not erase the email");
});

test("create mode deliberately makes a second record", () => {
  imp.commitImport(org, [{ legal_name: "Twin A", mc_number: "600003" }], "create", userId);
  const summary = imp.commitImport(org, [{ legal_name: "Twin B", mc_number: "600003" }], "create", userId);
  assert.equal(summary.created, 1);
  assert.equal(
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM carriers WHERE organization_id = ? AND mc_number='600003'", [org.id])!.n, 2,
  );
});

test("imported carriers get an attributed activity entry", () => {
  imp.commitImport(org, [{ legal_name: "Audited Import", mc_number: "600004" }], "create", userId);
  const id = db.get<{ id: number }>("SELECT id FROM carriers WHERE organization_id = ? AND mc_number='600004'", [org.id])!.id;
  const act = db.get<{ type: string; summary: string; user_id: number }>(
    "SELECT type, summary, user_id FROM carrier_activity WHERE organization_id = ? AND carrier_id = ?", [org.id, id],
  )!;
  assert.equal(act.type, "import");
  assert.equal(act.user_id, userId);
  assert.match(act.summary, /spreadsheet import/);
});

test("flagged rows still import, carrying their flags for review", () => {
  const summary = imp.commitImport(org, 
    [{ legal_name: "Flagged Freight", mc_number: "600005", status: "Actve", percentage: "500" }],
    "create", userId,
  );
  assert.equal(summary.created, 1);
  assert.equal(summary.flagged, 1);

  const id = db.get<{ id: number }>("SELECT id FROM carriers WHERE organization_id = ? AND mc_number='600005'", [org.id])!.id;
  const flags = flagsOf(id);
  assert.equal(flags.length, 2);
  assert.ok(flags.some((f) => f.includes("Actve")));
  assert.ok(carriers.getCarrier(org, id)!.review_flags, "the record is marked for review");
});

test("rows that cannot be imported are counted, not silently dropped", () => {
  const summary = imp.commitImport(org, 
    [
      { legal_name: "Good One", mc_number: "600006" },
      { legal_name: "", mc_number: "600007" },
      { legal_name: "   ", mc_number: "600008" },
    ],
    "create", userId,
  );
  assert.equal(summary.created, 1);
  assert.equal(summary.failed, 2);
});

test("a failing import writes nothing at all", () => {
  imp.commitImport(org, [{ legal_name: "Pre-existing", mc_number: "600009" }], "create", userId);
  const before_ = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM carriers WHERE organization_id = ?", [org.id])!.n;

  assert.throws(() =>
    imp.commitImport(org, 
      [
        { legal_name: "Would Be Created", mc_number: "600010" },
        // A dispatcher id that does not exist trips the foreign key mid-transaction.
        { legal_name: "Breaks It", mc_number: "600011", dispatcher: "Marcus Reed" },
      ],
      "create",
      424242, // this user id does not exist
    ),
  );

  assert.equal(
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM carriers WHERE organization_id = ?", [org.id])!.n, before_,
    "the whole batch rolled back — no half-imported file",
  );
});

test("a full realistic file imports end to end", () => {
  const rows: Record<string, string>[] = [
    { serial: "CH-1001", legal_name: "Sierra Ridge Transport LLC", owner_name: "Bianca Salazar",
      phone: "(214) 555-0184", email: "ops@sierraridge.com", status: "Active",
      dispatcher: "Marcus Reed", account_manager: "Renee Castille", mc_number: "MC-812345",
      usdot: "3 100 998", trailer_type: "Reefer", trailer_size: "53'", truck_count: "9",
      onboarding_date: "6/2/2024", first_load_date: "6/14/2024", lead_source: "Referral",
      plan: "Royal", pricing_type: "Percentage Per Load", percentage: "12%",
      agreement_status: "Signed", subscription: "Active", invoice_mode: "Factoring Company" },
    { serial: "CH-1002", legal_name: "Copper Creek Haulage", status: "About to Be Active",
      dispatcher: "marcus", mc_number: "812346", truck_count: "2",
      onboarding_date: "2026-01-20", pricing_type: "Not Yet Pitched", agreement_status: "Pending" },
  ];

  const { counts } = imp.buildPreview(org, rows);
  assert.equal(counts.errors, 0);
  assert.equal(counts.flagged, 0, "a well-formed file produces no flags");

  const summary = imp.commitImport(org, rows, "skip", userId);
  assert.equal(summary.created, 2);

  const sierra = carriers.getCarrier(
    org,
    db.get<{ id: number }>("SELECT id FROM carriers WHERE organization_id = ? AND mc_number='812345'", [org.id])!.id,
  )!;
  assert.equal(sierra.legal_name, "Sierra Ridge Transport LLC");
  assert.equal(sierra.usdot, "3100998", "spaces stripped from USDOT");
  assert.equal(sierra.percentage, 12, "the % sign is tolerated");
  assert.equal(sierra.onboarding_date, "2024-06-02");
  assert.equal(sierra.dispatcher_name, "Marcus Reed");
  assert.equal(sierra.account_manager_name, "Renee Castille");
  assert.equal(sierra.truck_count, 9);
  assert.equal(carriers.listCarriers(org, { q: "sierra ridge" }).total, 1, "immediately searchable");
});
