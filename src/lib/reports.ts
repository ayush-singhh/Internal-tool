import "server-only";
import { all, get } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import { can, type Action, type SessionUser } from "./permissions.ts";
import { receivables } from "./finance.ts";
import {
  INVOICE_STATUS_LABELS, LOAD_STATUS_LABELS, type InvoiceStatus, type LoadStatus,
} from "./constants.ts";
import {
  activeByUser, carriersByAccountManager, carriersByDispatcher, carriersByFleetSize,
  carriersByLeadSource, carriersByPercentageBand, carriersByPlan, carriersByPricingType,
  carriersByStatus, carriersByTrailerType, monthlySeries, offboardingReasons,
  offboardingTrend, onboardingTrend, retention, type Slice,
} from "./stats.ts";

export type ReportKey =
  | "active_by_dispatcher" | "active_by_account_manager" | "by_status" | "by_lead_source"
  | "by_plan" | "by_pricing" | "by_percentage" | "by_trailer_type" | "by_fleet_size"
  | "monthly_onboarding" | "monthly_offboarding" | "retention" | "offboarding_reasons"
  | "loads_by_status" | "loads_by_dispatcher" | "loads_by_broker" | "monthly_loads"
  | "fee_by_month" | "fee_by_carrier" | "invoices_by_status" | "receivables_ageing";

export type ReportShape = "breakdown" | "trend" | "summary";

export type ReportDef = {
  key: ReportKey;
  title: string;
  description: string;
  group: "Team" | "Portfolio" | "Commercial" | "Movement" | "Dispatch" | "Money";
  shape: ReportShape;
  /** Column heading for the dimension, e.g. "Dispatcher". */
  dimension: string;
  /** Column heading for the value, e.g. "Carriers". Before this every report's second
   *  column said "Carriers", which was true of thirteen of them and a lie about the rest. */
  unit: string;
  /** Values are currency, so they print as money rather than as a count. */
  money?: boolean;
  /**
   * The permission that reveals this report — the same rule the sidebar uses.
   *
   * Reports had no gate of any kind: the page took `org` from the session and never asked
   * `can()`, so anyone who typed the URL got the whole book's figures whatever their role.
   * That is the Phase 16 bug again, and adding money reports to an ungated page would have
   * handed dispatch-fee revenue to every viewer.
   */
  action: Action;
  /** Whether the date filter narrows this report at all. */
  dated: boolean;
};

