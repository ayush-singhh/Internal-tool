/** Column metadata for the carrier table, the column picker and CSV export.
 *  Pure data — safe to import from Client Components. */

import type { SortKey } from "./carrier-types.ts";

export type ColumnKey =
  | "serial" | "legal_name" | "owner_name" | "status" | "dispatcher" | "account_manager"
  | "phone" | "email" | "address"
  | "mc_number" | "usdot" | "trailer_type" | "trailer_size" | "truck_count"
  | "born_date" | "onboarding_date" | "onboarding_type" | "lead_source" | "first_load_date"
  | "plan" | "pricing_type" | "pricing" | "percentage" | "rate"
  | "subscription" | "agreement_status" | "invoice_mode" | "updated_at";

export type ColumnDef = {
  key: ColumnKey;
  label: string;
  group: "Identity" | "Contact" | "Regulatory & Equipment" | "Onboarding" | "Commercial" | "Record";
  sort?: SortKey;
  align?: "right";
  /** Shown when the user has never chosen their own column set. */
  default?: boolean;
  /** Always visible — the row needs something to click. */
  locked?: boolean;
};

export const COLUMNS: ColumnDef[] = [
  { key: "serial",          label: "ID",              group: "Identity",  default: true },
  { key: "legal_name",      label: "Legal Name",      group: "Identity",  sort: "legal_name", default: true, locked: true },
  { key: "owner_name",      label: "Owner",           group: "Identity",  sort: "owner_name", default: true },
  { key: "status",          label: "Status",          group: "Identity",  sort: "status",     default: true },
  { key: "dispatcher",      label: "Dispatcher",      group: "Identity",  sort: "dispatcher", default: true },
  { key: "account_manager", label: "Account Manager", group: "Identity",  sort: "account_manager", default: true },

  { key: "phone",           label: "Phone",           group: "Contact",   default: true },
  { key: "email",           label: "Email",           group: "Contact" },
  { key: "address",         label: "Address",         group: "Contact" },

  { key: "mc_number",       label: "MC #",            group: "Regulatory & Equipment", sort: "mc_number", default: true },
  { key: "usdot",           label: "USDOT",           group: "Regulatory & Equipment", sort: "usdot" },
  { key: "trailer_type",    label: "Trailer Type",    group: "Regulatory & Equipment" },
  { key: "trailer_size",    label: "Trailer Size",    group: "Regulatory & Equipment" },
  { key: "truck_count",     label: "Trucks",          group: "Regulatory & Equipment", sort: "truck_count", align: "right", default: true },

  { key: "born_date",       label: "Carrier Born",    group: "Onboarding", sort: "born_date" },
  { key: "onboarding_date", label: "Onboarded",       group: "Onboarding", sort: "onboarding_date", default: true },
  { key: "onboarding_type", label: "Onboarding Type", group: "Onboarding" },
  { key: "lead_source",     label: "Lead Source",     group: "Onboarding" },
  { key: "first_load_date", label: "First Load",      group: "Onboarding", sort: "first_load_date" },

  { key: "plan",            label: "Plan",            group: "Commercial", sort: "plan" },
  { key: "pricing_type",    label: "Pricing Type",    group: "Commercial" },
  { key: "pricing",         label: "Pricing",         group: "Commercial", default: true },
  { key: "percentage",      label: "Percentage",      group: "Commercial", sort: "percentage", align: "right" },
  { key: "rate",            label: "Rate",            group: "Commercial", sort: "rate", align: "right" },
  { key: "subscription",    label: "Subscription",    group: "Commercial" },
  { key: "agreement_status",label: "Agreement",       group: "Commercial", default: true },
  { key: "invoice_mode",    label: "Invoice Mode",    group: "Commercial" },

  { key: "updated_at",      label: "Last Updated",    group: "Record", sort: "updated_at" },
];

export const COLUMN_MAP = new Map(COLUMNS.map((c) => [c.key, c]));

export const DEFAULT_COLUMNS: ColumnKey[] = COLUMNS.filter((c) => c.default).map((c) => c.key);

export const COLUMN_GROUPS = [...new Set(COLUMNS.map((c) => c.group))];

/** Parse a persisted column list, dropping unknown keys and forcing locked ones back in. */
export function parseColumns(raw: string | undefined | null): ColumnKey[] {
  if (!raw) return DEFAULT_COLUMNS;
  const wanted = new Set(raw.split(",").filter((k) => COLUMN_MAP.has(k as ColumnKey)));
  // A cookie that survived a rename — or was tampered with — should not leave someone
  // staring at a one-column table.
  if (wanted.size === 0) return DEFAULT_COLUMNS;
  for (const c of COLUMNS) if (c.locked) wanted.add(c.key);
  // Keep the canonical column order rather than the order they were toggled in.
  return COLUMNS.filter((c) => wanted.has(c.key)).map((c) => c.key);
}
