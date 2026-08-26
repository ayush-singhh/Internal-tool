/** Translates the carrier-list URL into typed filters. One parser shared by every
 *  preset view, the export endpoint and the filter bar, so they can never disagree. */

import { parseSort, type CarrierFilters, type ListOptions } from "./carrier-types.ts";
import { type ColumnKey } from "./columns.ts";

export type RawParams = Record<string, string | string[] | undefined>;

/** URL parameter name → the filter it drives. Also used to render filter chips. */
export const FILTER_PARAMS = {
  status: "status",
  dispatcher: "dispatcher",
  am: "accountManager",
  source: "leadSource",
  otype: "onboardingType",
  trailer: "trailerType",
  pricing: "pricingType",
  agreement: "agreementStatus",
  sub: "subscription",
  invoice: "invoiceMode",
  plan: "plan",
} as const satisfies Record<string, keyof CarrierFilters>;

export type FilterParam = keyof typeof FILTER_PARAMS;

function one(p: RawParams, key: string): string | undefined {
  const v = p[key];
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.trim() !== "" ? s.trim() : undefined;
}

function ids(p: RawParams, key: string): number[] | undefined {
  const raw = one(p, key);
  if (!raw) return undefined;
  const list = raw
    .split(",")
    .map((n) => Number.parseInt(n, 10))
    .filter((n) => Number.isInteger(n) && n > 0);
  return list.length ? list : undefined;
}

/** Only accepts `YYYY-MM-DD`; anything else is ignored rather than passed to SQL. */
function date(p: RawParams, key: string): string | undefined {
  const raw = one(p, key);
  return raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
}

export function parseFilters(p: RawParams, group?: CarrierFilters["group"]): CarrierFilters {
  const f: CarrierFilters = {
    q: one(p, "q"),
    onboardedFrom: date(p, "from"),
    onboardedTo: date(p, "to"),
    firstLoadFrom: date(p, "flfrom"),
    firstLoadTo: date(p, "flto"),
    group,
  };
  for (const [param, field] of Object.entries(FILTER_PARAMS)) {
    const value = ids(p, param);
    if (value) (f[field] as number[]) = value;
  }
  return f;
}

export function parseListOptions(p: RawParams): ListOptions {
  const page = Number.parseInt(one(p, "page") ?? "1", 10);
  const size = Number.parseInt(one(p, "size") ?? "50", 10);
  return {
    sort: parseSort(one(p, "sort")),
    dir: one(p, "dir") === "desc" ? "desc" : "asc",
    page: Number.isInteger(page) && page > 0 ? page : 1,
    pageSize: Number.isInteger(size) && size > 0 ? size : 50,
  };
}

/** True when anything beyond the preset group is narrowing the list. */
export function hasActiveFilters(f: CarrierFilters): boolean {
  return Boolean(
    f.q || f.onboardedFrom || f.onboardedTo || f.firstLoadFrom || f.firstLoadTo ||
    Object.values(FILTER_PARAMS).some((field) => (f[field] as number[] | undefined)?.length),
  );
}

export function countActiveFilters(f: CarrierFilters): number {
  let n = 0;
  if (f.q) n++;
  if (f.onboardedFrom || f.onboardedTo) n++;
  if (f.firstLoadFrom || f.firstLoadTo) n++;
  for (const field of Object.values(FILTER_PARAMS)) {
    n += (f[field] as number[] | undefined)?.length ?? 0;
  }
  return n;
}

/** Rebuild the current URL with some params replaced. `null` removes a param. */
export function buildQuery(
  current: RawParams,
  changes: Record<string, string | null>,
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(current)) {
    const s = Array.isArray(v) ? v[0] : v;
    if (s) sp.set(k, s);
  }
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) sp.delete(k);
    else sp.set(k, v);
  }
  // A filter change must reset paging, or the user lands on an empty page 7.
  if (Object.keys(changes).some((k) => k !== "page")) sp.delete("page");
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export type { ColumnKey };
