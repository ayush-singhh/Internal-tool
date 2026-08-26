import "server-only";
import { all, get } from "./db.ts";
import { loadLookups, idsOf } from "./lookups.ts";
import { STATUS, OFFBOARDING_STATUSES, type Tone } from "./constants.ts";
import type { CarrierRow, CarrierFilters, ListOptions, SortKey } from "./carrier-types.ts";

export type { CarrierRow, CarrierFilters, ListOptions, SortKey };
export { SORT_KEYS, parseSort } from "./carrier-types.ts";

/**
 * Sortable columns, allow-listed. `ORDER BY` is the one place SQL cannot use a bound
 * parameter, so nothing reaches it that is not a key of this object.
 */
const SORT_SQL: Record<SortKey, string> = {
  legal_name: "c.legal_name",
  owner_name: "c.owner_name",
  status: "ls.sort",
  dispatcher: "ud.name",
  account_manager: "ua.name",
  mc_number: "CAST(c.mc_number AS INTEGER)",
  usdot: "CAST(c.usdot AS INTEGER)",
  truck_count: "c.truck_count",
  onboarding_date: "c.onboarding_date",
  first_load_date: "c.first_load_date",
  born_date: "c.born_date",
  percentage: "c.percentage",
  rate: "c.rate",
  plan: "lp.label",
  created_at: "c.created_at",
  updated_at: "c.updated_at",
};

const SELECT = `
  SELECT c.*, ud.name AS dispatcher_name, ua.name AS account_manager_name,
         o.offboarded_on AS offboarded_on
    FROM carriers c
    LEFT JOIN lookups ls ON ls.id = c.status_id
    LEFT JOIN lookups lp ON lp.id = c.plan_id
    LEFT JOIN users   ud ON ud.id = c.dispatcher_id
    LEFT JOIN users   ua ON ua.id = c.account_manager_id
    LEFT JOIN offboarding_records o ON o.carrier_id = c.id`;

function buildWhere(f: CarrierFilters): { sql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  const inList = (column: string, ids?: number[]) => {
    if (!ids || ids.length === 0) return;
    clauses.push(`${column} IN (${ids.map(() => "?").join(",")})`);
    params.push(...ids);
  };

  if (f.group) {
    const groupIds =
      f.group === "active"
        ? idsOf("status", [STATUS.ACTIVE])
        : f.group === "onboarding"
          ? idsOf("status", [STATUS.ABOUT_TO_BE_ACTIVE])
          : f.group === "investigations"
            ? idsOf("status", [STATUS.PENDING_INVESTIGATION])
            : idsOf("status", OFFBOARDING_STATUSES);
    // An empty group would silently match everything — force zero rows instead.
    if (groupIds.length === 0) clauses.push("1 = 0");
    else inList("c.status_id", groupIds);
  }

  inList("c.status_id", f.status);
  inList("c.dispatcher_id", f.dispatcher);
  inList("c.account_manager_id", f.accountManager);
  inList("c.lead_source_id", f.leadSource);
  inList("c.onboarding_type_id", f.onboardingType);
  inList("c.trailer_type_id", f.trailerType);
  inList("c.pricing_type_id", f.pricingType);
  inList("c.agreement_status_id", f.agreementStatus);
  inList("c.subscription_id", f.subscription);
  inList("c.invoice_mode_id", f.invoiceMode);
  inList("c.plan_id", f.plan);

  const range = (column: string, from?: string, to?: string) => {
    if (from) { clauses.push(`${column} >= ?`); params.push(from); }
    if (to)   { clauses.push(`${column} <= ?`); params.push(to); }
  };
  range("c.onboarding_date", f.onboardedFrom, f.onboardedTo);
  range("c.first_load_date", f.firstLoadFrom, f.firstLoadTo);

  const q = f.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const digits = q.replace(/\D/g, "");
    const fields = [
      "c.legal_name", "c.owner_name", "c.email", "c.address",
      "c.mc_number", "c.usdot", "c.serial", "c.phone",
    ];
    const ors = fields.map((f2) => `${f2} LIKE ? ESCAPE '\\'`);
    params.push(...fields.map(() => like));
    // Typed digits also match a formatted stored number, and vice versa.
    if (digits.length >= 3) {
      ors.push("c.phone_digits LIKE ?");
      params.push(`%${digits}%`);
    }
    clauses.push(`(${ors.join(" OR ")})`);
  }

  return { sql: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}

