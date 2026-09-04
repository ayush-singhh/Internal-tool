import "server-only";
import { all, get } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import {
  INVOICE_STATUS, INVOICE_TERM_DAYS, LEAD_STATUS, LOAD_STATUS, TASK_STATUS, type Tone,
} from "./constants.ts";

/**
 * Billing oversight and team performance — the aggregate views over data other phases
 * already write. Nothing here creates a record; it only counts what is there.
 *
 * **On accounts payable.** The client's spec asks for both halves. Only the receivable one
 * exists: this product invoices carriers for Asterism's dispatch fee, and that is the whole
 * of the money it models. A payables ledger would need the Carrier → Broker freight
 * invoice, which `invoices.invoice_type` leaves room for and which was deliberately not
 * built (see the 2026-09-02 invoicing design, §1). Rather than invent a ledger out of
 * columns that mean something else, `payablesGap()` states plainly what is missing and
 * what it would take — an empty truth beats a populated fiction on a finance screen.
 */

const todayIso = () => new Date().toISOString().slice(0, 10);

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}

export type AgeBucket = {
  key: string;
  label: string;
  description: string;
  tone: Tone;
  count: number;
  amount: number;
};

export type OutstandingInvoice = {
  id: number;
  carrier_id: number;
  carrier_name: string;
  issued_on: string;
  total_amount: number;
  status: string;
  days_outstanding: number;
};

export type Receivables = {
  /** Everything invoiced and not yet paid — pending plus disputed. */
  outstanding: number;
  outstandingCount: number;
  /** Past the payment term. The number that actually needs chasing. */
  overdue: number;
  overdueCount: number;
  disputed: number;
  disputedCount: number;
  paidThisMonth: number;
  /** Raised but not yet invoiced: delivered loads with no invoice line against them.
   *  Money the organisation has earned and not yet asked for, which is a different
   *  problem from money it has asked for and not been given. */
  uninvoicedLoads: number;
  buckets: AgeBucket[];
  oldest: OutstandingInvoice[];
  termDays: number;
};

/** Invoiced and not yet settled. Bound, never interpolated — the two statuses ride along
 *  as parameters so this fragment carries no values into the SQL at all. */
const UNPAID = "i.status IN (?, ?)";
const UNPAID_PARAMS = [INVOICE_STATUS.PENDING, INVOICE_STATUS.DISPUTED];

/**
 * Aged receivables.
 *
 * Ageing runs from `issued_on`, because that is the date on the document the carrier
 * received. Terms are a flat `INVOICE_TERM_DAYS` — per-carrier terms are a real thing in
 * this industry and nobody has asked for them yet.
 */
