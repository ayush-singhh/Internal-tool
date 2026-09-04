/**
 * Billing oversight and team performance.
 *
 * The rules worth pinning:
 *   1. The four ageing buckets tile the whole timeline exactly once. An invoice belongs to
 *      one of them, never two and never none — a gap or an overlap here means the buckets
 *      stop summing to the outstanding total, which is the one arithmetic a finance screen
 *      must never get wrong.
 *   2. Outstanding is pending *plus* disputed. A disputed invoice is still money owed; it
 *      is money owed with an argument attached, which is why it is also counted alone.
 *   3. Every figure is per organisation. Another tenant's invoice must never reach a
 *      total, because a wrong number is worse than a missing one.
 *   4. A date range narrows the things that happen on a date (loads, leads, fees earned,
 *      tasks completed) and leaves alone the things that are simply true right now
 *      (carriers held, tasks still open).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { seedOrg, lookupId, type TestOrg } from "./helpers.ts";

const DB = path.join(tmpdir(), `carrier-hub-finance-${process.pid}.db`);
for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let fin: typeof import("../src/lib/finance.ts");
let C: typeof import("../src/lib/constants.ts");
let alpha: TestOrg;
let beta: TestOrg;
let org: import("../src/lib/tenant-db.ts").Org;
let betaOrg: import("../src/lib/tenant-db.ts").Org;

/** Dee dispatches, Sam sells, Gus has left. */
let dee: number;
let sam: number;
let gus: number;
let carrierA: number;
let carrierB: number;

const now = () => new Date().toISOString();

/** N days before today, as the same YYYY-MM-DD string the queries compare against. */
const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

