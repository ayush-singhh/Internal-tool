import "server-only";
import { all, get } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import {
  activeByUser, carriersByAccountManager, carriersByDispatcher, carriersByFleetSize,
  carriersByLeadSource, carriersByPercentageBand, carriersByPlan, carriersByPricingType,
  carriersByStatus, carriersByTrailerType, offboardingReasons, offboardingTrend,
  onboardingTrend, retention, type Slice,
} from "./stats.ts";

export type ReportKey =
  | "active_by_dispatcher" | "active_by_account_manager" | "by_status" | "by_lead_source"
  | "by_plan" | "by_pricing" | "by_percentage" | "by_trailer_type" | "by_fleet_size"
  | "monthly_onboarding" | "monthly_offboarding" | "retention" | "offboarding_reasons";

export type ReportShape = "breakdown" | "trend" | "summary";

export type ReportDef = {
  key: ReportKey;
  title: string;
  description: string;
  group: "Team" | "Portfolio" | "Commercial" | "Movement";
  shape: ReportShape;
  /** Column heading for the dimension, e.g. "Dispatcher". */
  dimension: string;
  /** Whether the date filter narrows this report at all. */
  dated: boolean;
};

export const REPORTS: ReportDef[] = [
  { key: "active_by_dispatcher",      title: "Active carriers by dispatcher",   description: "Live workload across the dispatch team.",              group: "Team",       shape: "breakdown", dimension: "Dispatcher",       dated: false },
  { key: "active_by_account_manager", title: "Active carriers by account manager", description: "Commercial ownership of active carriers.",          group: "Team",       shape: "breakdown", dimension: "Account Manager",  dated: false },
  { key: "by_status",                 title: "Carriers by status",              description: "The whole book split by current status.",              group: "Portfolio",  shape: "breakdown", dimension: "Status",           dated: true  },
  { key: "by_lead_source",            title: "Carriers by lead source",         description: "Which channels actually produce carriers.",            group: "Portfolio",  shape: "breakdown", dimension: "Lead Source",      dated: true  },
  { key: "by_trailer_type",           title: "Carriers by trailer type",        description: "Equipment mix across the fleet.",                      group: "Portfolio",  shape: "breakdown", dimension: "Trailer Type",     dated: true  },
  { key: "by_fleet_size",             title: "Carriers by fleet size",          description: "How many are owner-operators versus real fleets.",     group: "Portfolio",  shape: "breakdown", dimension: "Fleet Size",       dated: true  },
  { key: "by_plan",                   title: "Carriers by plan",                description: "Plan distribution across the book.",                   group: "Commercial", shape: "breakdown", dimension: "Plan",             dated: true  },
  { key: "by_pricing",                title: "Revenue / pricing distribution",  description: "How carriers are charged.",                            group: "Commercial", shape: "breakdown", dimension: "Pricing Type",     dated: true  },
  { key: "by_percentage",             title: "Carriers by percentage",          description: "Where percentage-per-load carriers sit.",              group: "Commercial", shape: "breakdown", dimension: "Percentage Band",  dated: true  },
  { key: "monthly_onboarding",        title: "Monthly onboarding",              description: "Carriers onboarded per month.",                        group: "Movement",   shape: "trend",     dimension: "Month",            dated: true  },
  { key: "monthly_offboarding",       title: "Monthly offboarding",             description: "Carriers offboarded per month.",                       group: "Movement",   shape: "trend",     dimension: "Month",            dated: true  },
  { key: "offboarding_reasons",       title: "Offboarding reasons",             description: "Why carriers leave.",                                  group: "Movement",   shape: "breakdown", dimension: "Reason",           dated: true  },
  { key: "retention",                 title: "Carrier retention",               description: "Share of carriers still with us.",                     group: "Movement",   shape: "summary",   dimension: "Measure",          dated: false },
];

export const REPORT_MAP = new Map(REPORTS.map((r) => [r.key, r]));

export function parseReportKey(raw: string | undefined | null): ReportKey {
  return raw && REPORT_MAP.has(raw as ReportKey) ? (raw as ReportKey) : "active_by_dispatcher";
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
      rows = dated
        ? all<{ label: string; n: number }>(
            `SELECT l.label AS label, COUNT(o.id) AS n
               FROM offboarding_records o JOIN lookups l ON l.id = o.reason_id
              WHERE ${["o.organization_id = ?", from ? "o.offboarded_on >= ?" : null, to ? "o.offboarded_on <= ?" : null]
                .filter(Boolean).join(" AND ")}
              GROUP BY l.id ORDER BY n DESC`,
            [org.id, from, to].filter((v) => v !== undefined && v !== null),
          ).map((r) => ({ label: r.label, value: r.n }))
        : offboardingReasons(org, );
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

/** Every report reduces to a two-column table, so one CSV shape serves them all. */
export function reportToCsvRows(result: ReportResult): unknown[][] {
  return [
    [result.def.dimension, "Carriers"],
    ...result.rows.map((r) => [r.label, r.value]),
  ];
}

export function reportCount(org: Org): number {
  return get<{ n: number }>("SELECT COUNT(*) AS n FROM carriers WHERE organization_id = ?", [org.id])!.n;
}
