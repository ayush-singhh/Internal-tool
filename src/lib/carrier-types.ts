/** Carrier shapes and the sort allow-list. Pure — no database, no `server-only`, so
 *  Client Components can import it without dragging the query layer into the bundle. */

export type CarrierRow = {
  id: number;
  serial: string | null;
  legal_name: string;
  owner_name: string | null;
  phone: string | null;
  phone_digits: string | null;
  email: string | null;
  address: string | null;
  status_id: number | null;
  dispatcher_id: number | null;
  account_manager_id: number | null;
  mc_number: string | null;
  usdot: string | null;
  trailer_type_id: number | null;
  trailer_size: string | null;
  truck_count: number | null;
  born_date: string | null;
  onboarding_date: string | null;
  first_load_date: string | null;
  onboarding_type_id: number | null;
  lead_source_id: number | null;
  plan_id: number | null;
  pricing_type_id: number | null;
  rate: number | null;
  percentage: number | null;
  billing_frequency_id: number | null;
  subscription_id: number | null;
  agreement_status_id: number | null;
  invoice_mode_id: number | null;
  status_changed_at: string | null;
  review_flags: string | null;
  created_at: string;
  updated_at: string;
  dispatcher_name: string | null;
  account_manager_name: string | null;
  offboarded_on: string | null;
};

export type CarrierFilters = {
  q?: string;
  status?: number[];
  dispatcher?: number[];
  accountManager?: number[];
  leadSource?: number[];
  onboardingType?: number[];
  trailerType?: number[];
  pricingType?: number[];
  agreementStatus?: number[];
  subscription?: number[];
  invoiceMode?: number[];
  plan?: number[];
  onboardedFrom?: string;
  onboardedTo?: string;
  firstLoadFrom?: string;
  firstLoadTo?: string;
  group?: "active" | "onboarding" | "offboarded" | "investigations";
};

export type ListOptions = {
  sort?: SortKey;
  dir?: "asc" | "desc";
  page?: number;
  pageSize?: number;
};

/** The only values `ORDER BY` will ever accept. The SQL each maps to lives in
 *  `carriers.ts` so no SQL text is shipped to the browser. */
export const SORT_KEYS = [
  "legal_name", "owner_name", "status", "dispatcher", "account_manager",
  "mc_number", "usdot", "truck_count", "onboarding_date", "first_load_date",
  "born_date", "percentage", "rate", "plan", "created_at", "updated_at",
] as const;

export type SortKey = (typeof SORT_KEYS)[number];

const SORT_SET = new Set<string>(SORT_KEYS);

/** Boundary parser: anything arriving from a URL becomes a known key or the default. */
export function parseSort(raw: string | undefined | null): SortKey {
  return raw && SORT_SET.has(raw) ? (raw as SortKey) : "legal_name";
}
