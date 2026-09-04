import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DB = path.join(tmpdir(), `carrier-hub-reports-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let reports: typeof import("../src/lib/reports.ts");
let write: typeof import("../src/lib/carrier-write.ts");
let off: typeof import("../src/lib/offboard-write.ts");
let csv: typeof import("../src/lib/csv.ts");
let ids: Record<string, number>;
let alice: number;
let bob: number;
let org: import("../src/lib/tenant-db.ts").Org;

before(async () => {
  db = await import("../src/lib/db.ts");
  reports = await import("../src/lib/reports.ts");
  write = await import("../src/lib/carrier-write.ts");
  off = await import("../src/lib/offboard-write.ts");
  csv = await import("../src/lib/csv.ts");

  const now = new Date().toISOString();
  const { Org } = await import("../src/lib/tenant-db.ts");
  const orgId = db.get<{ id: number }>("SELECT id FROM organizations LIMIT 1")!.id;
  org = new Org(orgId);
  for (const [n, e] of [["Alice", "ra@x.test"], ["Bob", "rb@x.test"]]) {
    db.run(
      `INSERT INTO users (organization_id, name, email, password_hash, role, active, created_at, updated_at)
       VALUES (?, ?, ?, 'x', 'dispatcher', 1, ?, ?)`, [orgId, n, e, now, now],
    );
  }
  alice = db.get<{ id: number }>("SELECT id FROM users WHERE organization_id = ? AND email='ra@x.test'", [orgId])!.id;
  bob = db.get<{ id: number }>("SELECT id FROM users WHERE organization_id = ? AND email='rb@x.test'", [orgId])!.id;

  const look = (k: string, v: string) =>
    db.get<{ id: number }>("SELECT id FROM lookups WHERE organization_id = ? AND kind=? AND value=?", [org.id, k, v])!.id;
  ids = {
    active: look("status", "active"),
    inactive: look("status", "inactive"),
    royal: look("plan", "royal"),
    imperial: look("plan", "imperial"),
    referral: look("lead_source", "referral"),
    coldCall: look("lead_source", "cold_call"),
    reason: look("offboard_reason", "rates_too_low"),
  };

  let n = 0;
  const make = (fields: Record<string, unknown>) =>
    write.createCarrier(
      org,
      {
        legal_name: `Report Fixture ${++n}`,
        mc_number: String(500000 + n),
        status_id: ids.active,
        ...fields,
      },
      alice,
    );

  // 3 active for Alice, 2 active for Bob, 1 inactive for Alice.
  make({ dispatcher_id: alice, onboarding_date: "2025-01-10", plan_id: ids.royal, lead_source_id: ids.referral, truck_count: 1, percentage: 9 });
  make({ dispatcher_id: alice, onboarding_date: "2025-06-15", plan_id: ids.royal, lead_source_id: ids.referral, truck_count: 4, percentage: 11 });
  make({ dispatcher_id: alice, onboarding_date: "2026-02-20", plan_id: ids.imperial, lead_source_id: ids.coldCall, truck_count: 30, percentage: 14 });
  make({ dispatcher_id: bob, onboarding_date: "2025-03-05", plan_id: ids.royal, lead_source_id: ids.coldCall, truck_count: 8, percentage: 16 });
  make({ dispatcher_id: bob, onboarding_date: "2026-01-11", plan_id: ids.imperial, lead_source_id: ids.referral, truck_count: 60 });
  const leaver = make({ dispatcher_id: alice, onboarding_date: "2025-02-02", plan_id: ids.royal, lead_source_id: ids.referral, truck_count: 2 });
  off.offboardCarrier(org,
    {
      carrierId: leaver, statusId: ids.inactive, offboardedOn: "2026-03-15",
      reasonId: ids.reason, categoryId: null, finalStatusId: null, handledBy: alice,
      lastLoadDate: null, outstandingBalance: null, subscriptionCancelled: false,
      agreementClosed: false, canReturn: true, notes: null,
    },
    alice,
  );
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

const rowsOf = (key: Parameters<typeof reports.runReport>[1], range = {}) =>
  new Map(reports.runReport(org, key, range).rows.map((r) => [r.label, r.value]));

test("every report is defined once and each one runs", () => {
  assert.equal(reports.REPORTS.length, 21);
  assert.equal(new Set(reports.REPORTS.map((r) => r.key)).size, reports.REPORTS.length);
  for (const def of reports.REPORTS) {
    const result = reports.runReport(org, def.key);
    assert.equal(result.def.key, def.key);
    assert.ok(Array.isArray(result.rows), `${def.key} returns rows`);
    // A report with no `unit` prints a column of numbers under a blank heading; a report
    // with no `action` is one nothing gates, which is how this page came to have no gate.
    assert.ok(def.unit.length > 0, `${def.key} names its unit`);
    assert.ok(def.action.length > 0, `${def.key} names its permission`);
  }
});

/**
 * The page took `org` from the session and never asked `can()`, so every figure in it was
 * one typed URL away from any signed-in person — sales included, whose whole definition is
 * that they see no carrier. These cases pin the gate that replaced that.
 */
test("each role sees only the reports its permissions allow", () => {
  const asRole = (role: string) => ({
    id: 1, organization_id: org.id, name: "T", email: "t@x.test", role: role as never, active: 1,
  });
  const groups = (role: string) =>
    new Set(reports.visibleReports(asRole(role)).map((r) => r.group));

  // Sales holds none of carrier:view, load:view or invoice:view — so no report at all,
  // and the page redirects them rather than rendering an empty rail.
  assert.equal(reports.visibleReports(asRole("sales")).length, 0);

  // A dispatcher reads the book, the board and the invoices, but not the ledger across
  // them: receivables ageing is `invoice:manage`, the same gate as /billing.
  const dispatcher = groups("dispatcher");
  assert.ok(dispatcher.has("Dispatch") && dispatcher.has("Money") && dispatcher.has("Portfolio"));
  assert.equal(reports.mayRunReport(asRole("dispatcher"), "receivables_ageing"), false);
  assert.equal(reports.mayRunReport(asRole("dispatcher"), "fee_by_carrier"), true);

  // An administrator holds everything, so nothing is filtered out.
  assert.equal(reports.visibleReports(asRole("admin")).length, reports.REPORTS.length);
  // Platform support is not a role inside an organisation and gets nothing here.
  assert.equal(reports.visibleReports(asRole("support")).length, 0);
});

test("an unknown report key falls back instead of throwing", () => {
  assert.equal(reports.parseReportKey("../../etc/passwd"), "active_by_dispatcher");
  assert.equal(reports.parseReportKey(undefined), "active_by_dispatcher");
  assert.equal(reports.parseReportKey("by_status"), "by_status");
});

test("active-by-dispatcher counts only active carriers", () => {
  const rows = rowsOf("active_by_dispatcher");
  assert.equal(rows.get("Alice"), 3, "the offboarded one is excluded");
  assert.equal(rows.get("Bob"), 2);
});

test("breakdowns total to the number of carriers they cover", () => {
  const status = reports.runReport(org, "by_status");
  assert.equal(status.total, 6, "all six carriers");
  const byPlan = reports.runReport(org, "by_plan");
  assert.equal(byPlan.total, 6);
});

test("a date range narrows a breakdown", () => {
  const all = rowsOf("by_lead_source");
  assert.equal(all.get("Referral"), 4);

  const only2025 = rowsOf("by_lead_source", { from: "2025-01-01", to: "2025-12-31" });
  assert.equal(only2025.get("Referral"), 3, "the 2026 referral is excluded");
  assert.equal(only2025.get("Cold Call"), 1);

  const narrow = reports.runReport(org, "by_lead_source", { from: "2026-01-01" });
  assert.equal(narrow.total, 2);
});

test("an empty range yields an empty report rather than an error", () => {
  const result = reports.runReport(org, "by_plan", { from: "2030-01-01", to: "2030-12-31" });
  assert.deepEqual(result.rows, []);
  assert.equal(result.total, 0);
});

test("fleet size groups into bands and accounts for every carrier", () => {
  const rows = rowsOf("by_fleet_size");
  assert.equal(rows.get("1 truck"), 1);
  assert.equal(rows.get("2–5"), 2);
  assert.equal(rows.get("6–10"), 1);
  assert.equal(rows.get("26–50"), 1);
  assert.equal(rows.get("51+"), 1);
  assert.equal(reports.runReport(org, "by_fleet_size").total, 6);
});

test("percentage bands cover only carriers with a percentage", () => {
  const rows = rowsOf("by_percentage");
  assert.equal(rows.get("Under 8%"), 0);
  assert.equal(rows.get("8–10%"), 1);
  assert.equal(rows.get("10–12%"), 1);
  assert.equal(rows.get("12–15%"), 1);
  assert.equal(rows.get("Over 15%"), 1);
  assert.equal(reports.runReport(org, "by_percentage").total, 4, "the carrier with no rate is excluded");
});

test("monthly trends return a continuous series with no gaps", () => {
  const result = reports.runReport(org, "monthly_onboarding");
  assert.ok(result.trend, "trend reports carry a series");
  const months = result.trend!.map((p) => p.month);
  assert.deepEqual([...months].sort(), months, "months are in order");
  for (let i = 1; i < months.length; i++) {
    assert.notEqual(months[i], months[i - 1], "no duplicate months");
  }
  assert.ok(result.trend!.every((p) => Number.isInteger(p.value)), "zero-filled, never undefined");
});

test("offboarding reasons respect the offboarding date, not the onboarding date", () => {
  assert.equal(rowsOf("offboarding_reasons").get("Rates Too Low"), 1);
  assert.equal(
    reports.runReport(org, "offboarding_reasons", { from: "2026-03-01", to: "2026-03-31" }).total, 1,
  );
  assert.equal(
    reports.runReport(org, "offboarding_reasons", { from: "2025-01-01", to: "2025-12-31" }).total, 0,
    "filtered on when they left, not when they joined",
  );
});

/**
 * The dated and undated paths used to be two copies of one query, and the dated copy
 * decided how many placeholders to write with `from ? ... : null` while deciding how many
 * parameters to bind with `!== null` — so an empty-string bound produced a surplus
 * parameter and threw "column index out of range". They are one function now, with each
 * bound owning its clause and its parameter together.
 */
test("a blank date bound is simply no bound", () => {
  const all = reports.runReport(org, "offboarding_reasons", {}).total;
  for (const range of [
    { from: "", to: "" },
    { from: "", to: undefined },
    { from: undefined, to: "" },
    { from: "", to: "2026-12-31" },
    { from: "2026-01-01", to: "" },
  ]) {
    const result = reports.runReport(org, "offboarding_reasons", range);
    assert.equal(
      result.total,
      range.from || range.to ? result.total : all,
      `blank bounds narrow nothing: ${JSON.stringify(range)}`,
    );
  }
  assert.equal(reports.runReport(org, "offboarding_reasons", { from: "", to: "" }).total, all);
});

test("retention reports the share still with us", () => {
  const rows = rowsOf("retention");
  assert.equal(rows.get("Carriers ever onboarded"), 6);
  assert.equal(rows.get("Still with us"), 5);
  assert.equal(rows.get("Departed"), 1);
  assert.equal(rows.get("Retention rate (%)"), 83.3);
});

/**
 * The dispatch and money reports. They are the first that count something other than a
 * carrier, which is what forced `unit` to exist — and the first whose figures a role
 * without `invoice:view` must never reach.
 */
test("dispatch and money reports count loads and invoices, and respect the range", () => {
  const now = new Date().toISOString();
  const carrierId = db.get<{ id: number }>(
    "SELECT id FROM carriers WHERE organization_id = ? ORDER BY id LIMIT 1", [org.id],
  )!.id;
  const brokerId = db.get<{ id: number }>(
    "SELECT id FROM brokers WHERE organization_id = ? ORDER BY id LIMIT 1", [org.id],
  )!.id;

  const load = (status: string, dispatcherId: number, createdAt: string) => {
    db.run(
      `INSERT INTO loads (organization_id, carrier_id, dispatcher_id, broker_id, status, rate, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1000, ?, ?)`,
      [org.id, carrierId, dispatcherId, brokerId, status, createdAt, now],
    );
  };
  load("delivered", alice, "2026-01-10T08:00:00.000Z");
  load("delivered", alice, "2026-01-31T23:00:00.000Z"); // the closing day of the range
  load("in_transit", bob, "2026-05-02T08:00:00.000Z");

  const invoice = (status: string, issuedOn: string, total: number) => {
    db.run(
      `INSERT INTO invoices (organization_id, invoice_type, carrier_id, status, issued_on, total_amount, created_at, updated_at)
       VALUES (?, 'dispatch', ?, ?, ?, ?, ?, ?)`,
      [org.id, carrierId, status, issuedOn, total, now, now],
    );
  };
  invoice("pending", "2026-01-20", 300);
  invoice("paid", "2026-05-04", 500);

  const status = rowsOf("loads_by_status");
  assert.equal(status.get("Delivered"), 2);
  assert.equal(status.get("In Transit"), 1);
  // Statuses nobody has reached are absent rather than shown as a row of zero.
  assert.equal(status.has("Closed"), false);

  const dispatchers = rowsOf("loads_by_dispatcher");
  assert.equal(dispatchers.get("Alice"), 2);
  assert.equal(dispatchers.get("Bob"), 1);

  // One broker on every fixture load, so the breakdown accounts for all three.
  assert.equal(reports.runReport(org, "loads_by_broker").total, 3);

  // January only — and the load booked at 23:00 on the 31st is inside it.
  const january = rowsOf("loads_by_dispatcher", { from: "2026-01-01", to: "2026-01-31" });
  assert.equal(january.get("Alice"), 2);
  assert.equal(january.has("Bob"), false);

  assert.equal(reports.runReport(org, "fee_by_carrier").total, 800);
  assert.equal(reports.runReport(org, "fee_by_carrier", { from: "2026-05-01" }).total, 500);
  assert.equal(rowsOf("invoices_by_status").get("Disputed"), undefined);
  assert.equal(rowsOf("invoices_by_status").get("Pending"), 1);

  // Ageing reads /billing's own buckets, so only the unpaid one is in it.
  assert.equal(reports.runReport(org, "receivables_ageing").total, 300);
});

test("every report exports as a CSV that parses back to the same numbers", () => {
  for (const def of reports.REPORTS) {
    const result = reports.runReport(org, def.key);
    const text = csv.toCsv(reports.reportToCsvRows(result));
    const parsed = csv.parseCsv(text);

    // The heading is the report's own unit. It used to say "Carriers" over every column,
    // including the ones now full of loads and dollars.
    assert.deepEqual(parsed[0], [def.dimension, def.unit], `${def.key} header`);
    assert.equal(parsed.length - 1, result.rows.length, `${def.key} row count`);
    for (let i = 0; i < result.rows.length; i++) {
      assert.equal(parsed[i + 1]![0], result.rows[i]!.label, `${def.key} label ${i}`);
      assert.equal(Number(parsed[i + 1]![1]), result.rows[i]!.value, `${def.key} value ${i}`);
    }
  }
});
