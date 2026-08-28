import "server-only";
import { get, run, transaction } from "./db.ts";
import { labelOf } from "./lookups.ts";
import { recordActivity, type ActivityType } from "./activity.ts";
import type { CarrierRow } from "./carrier-types.ts";

/** Every writable column, with how a change to it should be described in history. */
type FieldMeta = { label: string; activity: ActivityType; kind?: "lookup" | "user" };

export const FIELDS = {
  serial:               { label: "Carrier ID",               activity: "field" },
  legal_name:           { label: "Legal Name",               activity: "field" },
  owner_name:           { label: "Owner",                    activity: "field" },
  phone:                { label: "Phone",                    activity: "field" },
  email:                { label: "Email",                    activity: "field" },
  address:              { label: "Address",                  activity: "field" },
  status_id:            { label: "Status",                   activity: "status",       kind: "lookup" },
  dispatcher_id:        { label: "Dispatcher",               activity: "assignment",   kind: "user" },
  account_manager_id:   { label: "Account Manager",          activity: "assignment",   kind: "user" },
  mc_number:            { label: "MC Number",                activity: "field" },
  usdot:                { label: "USDOT",                    activity: "field" },
  trailer_type_id:      { label: "Trailer Type",             activity: "field",        kind: "lookup" },
  trailer_size:         { label: "Trailer Size",             activity: "field" },
  truck_count:          { label: "Trucks / Trailers",        activity: "field" },
  born_date:            { label: "Carrier Born Date",        activity: "field" },
  onboarding_date:      { label: "Onboarding Date",          activity: "field" },
  first_load_date:      { label: "First Load Date",          activity: "field" },
  onboarding_type_id:   { label: "Onboarding Type",          activity: "field",        kind: "lookup" },
  lead_source_id:       { label: "Lead Source",              activity: "field",        kind: "lookup" },
  plan_id:              { label: "Plan",                     activity: "pricing",      kind: "lookup" },
  pricing_type_id:      { label: "Pricing Type",             activity: "pricing",      kind: "lookup" },
  rate:                 { label: "Rate",                     activity: "pricing" },
  percentage:           { label: "Percentage",               activity: "pricing" },
  billing_frequency_id: { label: "Billing Frequency",        activity: "pricing",      kind: "lookup" },
  subscription_id:      { label: "Subscription",             activity: "subscription", kind: "lookup" },
  agreement_status_id:  { label: "Agreement Status",         activity: "agreement",    kind: "lookup" },
  invoice_mode_id:      { label: "Invoice Collection Mode",  activity: "field",        kind: "lookup" },
} as const satisfies Record<string, FieldMeta>;

export type CarrierField = keyof typeof FIELDS;
export const CARRIER_FIELDS = Object.keys(FIELDS) as CarrierField[];

/** A partial patch. A key that is absent means "leave alone"; a key set to `null`
 *  means "clear this value". The two are never conflated. */
export type CarrierInput = Partial<Record<CarrierField, string | number | null>> & {
  phone_digits?: string | null;
  review_flags?: string | null;
};

function display(field: CarrierField, value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  const meta = FIELDS[field] as FieldMeta;
  if (meta.kind === "lookup") return labelOf(Number(value)) || String(value);
  if (meta.kind === "user") {
    return (
      get<{ name: string }>("SELECT name FROM users WHERE id = ?", [Number(value)])?.name ??
      String(value)
    );
  }
  return String(value);
}

export function createCarrier(input: CarrierInput, userId: number | null): number {
  const now = new Date().toISOString();
  const columns: string[] = [];
  const values: unknown[] = [];

  for (const key of Object.keys(input) as (keyof CarrierInput)[]) {
    columns.push(key);
    values.push(input[key] ?? null);
  }
  for (const [col, val] of [
    ["status_changed_at", now], ["created_at", now], ["updated_at", now],
    ["created_by", userId], ["updated_by", userId],
  ] as const) {
    if (!columns.includes(col as never)) { columns.push(col); values.push(val); }
  }

  return transaction(() => {
    run(
      `INSERT INTO carriers (${columns.join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
      values,
    );
    const id = get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
    recordActivity({
      carrierId: id,
      userId,
      type: "created",
      summary: `Carrier record created${
        input.status_id ? ` with status ${display("status_id", input.status_id)}` : ""
      }`,
    });
    return id;
  });
}

export type UpdateResult = { changed: CarrierField[] };

/**
 * Applies a patch and writes one activity entry per changed field.
 * Untouched columns are never included in the UPDATE, so an edit can never blank a
 * value the form did not carry.
 */
export function updateCarrier(
  id: number,
  input: CarrierInput,
  userId: number | null,
): UpdateResult {
  const existing = get<CarrierRow>("SELECT * FROM carriers WHERE id = ?", [id]);
  if (!existing) throw new Error("Carrier not found.");

  const changed: CarrierField[] = [];
  const sets: string[] = [];
  const values: unknown[] = [];

  for (const key of Object.keys(input) as (keyof CarrierInput)[]) {
    const next = input[key] ?? null;
    const prev = (existing as Record<string, unknown>)[key] ?? null;
    // Compare loosely on string form: SQLite hands back 12 where the form sent "12".
    if (String(prev ?? "") === String(next ?? "")) continue;
    sets.push(`${key} = ?`);
    values.push(next);
    if (key in FIELDS) changed.push(key as CarrierField);
  }

  if (sets.length === 0) return { changed: [] };

  const now = new Date().toISOString();
  if (changed.includes("status_id")) { sets.push("status_changed_at = ?"); values.push(now); }
  sets.push("updated_at = ?", "updated_by = ?");
  values.push(now, userId, id);

  transaction(() => {
    run(`UPDATE carriers SET ${sets.join(", ")} WHERE id = ?`, values);

    for (const field of changed) {
      const meta = FIELDS[field] as FieldMeta;
      const from = display(field, (existing as Record<string, unknown>)[field]);
      const to = display(field, input[field]);
      recordActivity({
        carrierId: id,
        userId,
        type: meta.activity,
        field: meta.label,
        oldValue: from,
        newValue: to,
        summary:
          meta.activity === "status"
            ? `Status changed from ${from || "none"} to ${to || "none"}`
            : `${meta.label} changed`,
        at: now,
      });
    }
  });

  return { changed };
}