export const REPORTS: ReportDef[] = [
  { key: "active_by_dispatcher",      title: "Active carriers by dispatcher",   description: "Live workload across the dispatch team.",              group: "Team",       shape: "breakdown", dimension: "Dispatcher",       unit: "Carriers",     action: "carrier:view", dated: false },
  { key: "active_by_account_manager", title: "Active carriers by account manager", description: "Commercial ownership of active carriers.",          group: "Team",       shape: "breakdown", dimension: "Account Manager",  unit: "Carriers",     action: "carrier:view", dated: false },
  { key: "by_status",                 title: "Carriers by status",              description: "The whole book split by current status.",              group: "Portfolio",  shape: "breakdown", dimension: "Status",           unit: "Carriers",     action: "carrier:view", dated: true  },
  { key: "by_lead_source",            title: "Carriers by lead source",         description: "Which channels actually produce carriers.",            group: "Portfolio",  shape: "breakdown", dimension: "Lead Source",      unit: "Carriers",     action: "carrier:view", dated: true  },
  { key: "by_trailer_type",           title: "Carriers by trailer type",        description: "Equipment mix across the fleet.",                      group: "Portfolio",  shape: "breakdown", dimension: "Trailer Type",     unit: "Carriers",     action: "carrier:view", dated: true  },
  { key: "by_fleet_size",             title: "Carriers by fleet size",          description: "How many are owner-operators versus real fleets.",     group: "Portfolio",  shape: "breakdown", dimension: "Fleet Size",       unit: "Carriers",     action: "carrier:view", dated: true  },
  { key: "by_plan",                   title: "Carriers by plan",                description: "Plan distribution across the book.",                   group: "Commercial", shape: "breakdown", dimension: "Plan",             unit: "Carriers",     action: "carrier:view", dated: true  },
  { key: "by_pricing",                title: "Revenue / pricing distribution",  description: "How carriers are charged.",                            group: "Commercial", shape: "breakdown", dimension: "Pricing Type",     unit: "Carriers",     action: "carrier:view", dated: true  },
  { key: "by_percentage",             title: "Carriers by percentage",          description: "Where percentage-per-load carriers sit.",              group: "Commercial", shape: "breakdown", dimension: "Percentage Band",  unit: "Carriers",     action: "carrier:view", dated: true  },
  { key: "monthly_onboarding",        title: "Monthly onboarding",              description: "Carriers onboarded per month.",                        group: "Movement",   shape: "trend",     dimension: "Month",            unit: "Carriers",     action: "carrier:view", dated: true  },
  { key: "monthly_offboarding",       title: "Monthly offboarding",             description: "Carriers offboarded per month.",                       group: "Movement",   shape: "trend",     dimension: "Month",            unit: "Carriers",     action: "carrier:view", dated: true  },
  { key: "offboarding_reasons",       title: "Offboarding reasons",             description: "Why carriers leave.",                                  group: "Movement",   shape: "breakdown", dimension: "Reason",           unit: "Carriers",     action: "carrier:view", dated: true  },
  { key: "retention",                 title: "Carrier retention",               description: "Share of carriers still with us.",                     group: "Movement",   shape: "summary",   dimension: "Measure",          unit: "Carriers",     action: "carrier:view", dated: false },

  // Dispatch and money. These count loads and invoices rather than carriers, which is why
  // `unit` had to exist before they could be added at all.
  { key: "loads_by_status",           title: "Loads by status",                 description: "Where the board stands right now.",                    group: "Dispatch",   shape: "breakdown", dimension: "Status",           unit: "Loads",        action: "load:view",    dated: true  },
  { key: "loads_by_dispatcher",       title: "Loads by dispatcher",             description: "Who is running how much freight.",                     group: "Dispatch",   shape: "breakdown", dimension: "Dispatcher",       unit: "Loads",        action: "load:view",    dated: true  },
  { key: "loads_by_broker",           title: "Loads by broker",                 description: "Which brokers the work actually comes from.",          group: "Dispatch",   shape: "breakdown", dimension: "Broker",           unit: "Loads",        action: "load:view",    dated: true  },
  { key: "monthly_loads",             title: "Monthly loads booked",            description: "Freight volume per month.",                            group: "Dispatch",   shape: "trend",     dimension: "Month",            unit: "Loads",        action: "load:view",    dated: true  },
  { key: "fee_by_month",              title: "Dispatch fee by month",           description: "What was invoiced each month.",                        group: "Money",      shape: "trend",     dimension: "Month",            unit: "Dispatch fee", action: "invoice:view", dated: true, money: true },
  { key: "fee_by_carrier",            title: "Dispatch fee by carrier",         description: "Which carriers the fee comes from.",                   group: "Money",      shape: "breakdown", dimension: "Carrier",          unit: "Dispatch fee", action: "invoice:view", dated: true, money: true },
  { key: "invoices_by_status",        title: "Invoices by status",              description: "Pending, paid and disputed side by side.",             group: "Money",      shape: "breakdown", dimension: "Status",           unit: "Invoices",     action: "invoice:view", dated: true  },
  // Reads the same buckets /billing draws, so the two can never disagree.
  { key: "receivables_ageing",        title: "Receivables ageing",              description: "Unpaid invoices by how long they have been owed.",     group: "Money",      shape: "breakdown", dimension: "Age",              unit: "Outstanding",  action: "invoice:manage", dated: false, money: true },
];

export const REPORT_MAP = new Map(REPORTS.map((r) => [r.key, r]));

export function parseReportKey(raw: string | undefined | null): ReportKey {
  return raw && REPORT_MAP.has(raw as ReportKey) ? (raw as ReportKey) : "active_by_dispatcher";
}

/** The reports this person may run. Same shape as `visibleNav` and for the same reason:
 *  a page that lists what it will not serve is a page that leaks its own contents. */
export function visibleReports(user: SessionUser): ReportDef[] {
  return REPORTS.filter((def) => can(user, def.action));
}

/** The single gate. Both the page and the CSV route ask it — a report reachable by URL but
 *  not by link is still reachable. */
export function mayRunReport(user: SessionUser, key: ReportKey): boolean {
  return can(user, REPORT_MAP.get(key)!.action);
}

export type ReportResult = {
  def: ReportDef;
  rows: Slice[];
  total: number;
  /** Set for trend reports so the page can draw a line instead of bars. */
  trend?: { month: string; value: number }[];
};

/**
 * Date-filtered breakdowns. The date range narrows on onboarding date (or offboarding
 * date for exit reports); reports about the current team workload ignore it, because
 * "active right now" is not a historical question.
 */
