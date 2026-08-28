import "server-only";
import { all, get } from "./db.ts";
import { idsOf, idOf } from "./lookups.ts";
import { STATUS, OFFBOARDING_STATUSES } from "./constants.ts";
import type { Tone } from "./constants.ts";

export type Slice = { label: string; value: number; tone?: Tone | null; href?: string };

/** The eleven headline numbers, all read live from the database. */
export function dashboardMetrics() {
  const statusCount = (value: string) => {
    const id = idOf("status", value);
    return id === undefined
      ? 0
      : get<{ n: number }>("SELECT COUNT(*) AS n FROM carriers WHERE status_id = ?", [id])!.n;
  };

  const month = new Date().toISOString().slice(0, 7);

  return {
    total: get<{ n: number }>("SELECT COUNT(*) AS n FROM carriers")!.n,
    active: statusCount(STATUS.ACTIVE),
    aboutToBeActive: statusCount(STATUS.ABOUT_TO_BE_ACTIVE),
    pendingInvestigation: statusCount(STATUS.PENDING_INVESTIGATION),
    inactive: statusCount(STATUS.INACTIVE),
    suspended: statusCount(STATUS.SUSPENDED),
    blacklisted: statusCount(STATUS.BLACKLISTED),
    backOff: statusCount(STATUS.BACK_OFF),
    trucks:
      get<{ n: number }>("SELECT COALESCE(SUM(truck_count), 0) AS n FROM carriers")!.n,
    newThisMonth: get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM carriers WHERE substr(onboarding_date, 1, 7) = ?",
      [month],
    )!.n,
    offboardedThisMonth: get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM offboarding_records WHERE substr(offboarded_on, 1, 7) = ?",
      [month],
    )!.n,
  };
}

export type DashboardMetrics = ReturnType<typeof dashboardMetrics>;

/** Grouped counts against a lookup-backed column, in the vocabulary's own order. */
function byLookup(column: string, param: string): Slice[] {
  return all<{ label: string; tone: Tone | null; id: number; n: number }>(
    `SELECT l.label AS label, l.tone AS tone, l.id AS id, COUNT(c.id) AS n
       FROM lookups l
       JOIN carriers c ON c.${column} = l.id
      GROUP BY l.id
      ORDER BY n DESC, l.sort`,
  ).map((r) => ({
    label: r.label,
    value: r.n,
    tone: r.tone,
    href: `/carriers?${param}=${r.id}`,
  }));
}