before(async () => {
  db = await import("../src/lib/db.ts");
  fin = await import("../src/lib/finance.ts");
  C = await import("../src/lib/constants.ts");
  const { Org } = await import("../src/lib/tenant-db.ts");

  alpha = seedOrg(db, "Alpha Finance");
  beta = seedOrg(db, "Beta Finance");
  org = new Org(alpha.id);
  betaOrg = new Org(beta.id);

  const user = (orgId: number, name: string, role: string, active = 1) => {
    db.run(
      `INSERT INTO users (organization_id, name, email, password_hash, role, active, created_at, updated_at)
       VALUES (?, ?, ?, 'x', ?, ?, ?, ?)`,
      [orgId, name, `${name.toLowerCase()}-${orgId}@finance.test`, role, active, now(), now()],
    );
    return db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
  };
  dee = user(alpha.id, "Dee", C.ROLES.DISPATCHER);
  sam = user(alpha.id, "Sam", C.ROLES.SALES);
  gus = user(alpha.id, "Gus", C.ROLES.DISPATCHER, 0);

  const carrier = (orgId: number, name: string, dispatcherId: number | null, amId: number | null) => {
    db.run(
      `INSERT INTO carriers (organization_id, legal_name, status_id, dispatcher_id, account_manager_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [orgId, name, lookupId(db, orgId, "status", "active"), dispatcherId, amId, now(), now()],
    );
    return db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
  };
  // Dee is both dispatcher and account manager on A — it must still count as one carrier.
  carrierA = carrier(alpha.id, "Carrier A", dee, dee);
  carrierB = carrier(alpha.id, "Carrier B", dee, null);
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

// ── fixtures ─────────────────────────────────────────────────────────────────

function invoice(
  orgId: number,
  carrierId: number,
  opts: { issuedOn: string; total: number; status?: string; paidOn?: string },
): number {
  db.run(
    `INSERT INTO invoices (organization_id, invoice_type, carrier_id, status, issued_on, paid_on,
                           total_amount, created_at, updated_at)
     VALUES (?, 'dispatch', ?, ?, ?, ?, ?, ?, ?)`,
    [orgId, carrierId, opts.status ?? C.INVOICE_STATUS.PENDING, opts.issuedOn, opts.paidOn ?? null,
     opts.total, now(), now()],
  );
  return db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
}

function load(
  orgId: number,
  carrierId: number,
  opts: { status: string; dispatcherId?: number | null; createdAt?: string; rate?: number },
): number {
  db.run(
    `INSERT INTO loads (organization_id, carrier_id, dispatcher_id, status, rate, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [orgId, carrierId, opts.dispatcherId ?? null, opts.status, opts.rate ?? 1000,
     opts.createdAt ?? now(), now()],
  );
  return db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
}

function invoiceLine(orgId: number, invoiceId: number, loadId: number, amount: number): void {
  db.run(
    `INSERT INTO invoice_lines (organization_id, invoice_id, load_id, final_load_amount,
                                fee_basis, fee_rate, amount, created_at)
     VALUES (?, ?, ?, ?, 'flat', ?, ?, ?)`,
    [orgId, invoiceId, loadId, amount * 10, amount, amount, now()],
  );
}

/**
 * Wipes every row the finance queries read, so each test states its own whole world.
 * Scoped to the two test organisations because the isolation guard in `db.ts` refuses an
 * unqualified DELETE — which is the guard doing its job, even here.
 */
function reset(): void {
  // Children before parents: invoice_lines points at both invoices and loads.
  for (const table of ["invoice_lines", "invoices", "loads", "leads", "tasks"]) {
    db.run(`DELETE FROM ${table} WHERE organization_id IN (?, ?)`, [alpha.id, beta.id]);
  }
}

// ── receivables ──────────────────────────────────────────────────────────────

test("an organisation with no invoices reports zeroes, not nulls", () => {
  reset();
  const r = fin.receivables(org);
  assert.equal(r.outstanding, 0);
  assert.equal(r.outstandingCount, 0);
  assert.equal(r.overdue, 0);
  assert.equal(r.disputed, 0);
  assert.equal(r.paidThisMonth, 0);
  assert.equal(r.uninvoicedLoads, 0);
  assert.equal(r.oldest.length, 0);
  // The buckets are the shape of the report, so they are present even when empty.
  assert.equal(r.buckets.length, 4);
  assert.deepEqual(r.buckets.map((b) => b.amount), [0, 0, 0, 0]);
});

test("each bucket claims exactly the ages it names", () => {
  reset();
  invoice(alpha.id, carrierA, { issuedOn: daysAgo(0), total: 100 });
  invoice(alpha.id, carrierA, { issuedOn: daysAgo(30), total: 200 });   // last day of current
  invoice(alpha.id, carrierA, { issuedOn: daysAgo(31), total: 400 });   // first day past terms
  invoice(alpha.id, carrierA, { issuedOn: daysAgo(60), total: 800 });
  invoice(alpha.id, carrierA, { issuedOn: daysAgo(61), total: 1600 });
  invoice(alpha.id, carrierA, { issuedOn: daysAgo(90), total: 3200 });
  invoice(alpha.id, carrierA, { issuedOn: daysAgo(91), total: 6400 });
  invoice(alpha.id, carrierA, { issuedOn: daysAgo(400), total: 12800 });

  const by = new Map(fin.receivables(org).buckets.map((b) => [b.key, b]));
  assert.deepEqual([by.get("current")!.count, by.get("current")!.amount], [2, 300]);
  assert.deepEqual([by.get("d30")!.count, by.get("d30")!.amount], [2, 1200]);
  assert.deepEqual([by.get("d60")!.count, by.get("d60")!.amount], [2, 4800]);
  assert.deepEqual([by.get("d90")!.count, by.get("d90")!.amount], [2, 19200]);
});

test("the buckets sum to the outstanding total — no invoice falls between them", () => {
  reset();
  // Deliberately awkward ages, including both sides of every boundary.
  for (const [age, total] of [[0, 10], [1, 20], [29, 30], [30, 40], [31, 50], [59, 60],
                              [60, 70], [61, 80], [89, 90], [90, 100], [91, 110], [365, 120]]) {
    invoice(alpha.id, carrierA, { issuedOn: daysAgo(age), total });
  }
  const r = fin.receivables(org);
  assert.equal(r.buckets.reduce((s, b) => s + b.amount, 0), r.outstanding);
  assert.equal(r.buckets.reduce((s, b) => s + b.count, 0), r.outstandingCount);
  assert.equal(r.outstanding, 780);
});

test("outstanding is pending plus disputed; paid is not owed", () => {
  reset();
  invoice(alpha.id, carrierA, { issuedOn: daysAgo(5), total: 100 });
  invoice(alpha.id, carrierA, { issuedOn: daysAgo(5), total: 250, status: C.INVOICE_STATUS.DISPUTED });
  invoice(alpha.id, carrierA, { issuedOn: daysAgo(5), total: 999, status: C.INVOICE_STATUS.PAID, paidOn: daysAgo(1) });

  const r = fin.receivables(org);
  assert.equal(r.outstanding, 350);
  assert.equal(r.outstandingCount, 2);
  // Disputed is reported on its own as well, because it is chased differently.
  assert.equal(r.disputed, 250);
  assert.equal(r.disputedCount, 1);
});

test("overdue is everything past the payment term, and only that", () => {
  reset();
  invoice(alpha.id, carrierA, { issuedOn: daysAgo(C.INVOICE_TERM_DAYS), total: 100 });      // due today
  invoice(alpha.id, carrierA, { issuedOn: daysAgo(C.INVOICE_TERM_DAYS + 1), total: 200 });  // one day late
  invoice(alpha.id, carrierA, { issuedOn: daysAgo(200), total: 300 });

  const r = fin.receivables(org);
  assert.equal(r.termDays, C.INVOICE_TERM_DAYS);
  assert.equal(r.overdue, 500);
  assert.equal(r.overdueCount, 2);
});

test("paid this month counts settlement date, not issue date", () => {
  reset();
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;
  // Issued long ago, settled this month: it counts.
  invoice(alpha.id, carrierA, { issuedOn: daysAgo(300), total: 500, status: C.INVOICE_STATUS.PAID, paidOn: monthStart });
  // Issued this month, settled before it: it does not.
  invoice(alpha.id, carrierA, { issuedOn: daysAgo(1), total: 700, status: C.INVOICE_STATUS.PAID, paidOn: "2020-01-05" });

  assert.equal(fin.receivables(org).paidThisMonth, 500);
});

test("delivered loads with no invoice line are money not yet asked for", () => {
  reset();
  const billed = load(alpha.id, carrierA, { status: C.LOAD_STATUS.DELIVERED });
  load(alpha.id, carrierA, { status: C.LOAD_STATUS.DELIVERED });
  load(alpha.id, carrierA, { status: C.LOAD_STATUS.DELIVERED });
  // A load still in transit has not earned anything yet, so it is not missing an invoice.
  load(alpha.id, carrierA, { status: C.LOAD_STATUS.IN_TRANSIT });

  const inv = invoice(alpha.id, carrierA, { issuedOn: daysAgo(2), total: 90 });
  invoiceLine(alpha.id, inv, billed, 90);

  assert.equal(fin.receivables(org).uninvoicedLoads, 2);
});

test("the oldest list is the twelve longest-unpaid, aged and named", () => {
  reset();
  for (let age = 1; age <= 15; age++) {
    invoice(alpha.id, age % 2 === 0 ? carrierA : carrierB, { issuedOn: daysAgo(age), total: age });
  }
  invoice(alpha.id, carrierA, { issuedOn: daysAgo(500), total: 1, status: C.INVOICE_STATUS.PAID, paidOn: daysAgo(1) });

  const r = fin.receivables(org);
  assert.equal(r.oldest.length, 12);
  // Oldest first, and the settled one never appears however old it is.
  assert.equal(r.oldest[0]!.days_outstanding, 15);
  assert.equal(r.oldest[11]!.days_outstanding, 4);
  assert.ok(["Carrier A", "Carrier B"].includes(r.oldest[0]!.carrier_name));
});

test("another organisation's invoices reach none of these totals", () => {
  reset();
  const betaCarrier = db.get<{ id: number }>(
    "SELECT id FROM carriers WHERE organization_id = ?", [beta.id],
  )?.id;
  if (betaCarrier === undefined) {
    db.run(
      `INSERT INTO carriers (organization_id, legal_name, status_id, created_at, updated_at)
       VALUES (?, 'Beta Carrier', ?, ?, ?)`,
      [beta.id, lookupId(db, beta.id, "status", "active"), now(), now()],
    );
  }
  const betaId = db.get<{ id: number }>(
    "SELECT id FROM carriers WHERE organization_id = ? ORDER BY id LIMIT 1", [beta.id],
  )!.id;

  invoice(alpha.id, carrierA, { issuedOn: daysAgo(10), total: 100 });
  invoice(beta.id, betaId, { issuedOn: daysAgo(10), total: 9999 });
  load(beta.id, betaId, { status: C.LOAD_STATUS.DELIVERED });

  const a = fin.receivables(org);
  assert.equal(a.outstanding, 100);
  assert.equal(a.uninvoicedLoads, 0);
  assert.equal(a.oldest.length, 1);

  const b = fin.receivables(betaOrg);
  assert.equal(b.outstanding, 9999);
  assert.equal(b.uninvoicedLoads, 1);
});

test("the payables gap is stated, not faked", () => {
  const gap = fin.payablesGap();
  assert.ok(gap.title.length > 0);
  assert.ok(gap.body.length > 0);
});

// ── team performance ─────────────────────────────────────────────────────────

test("one row per active person, in name order, and nobody who has left", () => {
  reset();
  const rows = fin.teamPerformance(org);
  const names = rows.map((r) => r.name);
  assert.deepEqual(names, ["Dee", "Owner", "Sam"]);
  assert.equal(names.includes("Gus"), false);
});

test("a carrier held in two roles by one person counts once", () => {
  reset();
  const dees = fin.teamPerformance(org).find((r) => r.id === dee)!;
  // Dee is dispatcher on A and B, and account manager on A.
  assert.equal(dees.carriers, 2);
});

test("loads and delivered loads are counted against the dispatcher", () => {
  reset();
  load(alpha.id, carrierA, { status: C.LOAD_STATUS.CREATED, dispatcherId: dee });
  load(alpha.id, carrierA, { status: C.LOAD_STATUS.DELIVERED, dispatcherId: dee });
  load(alpha.id, carrierA, { status: C.LOAD_STATUS.PAID, dispatcherId: dee });
  // Unassigned work belongs to nobody rather than to everybody.
  load(alpha.id, carrierA, { status: C.LOAD_STATUS.DELIVERED, dispatcherId: null });

  const dees = fin.teamPerformance(org).find((r) => r.id === dee)!;
  assert.equal(dees.loads, 3);
  // Delivered means delivered *or past it* — invoiced, paid and closed all got there.
  assert.equal(dees.loadsDelivered, 2);
});

test("revenue is the snapshotted fee on the loads that person ran", () => {
  reset();
  const one = load(alpha.id, carrierA, { status: C.LOAD_STATUS.INVOICED, dispatcherId: dee });
  const two = load(alpha.id, carrierB, { status: C.LOAD_STATUS.INVOICED, dispatcherId: null });
  const inv = invoice(alpha.id, carrierA, { issuedOn: daysAgo(3), total: 450 });
  invoiceLine(alpha.id, inv, one, 300);
  invoiceLine(alpha.id, inv, two, 150);

  const rows = fin.teamPerformance(org);
  assert.equal(rows.find((r) => r.id === dee)!.revenue, 300);
  assert.equal(fin.performanceTotals(rows).revenue, 300);
});

test("leads and conversions are counted against their owner", () => {
  reset();
  const lead = (ownerId: number, status: string, createdAt = now()) =>
    db.run(
      `INSERT INTO leads (organization_id, company_name, status, owner_id, created_at, updated_at)
       VALUES (?, 'Prospect', ?, ?, ?, ?)`,
      [alpha.id, status, ownerId, createdAt, now()],
    );
  lead(sam, C.LEAD_STATUS.NEW);
  lead(sam, C.LEAD_STATUS.QUALIFIED);
  lead(sam, C.LEAD_STATUS.WON);
  lead(dee, C.LEAD_STATUS.LOST);

  const rows = fin.teamPerformance(org);
  const sams = rows.find((r) => r.id === sam)!;
  assert.equal(sams.leads, 3);
  assert.equal(sams.leadsConverted, 1);
  assert.equal(rows.find((r) => r.id === dee)!.leadsConverted, 0);
});

test("open tasks follow the assignee, completed ones follow whoever finished them", () => {
  reset();
  db.run(
    `INSERT INTO tasks (organization_id, title, assigned_to, status, created_at, updated_at)
     VALUES (?, 'Chase paperwork', ?, ?, ?, ?)`,
    [alpha.id, dee, C.TASK_STATUS.OPEN, now(), now()],
  );
  // Assigned to Sam, finished by Dee: the credit goes where the work went.
  db.run(
    `INSERT INTO tasks (organization_id, title, assigned_to, status, completed_at, completed_by, created_at, updated_at)
     VALUES (?, 'File the BOL', ?, ?, ?, ?, ?, ?)`,
    [alpha.id, sam, C.TASK_STATUS.DONE, now(), dee, now(), now()],
  );

  const rows = fin.teamPerformance(org);
  const dees = rows.find((r) => r.id === dee)!;
  assert.equal(dees.tasksOpen, 1);
  assert.equal(dees.tasksDone, 1);
  assert.equal(rows.find((r) => r.id === sam)!.tasksOpen, 0);
});

test("a date range narrows what happened, and leaves what simply is", () => {
  reset();
  load(alpha.id, carrierA, { status: C.LOAD_STATUS.DELIVERED, dispatcherId: dee, createdAt: "2026-01-15T09:00:00.000Z" });
  load(alpha.id, carrierA, { status: C.LOAD_STATUS.DELIVERED, dispatcherId: dee, createdAt: "2026-06-15T09:00:00.000Z" });
  db.run(
    `INSERT INTO tasks (organization_id, title, assigned_to, status, created_at, updated_at)
     VALUES (?, 'Still open', ?, ?, ?, ?)`,
    [alpha.id, dee, C.TASK_STATUS.OPEN, now(), now()],
  );

  const janOnly = fin.teamPerformance(org, { from: "2026-01-01", to: "2026-01-31" })
    .find((r) => r.id === dee)!;
  assert.equal(janOnly.loads, 1);
  // Carriers held and tasks still open are facts about now, so a range does not touch them.
  assert.equal(janOnly.carriers, 2);
  assert.equal(janOnly.tasksOpen, 1);

  const whole = fin.teamPerformance(org).find((r) => r.id === dee)!;
  assert.equal(whole.loads, 2);
});

test("an open-ended range still bounds the end it names", () => {
  reset();
  load(alpha.id, carrierA, { status: C.LOAD_STATUS.CREATED, dispatcherId: dee, createdAt: "2026-01-15T09:00:00.000Z" });
  load(alpha.id, carrierA, { status: C.LOAD_STATUS.CREATED, dispatcherId: dee, createdAt: "2026-06-15T09:00:00.000Z" });

  const from = fin.teamPerformance(org, { from: "2026-03-01" }).find((r) => r.id === dee)!;
  assert.equal(from.loads, 1);
  const to = fin.teamPerformance(org, { to: "2026-03-01" }).find((r) => r.id === dee)!;
  assert.equal(to.loads, 1);
});

test("the last day of a range is inside it, timestamp column or not", () => {
  reset();
  // 09:00 on the closing day. Compared naively, "2026-01-31T09:00:00.000Z" > "2026-01-31",
  // and the whole last day of every range silently disappears.
  load(alpha.id, carrierA, { status: C.LOAD_STATUS.CREATED, dispatcherId: dee, createdAt: "2026-01-31T09:00:00.000Z" });
  db.run(
    `INSERT INTO leads (organization_id, company_name, status, owner_id, created_at, updated_at)
     VALUES (?, 'Late in the day', ?, ?, ?, ?)`,
    [alpha.id, C.LEAD_STATUS.NEW, sam, "2026-01-31T23:59:00.000Z", now()],
  );
  db.run(
    `INSERT INTO tasks (organization_id, title, assigned_to, status, completed_at, completed_by, created_at, updated_at)
     VALUES (?, 'Finished late', ?, ?, ?, ?, ?, ?)`,
    [alpha.id, dee, C.TASK_STATUS.DONE, "2026-01-31T18:30:00.000Z", dee, now(), now()],
  );

  const rows = fin.teamPerformance(org, { from: "2026-01-01", to: "2026-01-31" });
  assert.equal(rows.find((r) => r.id === dee)!.loads, 1);
  assert.equal(rows.find((r) => r.id === sam)!.leads, 1);
  assert.equal(rows.find((r) => r.id === dee)!.tasksDone, 1);
});

test("performance rows never cross an organisation", () => {
  reset();
  const rows = fin.teamPerformance(org);
  assert.equal(rows.every((r) => r.name !== "Owner Beta"), true);
  // Beta has only its seeded owner, and none of Alpha's people.
  const betaRows = fin.teamPerformance(betaOrg);
  assert.deepEqual(betaRows.map((r) => r.name), ["Owner"]);
  assert.equal(betaRows[0]!.id === alpha.ownerId, false);
});

test("totals are the columns added up, and an empty team totals to zero", () => {
  reset();
  load(alpha.id, carrierA, { status: C.LOAD_STATUS.DELIVERED, dispatcherId: dee });
  const rows = fin.teamPerformance(org);
  const totals = fin.performanceTotals(rows);
  assert.equal(totals.loads, rows.reduce((s, r) => s + r.loads, 0));
  assert.equal(totals.carriers, rows.reduce((s, r) => s + r.carriers, 0));
  assert.deepEqual(fin.performanceTotals([]), {
    carriers: 0, loads: 0, loadsDelivered: 0, revenue: 0,
    leads: 0, leadsConverted: 0, tasksOpen: 0, tasksDone: 0,
  });
});