function datedBreakdown(
  org: Org,
  column: string,
  from: string | undefined,
  to: string | undefined,
  dateColumn = "c.onboarding_date",
): Slice[] {
  const where: string[] = ["c.organization_id = ?", `c.${column} IS NOT NULL`];
  const params: unknown[] = [org.id];
  if (from) { where.push(`${dateColumn} >= ?`); params.push(from); }
  if (to) { where.push(`${dateColumn} <= ?`); params.push(to); }

  return all<{ label: string; n: number }>(
    `SELECT l.label AS label, COUNT(c.id) AS n
       FROM carriers c JOIN lookups l ON l.id = c.${column}
      WHERE ${where.join(" AND ")}
      GROUP BY l.id ORDER BY n DESC, l.sort`,
    params,
  ).map((r) => ({ label: r.label, value: r.n }));
}

/**
 * `AND <date expression> BETWEEN ? AND ?`, or nothing, with its parameters.
 *
 * The expression is passed already wrapped in `substr(…, 1, 10)` where the column holds a
 * full timestamp: a range's `to` is a plain date, and `'2026-01-31T09:00Z' <= '2026-01-31'`
 * is false, which would drop the last day of every range.
 */
function dateWindow(
  dateExpr: string,
  from: string | undefined,
  to: string | undefined,
): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (from) { parts.push(`AND ${dateExpr} >= ?`); params.push(from); }
  if (to) { parts.push(`AND ${dateExpr} <= ?`); params.push(to); }
  return { sql: parts.length ? ` ${parts.join(" ")}` : "", params };
}

const LOADED = "substr(l.created_at, 1, 10)";

/** Loads grouped by a joined name — dispatcher or broker. Unassigned rows are dropped
 *  rather than bucketed as "Unknown": a bar labelled Unknown invites someone to go and
 *  fix the data, which is exactly the right instinct and exactly the wrong report. */
function loadsByJoin(
  org: Org,
  table: "users" | "brokers",
  column: "dispatcher_id" | "broker_id",
  from: string | undefined,
  to: string | undefined,
): Slice[] {
  const w = dateWindow(LOADED, from, to);
  return all<{ label: string; n: number }>(
    `SELECT j.name AS label, COUNT(l.id) AS n
       FROM loads l
       JOIN ${table} j ON j.organization_id = l.organization_id AND j.id = l.${column}
      WHERE l.organization_id = ?${w.sql}
      GROUP BY j.id ORDER BY n DESC, j.name`,
    [org.id, ...w.params],
  ).map((r) => ({ label: r.label, value: r.n }));
}

/** Rows keyed by a code, printed with the label the rest of the product uses. Ordered by
 *  the code list rather than by size, because a status breakdown reads as a pipeline. */
function byCode(rows: { code: string; n: number }[], labels: Record<string, string>): Slice[] {
  const found = new Map(rows.map((r) => [r.code, r.n]));
  return Object.entries(labels)
    .map(([code, label]) => ({ label, value: found.get(code) ?? 0 }))
    .filter((s) => s.value > 0);
}