function byUser(column: string, param: string): Slice[] {
  const rows = all<{ label: string; id: number; n: number }>(
    `SELECT u.name AS label, u.id AS id, COUNT(c.id) AS n
       FROM users u
       JOIN carriers c ON c.${column} = u.id
      GROUP BY u.id
      ORDER BY n DESC, u.name`,
  ).map((r) => ({ label: r.label, value: r.n, href: `/carriers?${param}=${r.id}` }));

  const unassigned = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM carriers WHERE ${column} IS NULL`,
  )!.n;
  return unassigned > 0
    ? [...rows, { label: "Unassigned", value: unassigned, tone: "slate" as Tone }]
    : rows;
}

export function carriersByStatus() { return byLookup("status_id", "status"); }
export function carriersByLeadSource() { return byLookup("lead_source_id", "source"); }
export function carriersByPlan() { return byLookup("plan_id", "plan"); }
export function carriersByPricingType() { return byLookup("pricing_type_id", "pricing"); }
export function carriersByTrailerType() { return byLookup("trailer_type_id", "trailer"); }
export function carriersByAgreement() { return byLookup("agreement_status_id", "agreement"); }
export function carriersByDispatcher() { return byUser("dispatcher_id", "dispatcher"); }
export function carriersByAccountManager() { return byUser("account_manager_id", "am"); }

/** Active carriers only — the view that matters for workload balance. */
export function activeByUser(column: "dispatcher_id" | "account_manager_id"): Slice[] {
  const activeId = idOf("status", STATUS.ACTIVE);
  if (activeId === undefined) return [];
  return all<{ label: string; n: number }>(
    `SELECT u.name AS label, COUNT(c.id) AS n
       FROM users u JOIN carriers c ON c.${column} = u.id
      WHERE c.status_id = ?
      GROUP BY u.id ORDER BY n DESC, u.name`,
    [activeId],
  ).map((r) => ({ label: r.label, value: r.n }));
}

export type TrendPoint = { month: string; value: number };

/** Last `months` calendar months, with zero-filled gaps so the line has no holes. */
function monthlySeries(rows: { month: string; n: number }[], months: number): TrendPoint[] {
  const found = new Map(rows.map((r) => [r.month, r.n]));
  const out: TrendPoint[] = [];
  const now = new Date();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const key = d.toISOString().slice(0, 7);
    out.push({ month: key, value: found.get(key) ?? 0 });
  }
  return out;
}

export function onboardingTrend(months = 12): TrendPoint[] {
  return monthlySeries(
    all<{ month: string; n: number }>(
      `SELECT substr(onboarding_date, 1, 7) AS month, COUNT(*) AS n
         FROM carriers WHERE onboarding_date IS NOT NULL
        GROUP BY month ORDER BY month`,
    ),
    months,
  );
}

export function offboardingTrend(months = 12): TrendPoint[] {
  return monthlySeries(
    all<{ month: string; n: number }>(
      `SELECT substr(offboarded_on, 1, 7) AS month, COUNT(*) AS n
         FROM offboarding_records WHERE offboarded_on IS NOT NULL
        GROUP BY month ORDER BY month`,
    ),
    months,
  );
}

/** Carriers grouped into fleet-size bands rather than one bar per exact count. */
export function carriersByFleetSize(): Slice[] {
  const bands: [label: string, min: number, max: number | null][] = [
    ["1 truck", 1, 1], ["2–5", 2, 5], ["6–10", 6, 10],
    ["11–25", 11, 25], ["26–50", 26, 50], ["51+", 51, null],
  ];
  const slices = bands.map(([label, min, max]) => ({
    label,
    value: get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM carriers WHERE truck_count >= ?${
        max === null ? "" : " AND truck_count <= ?"
      }`,
      max === null ? [min] : [min, max],
    )!.n,
  }));
  const unknown = get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM carriers WHERE truck_count IS NULL",
  )!.n;
  return unknown > 0 ? [...slices, { label: "Not recorded", value: unknown }] : slices;
}

/** Percentage bands for carriers on percentage-per-load pricing. */
export function carriersByPercentageBand(): Slice[] {
  const bands: [string, number, number][] = [
    ["Under 8%", 0, 7.99], ["8–10%", 8, 10], ["10–12%", 10.01, 12],
    ["12–15%", 12.01, 15], ["Over 15%", 15.01, 100],
  ];
  return bands.map(([label, lo, hi]) => ({
    label,
    value: get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM carriers WHERE percentage >= ? AND percentage <= ?",
      [lo, hi],
    )!.n,
  }));
}

export function offboardingReasons(): Slice[] {
  return all<{ label: string; n: number }>(
    `SELECT l.label AS label, COUNT(o.id) AS n
       FROM offboarding_records o JOIN lookups l ON l.id = o.reason_id
      GROUP BY l.id ORDER BY n DESC`,
  ).map((r) => ({ label: r.label, value: r.n }));
}

/** Share of carriers ever onboarded that have not exited. */
export function retention(): { onboarded: number; retained: number; rate: number } {
  const onboarded = get<{ n: number }>("SELECT COUNT(*) AS n FROM carriers")!.n;
  const exitIds = idsOf("status", OFFBOARDING_STATUSES);
  const exited =
    exitIds.length === 0
      ? 0
      : get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM carriers WHERE status_id IN (${exitIds.map(() => "?").join(",")})`,
          exitIds,
        )!.n;
  const retained = onboarded - exited;
  return { onboarded, retained, rate: onboarded === 0 ? 0 : retained / onboarded };
}