export function receivables(org: Org): Receivables {
  const today = todayIso();
  const monthStart = `${today.slice(0, 7)}-01`;

  const bucketDefs: { key: string; label: string; description: string; tone: Tone; from: number; to: number | null }[] = [
    { key: "current", label: "Current",  description: `Issued within ${INVOICE_TERM_DAYS} days`, tone: "green",  from: 0,  to: INVOICE_TERM_DAYS },
    { key: "d30",     label: "31–60",    description: "Past terms, first month",                 tone: "amber",  from: INVOICE_TERM_DAYS + 1, to: 60 },
    { key: "d60",     label: "61–90",    description: "Two months past terms",                   tone: "orange", from: 61, to: 90 },
    { key: "d90",     label: "90+",      description: "The ones that stop being likely",          tone: "red",    from: 91, to: null },
  ];

  const buckets = bucketDefs.map((def) => {
    // Older than `from` days, and no older than `to` days. Both bounds are dates rather
    // than a computed age, so SQLite compares strings and the index on issued_on is usable.
    const newest = daysAgoIso(def.from);
    const oldest = def.to === null ? null : daysAgoIso(def.to);
    const row = get<{ n: number; amount: number | null }>(
      `SELECT COUNT(*) AS n, SUM(i.total_amount) AS amount
         FROM invoices i
        WHERE i.organization_id = ? AND ${UNPAID}
          AND i.issued_on <= ?${oldest === null ? "" : " AND i.issued_on >= ?"}`,
      oldest === null
        ? [org.id, ...UNPAID_PARAMS, newest]
        : [org.id, ...UNPAID_PARAMS, newest, oldest],
    )!;
    return {
      key: def.key, label: def.label, description: def.description, tone: def.tone,
      count: row.n, amount: row.amount ?? 0,
    };
  });

  const totals = get<{ n: number; amount: number | null }>(
    `SELECT COUNT(*) AS n, SUM(i.total_amount) AS amount
       FROM invoices i WHERE i.organization_id = ? AND ${UNPAID}`,
    [org.id, ...UNPAID_PARAMS],
  )!;

  const overdue = get<{ n: number; amount: number | null }>(
    `SELECT COUNT(*) AS n, SUM(i.total_amount) AS amount
       FROM invoices i
      WHERE i.organization_id = ? AND ${UNPAID} AND i.issued_on < ?`,
    [org.id, ...UNPAID_PARAMS, daysAgoIso(INVOICE_TERM_DAYS)],
  )!;

  const disputed = get<{ n: number; amount: number | null }>(
    `SELECT COUNT(*) AS n, SUM(i.total_amount) AS amount
       FROM invoices i WHERE i.organization_id = ? AND i.status = ?`,
    [org.id, INVOICE_STATUS.DISPUTED],
  )!;

  const paidThisMonth = get<{ amount: number | null }>(
    `SELECT SUM(i.total_amount) AS amount
       FROM invoices i
      WHERE i.organization_id = ? AND i.status = ? AND i.paid_on >= ?`,
    [org.id, INVOICE_STATUS.PAID, monthStart],
  )!;

  // Delivered but never billed. `invoice_lines` is the record of a load having been
  // charged for, so its absence is the whole test.
  const uninvoiced = get<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM loads l
      WHERE l.organization_id = ? AND l.status = ?
        AND NOT EXISTS (SELECT 1 FROM invoice_lines li
                         WHERE li.organization_id = l.organization_id AND li.load_id = l.id)`,
    [org.id, LOAD_STATUS.DELIVERED],
  )!;

  const oldest = all<OutstandingInvoice>(
    `SELECT i.id, i.carrier_id, c.legal_name AS carrier_name, i.issued_on,
            i.total_amount, i.status,
            CAST(julianday(?) - julianday(i.issued_on) AS INTEGER) AS days_outstanding
       FROM invoices i
       JOIN carriers c ON c.organization_id = i.organization_id AND c.id = i.carrier_id
      WHERE i.organization_id = ? AND ${UNPAID}
      ORDER BY i.issued_on
      LIMIT 12`,
    [today, org.id, ...UNPAID_PARAMS],
  );

  return {
    outstanding: totals.amount ?? 0,
    outstandingCount: totals.n,
    overdue: overdue.amount ?? 0,
    overdueCount: overdue.n,
    disputed: disputed.amount ?? 0,
    disputedCount: disputed.n,
    paidThisMonth: paidThisMonth.amount ?? 0,
    uninvoicedLoads: uninvoiced.n,
    buckets,
    oldest,
    termDays: INVOICE_TERM_DAYS,
  };
}

/** What the payables half would need, said plainly rather than faked. */
export function payablesGap(): { title: string; body: string[] } {
  return {
    title: "Accounts payable is not modelled yet",
    body: [
      "This product invoices carriers for the dispatch fee, and that is the whole of the money it currently tracks. There is no ledger of what the organisation owes anybody, because nothing here records a bill against it.",
      "The payable side arrives with the Carrier → Broker freight invoice: once freight is billed to a broker and collected, what is owed onward to the carrier — freight minus the dispatch fee, minus deductions, plus approved extra pay — becomes a real balance rather than a derived guess. The schema already leaves room for it (invoices.invoice_type), and the design is written up; it was deferred because no client had asked for it.",
      "Everything needed to build it is here. It is a decision, not a discovery.",
    ],
  };
}

// ── team performance ─────────────────────────────────────────────────────────

export type PerformanceRow = {
  id: number;
  name: string;
  role: string;
  active: number;
  /** Carriers where they are the dispatcher or the account manager. */
  carriers: number;
  loads: number;
  loadsDelivered: number;
  /** Dispatch fee on the loads they ran, from the invoice lines — snapshotted amounts,
   *  so this figure does not drift when a rate is corrected later. */
  revenue: number;
  leads: number;
  leadsConverted: number;
  tasksOpen: number;
  tasksDone: number;
};

export type PerformanceRange = { from?: string; to?: string };

/**
 * `column >= ? AND column <= ?`, or nothing. Returned with its parameters so no value is
 * ever interpolated into the SQL — only the shape of the clause is.
 *
 * Callers pass a *date-valued* expression. A range's `to` is a plain `YYYY-MM-DD`, so
 * comparing it against a full ISO timestamp silently drops that whole last day —
 * `'2026-01-31T09:00:00Z' <= '2026-01-31'` is false. Timestamp columns are therefore
 * wrapped in `substr(…, 1, 10)` at the call site.
 */
function within(column: string, range: PerformanceRange): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (range.from) { parts.push(`AND ${column} >= ?`); params.push(range.from); }
  if (range.to) { parts.push(`AND ${column} <= ?`); params.push(range.to); }
  return { sql: parts.length ? ` ${parts.join(" ")}` : "", params };
}

/**
 * One row per active person, several measures across.
 *
 * Deliberately five small aggregates assembled in TypeScript rather than one query with
 * five correlated subselects and a date range threaded through each: the parameter order
 * in that version is where the bug would live, and this shape is the one a reader can
 * check a column at a time.
 */
export function teamPerformance(org: Org, range: PerformanceRange = {}): PerformanceRow[] {
  const people = all<{ id: number; name: string; role: string; active: number }>(
    "SELECT id, name, role, active FROM users WHERE organization_id = ? AND active = 1 ORDER BY name",
    [org.id],
  );
  if (people.length === 0) return [];

  const tally = (sql: string, params: unknown[]): Map<number, number> => {
    const rows = all<{ id: number | null; n: number }>(sql, params);
    const map = new Map<number, number>();
    for (const row of rows) if (row.id !== null) map.set(row.id, row.n);
    return map;
  };

  // Carriers are counted per role held, so somebody who is both dispatcher and account
  // manager on one carrier counts it once — hence the union rather than two sums.
  const carriers = tally(
    `SELECT user_id AS id, COUNT(DISTINCT carrier_id) AS n FROM (
        SELECT dispatcher_id AS user_id, id AS carrier_id FROM carriers
         WHERE organization_id = ? AND dispatcher_id IS NOT NULL
        UNION
        SELECT account_manager_id AS user_id, id AS carrier_id FROM carriers
         WHERE organization_id = ? AND account_manager_id IS NOT NULL
     ) GROUP BY user_id`,
    [org.id, org.id],
  );

  const loadWindow = within("substr(l.created_at, 1, 10)", range);
  const loads = tally(
    `SELECT l.dispatcher_id AS id, COUNT(*) AS n FROM loads l
      WHERE l.organization_id = ?${loadWindow.sql} GROUP BY l.dispatcher_id`,
    [org.id, ...loadWindow.params],
  );
  const delivered = tally(
    `SELECT l.dispatcher_id AS id, COUNT(*) AS n FROM loads l
      WHERE l.organization_id = ? AND l.status IN (?, ?, ?, ?)${loadWindow.sql}
      GROUP BY l.dispatcher_id`,
    [org.id, LOAD_STATUS.DELIVERED, LOAD_STATUS.INVOICED, LOAD_STATUS.PAID, LOAD_STATUS.CLOSED,
     ...loadWindow.params],
  );

  const feeWindow = within("i.issued_on", range);
  const revenue = tally(
    `SELECT l.dispatcher_id AS id, SUM(li.amount) AS n
       FROM invoice_lines li
       JOIN invoices i ON i.organization_id = li.organization_id AND i.id = li.invoice_id
       JOIN loads l    ON l.organization_id = li.organization_id AND l.id = li.load_id
      WHERE li.organization_id = ?${feeWindow.sql}
      GROUP BY l.dispatcher_id`,
    [org.id, ...feeWindow.params],
  );

  const leadWindow = within("substr(created_at, 1, 10)", range);
  const leads = tally(
    `SELECT owner_id AS id, COUNT(*) AS n FROM leads
      WHERE organization_id = ?${leadWindow.sql} GROUP BY owner_id`,
    [org.id, ...leadWindow.params],
  );
  const converted = tally(
    `SELECT owner_id AS id, COUNT(*) AS n FROM leads
      WHERE organization_id = ? AND status = ?${leadWindow.sql} GROUP BY owner_id`,
    [org.id, LEAD_STATUS.WON, ...leadWindow.params],
  );

  const tasksOpen = tally(
    `SELECT assigned_to AS id, COUNT(*) AS n FROM tasks
      WHERE organization_id = ? AND status = ? GROUP BY assigned_to`,
    [org.id, TASK_STATUS.OPEN],
  );
  const doneWindow = within("substr(completed_at, 1, 10)", range);
  const tasksDone = tally(
    `SELECT completed_by AS id, COUNT(*) AS n FROM tasks
      WHERE organization_id = ? AND status = ?${doneWindow.sql} GROUP BY completed_by`,
    [org.id, TASK_STATUS.DONE, ...doneWindow.params],
  );

  return people.map((person) => ({
    ...person,
    carriers: carriers.get(person.id) ?? 0,
    loads: loads.get(person.id) ?? 0,
    loadsDelivered: delivered.get(person.id) ?? 0,
    revenue: revenue.get(person.id) ?? 0,
    leads: leads.get(person.id) ?? 0,
    leadsConverted: converted.get(person.id) ?? 0,
    tasksOpen: tasksOpen.get(person.id) ?? 0,
    tasksDone: tasksDone.get(person.id) ?? 0,
  }));
}

export type PerformanceTotals = Omit<PerformanceRow, "id" | "name" | "role" | "active">;

/** Column sums, so a reader can tell one person's share from the whole. */
export function performanceTotals(rows: PerformanceRow[]): PerformanceTotals {
  return rows.reduce<PerformanceTotals>(
    (sum, row) => ({
      carriers: sum.carriers + row.carriers,
      loads: sum.loads + row.loads,
      loadsDelivered: sum.loadsDelivered + row.loadsDelivered,
      revenue: sum.revenue + row.revenue,
      leads: sum.leads + row.leads,
      leadsConverted: sum.leadsConverted + row.leadsConverted,
      tasksOpen: sum.tasksOpen + row.tasksOpen,
      tasksDone: sum.tasksDone + row.tasksDone,
    }),
    { carriers: 0, loads: 0, loadsDelivered: 0, revenue: 0, leads: 0, leadsConverted: 0, tasksOpen: 0, tasksDone: 0 },
  );
}