export function listCarriers(
  filters: CarrierFilters = {},
  opts: ListOptions = {},
): { rows: CarrierRow[]; total: number; page: number; pageSize: number; pages: number } {
  const { sql: where, params } = buildWhere(filters);

  const total = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM carriers c
       LEFT JOIN lookups ls ON ls.id = c.status_id
       LEFT JOIN lookups lp ON lp.id = c.plan_id
       LEFT JOIN users ud ON ud.id = c.dispatcher_id
       LEFT JOIN users ua ON ua.id = c.account_manager_id
       LEFT JOIN offboarding_records o ON o.carrier_id = c.id ${where}`,
    params,
  )!.n;

  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(opts.page ?? 1, 1), pages);

  const sortKey: SortKey = opts.sort ?? "legal_name";
  const dir = opts.dir === "desc" ? "DESC" : "ASC";
  // NULLs always sink to the bottom regardless of direction — an empty cell is never
  // the most interesting row.
  const order = `${SORT_SQL[sortKey]} IS NULL, ${SORT_SQL[sortKey]} COLLATE NOCASE ${dir}, c.id ASC`;

  const rows = all<CarrierRow>(
    `${SELECT} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );

  return { rows, total, page, pageSize, pages };
}

export function getCarrier(id: number): CarrierRow | undefined {
  return get<CarrierRow>(`${SELECT} WHERE c.id = ?`, [id]);
}

/** Duplicate detection. Compared on digits so formatting differences never hide a match. */
export function findDuplicates(
  mc: string | null,
  usdot: string | null,
  excludeId?: number,
): { mc: CarrierRow[]; usdot: CarrierRow[] } {
  const clean = (v: string | null) => (v ?? "").replace(/\D/g, "");
  const mcD = clean(mc);
  const dotD = clean(usdot);
  const exclude = excludeId ? "AND c.id != ?" : "";
  const tail = excludeId ? [excludeId] : [];

  return {
    mc: mcD
      ? all<CarrierRow>(`${SELECT} WHERE c.mc_number = ? ${exclude}`, [mcD, ...tail])
      : [],
    usdot: dotD
      ? all<CarrierRow>(`${SELECT} WHERE c.usdot = ? ${exclude}`, [dotD, ...tail])
      : [],
  };
}

/** Everything a table cell or profile field needs, resolved from the lookup cache. */
export function decorate(row: CarrierRow) {
  const L = loadLookups().byId;
  const l = (id: number | null) => (id == null ? undefined : L.get(id));
  return {
    status: l(row.status_id),
    statusTone: (l(row.status_id)?.tone ?? null) as Tone | null,
    trailerType: l(row.trailer_type_id),
    onboardingType: l(row.onboarding_type_id),
    leadSource: l(row.lead_source_id),
    plan: l(row.plan_id),
    pricingType: l(row.pricing_type_id),
    billingFrequency: l(row.billing_frequency_id),
    subscription: l(row.subscription_id),
    agreementStatus: l(row.agreement_status_id),
    invoiceMode: l(row.invoice_mode_id),
  };
}

export type DecoratedCarrier = CarrierRow & { d: ReturnType<typeof decorate> };

export function withLookups(rows: CarrierRow[]): DecoratedCarrier[] {
  return rows.map((r) => ({ ...r, d: decorate(r) }));
}

export function reviewFlags(row: Pick<CarrierRow, "review_flags">): string[] {
  if (!row.review_flags) return [];
  try {
    const parsed: unknown = JSON.parse(row.review_flags);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