export function runReport(
  org: Org,
  key: ReportKey,
  range: { from?: string; to?: string } = {},
): ReportResult {
  const def = REPORT_MAP.get(key)!;
  const { from, to } = range;
  const dated = Boolean(from || to);

  let rows: Slice[] = [];
  let trend: ReportResult["trend"];

  switch (key) {
    case "active_by_dispatcher":
      rows = activeByUser(org, "dispatcher_id");
      break;
    case "active_by_account_manager":
      rows = activeByUser(org, "account_manager_id");
      break;
    case "by_status":
      rows = dated ? datedBreakdown(org, "status_id", from, to) : carriersByStatus(org, );
      break;
    case "by_lead_source":
      rows = dated ? datedBreakdown(org, "lead_source_id", from, to) : carriersByLeadSource(org, );
      break;
    case "by_trailer_type":
      rows = dated ? datedBreakdown(org, "trailer_type_id", from, to) : carriersByTrailerType(org, );
      break;
    case "by_plan":
      rows = dated ? datedBreakdown(org, "plan_id", from, to) : carriersByPlan(org, );
      break;
    case "by_pricing":
      rows = dated ? datedBreakdown(org, "pricing_type_id", from, to) : carriersByPricingType(org, );
      break;
    case "by_fleet_size":
      rows = carriersByFleetSize(org, );
      break;
    case "by_percentage":
      rows = carriersByPercentageBand(org, );
      break;
    case "offboarding_reasons":
      // Takes the range directly: an unbounded call is just one with no bounds.
      rows = offboardingReasons(org, from, to);
      break;
    case "monthly_onboarding":
      trend = onboardingTrend(org, 24).filter((p) => inRange(p.month, from, to));
      rows = trend.map((p) => ({ label: p.month, value: p.value }));
      break;
    case "monthly_offboarding":
      trend = offboardingTrend(org, 24).filter((p) => inRange(p.month, from, to));
      rows = trend.map((p) => ({ label: p.month, value: p.value }));
      break;
    case "retention": {
      const r = retention(org, );
      const exited = r.onboarded - r.retained;
      rows = [
        { label: "Carriers ever onboarded", value: r.onboarded },
        { label: "Still with us", value: r.retained },
        { label: "Departed", value: exited },
        { label: "Retention rate (%)", value: Math.round(r.rate * 1000) / 10 },
      ];
      break;
    }

    case "loads_by_status": {
      const w = dateWindow(LOADED, from, to);
      rows = byCode(
        all<{ code: string; n: number }>(
          `SELECT l.status AS code, COUNT(*) AS n FROM loads l
            WHERE l.organization_id = ?${w.sql} GROUP BY l.status`,
          [org.id, ...w.params],
        ),
        LOAD_STATUS_LABELS as Record<LoadStatus, string>,
      );
      break;
    }
    case "loads_by_dispatcher":
      rows = loadsByJoin(org, "users", "dispatcher_id", from, to);
      break;
    case "loads_by_broker":
      rows = loadsByJoin(org, "brokers", "broker_id", from, to);
      break;
    case "monthly_loads":
      trend = monthlySeries(
        all<{ month: string; n: number }>(
          `SELECT substr(created_at, 1, 7) AS month, COUNT(*) AS n
             FROM loads WHERE organization_id = ? GROUP BY month ORDER BY month`,
          [org.id],
        ),
        24,
      ).filter((p) => inRange(p.month, from, to));
      rows = trend.map((p) => ({ label: p.month, value: p.value }));
      break;

    case "fee_by_month":
      // Issue date, not creation date: the month an invoice belongs to is the month it
      // was raised in, which is the figure a bookkeeper will be reconciling against.
      trend = monthlySeries(
        all<{ month: string; n: number }>(
          `SELECT substr(issued_on, 1, 7) AS month, SUM(total_amount) AS n
             FROM invoices WHERE organization_id = ? GROUP BY month ORDER BY month`,
          [org.id],
        ),
        24,
      ).filter((p) => inRange(p.month, from, to));
      rows = trend.map((p) => ({ label: p.month, value: p.value }));
      break;
    case "fee_by_carrier": {
      const w = dateWindow("i.issued_on", from, to);
      rows = all<{ label: string; n: number }>(
        `SELECT c.legal_name AS label, SUM(i.total_amount) AS n
           FROM invoices i
           JOIN carriers c ON c.organization_id = i.organization_id AND c.id = i.carrier_id
          WHERE i.organization_id = ?${w.sql}
          GROUP BY c.id ORDER BY n DESC, c.legal_name`,
        [org.id, ...w.params],
      ).map((r) => ({ label: r.label, value: r.n }));
      break;
    }
    case "invoices_by_status": {
      const w = dateWindow("i.issued_on", from, to);
      rows = byCode(
        all<{ code: string; n: number }>(
          `SELECT i.status AS code, COUNT(*) AS n FROM invoices i
            WHERE i.organization_id = ?${w.sql} GROUP BY i.status`,
          [org.id, ...w.params],
        ),
        INVOICE_STATUS_LABELS as Record<InvoiceStatus, string>,
      );
      break;
    }
    case "receivables_ageing":
      // Ageing is measured from today by definition, so the date filter does not apply —
      // `dated: false` says so on the page.
      rows = receivables(org).buckets.map((b) => ({ label: b.label, value: b.amount }));
      break;
  }

  const total =
    key === "retention"
      ? rows[0]?.value ?? 0
      : rows.reduce((sum, r) => sum + r.value, 0);

  return { def, rows, total, trend };
}

function inRange(month: string, from?: string, to?: string): boolean {
  if (from && month < from.slice(0, 7)) return false;
  if (to && month > to.slice(0, 7)) return false;
  return true;
}

/** Every report reduces to a two-column table, so one CSV shape serves them all. The
 *  value heading comes from the report rather than being hardcoded — the sheet used to
 *  say "Carriers" over a column of dollars. */
export function reportToCsvRows(result: ReportResult): unknown[][] {
  return [
    [result.def.dimension, result.def.unit],
    ...result.rows.map((r) => [r.label, r.value]),
  ];
}

export function reportCount(org: Org): number {
  return get<{ n: number }>("SELECT COUNT(*) AS n FROM carriers WHERE organization_id = ?", [org.id])!.n;
}
