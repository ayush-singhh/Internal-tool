import "server-only";
import { all } from "./db.ts";
import { options } from "./lookups.ts";
import type { LookupKind } from "./constants.ts";
import type { CarrierInput } from "./carrier-write.ts";
import {
  checkDateOrder, choice, date, digitsOnly, email, integer, percentage,
  phone, required, str, decimal, type FieldErrors,
} from "./validate.ts";

/** Ids the form is allowed to reference, rebuilt per request from the database.
 *  Anything else in a submission is rejected rather than trusted. */
export function allowedIds() {
  const kinds: LookupKind[] = [
    "status", "trailer_type", "onboarding_type", "lead_source", "plan",
    "pricing_type", "billing_frequency", "subscription", "agreement_status",
    "invoice_mode", "offboard_reason", "offboard_category", "final_status",
  ];
  const byKind = Object.fromEntries(
    kinds.map((k) => [k, new Set(options(k).map((o) => o.id))]),
  ) as Record<LookupKind, Set<number>>;

  const users = new Set(
    all<{ id: number }>("SELECT id FROM users WHERE active = 1").map((u) => u.id),
  );
  return { ...byKind, users };
}

export type AllowedIds = ReturnType<typeof allowedIds>;

/** Field names echoed back to repopulate the form when validation fails. */
export const FORM_FIELDS = [
  "serial", "legal_name", "owner_name", "phone", "email", "address",
  "status_id", "dispatcher_id", "account_manager_id",
  "mc_number", "usdot", "trailer_type_id", "trailer_size", "truck_count",
  "born_date", "onboarding_date", "first_load_date", "onboarding_type_id", "lead_source_id",
  "plan_id", "pricing_type_id", "rate", "percentage", "billing_frequency_id",
  "subscription_id", "agreement_status_id", "invoice_mode_id", "note",
] as const;

export function echoValues(formData: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FORM_FIELDS) {
    const v = formData.get(key);
    if (typeof v === "string" && v !== "") out[key] = v;
  }
  return out;
}

/**
 * Turns a submitted form into a validated patch. Runs the same rules the importer uses,
 * so a record created by hand and one created by import are held to one standard.
 */
export function parseCarrierForm(
  formData: FormData,
  allowed: AllowedIds,
): { input: CarrierInput; errors: FieldErrors } {
  const errors: FieldErrors = {};
  const f = (name: string) => formData.get(name);

  const ph = phone(f("phone"), "phone", errors);
  const born = date(f("born_date"), "born_date", "Carrier born date", errors);
  const onboarded = date(f("onboarding_date"), "onboarding_date", "Onboarding date", errors);
  const firstLoad = date(f("first_load_date"), "first_load_date", "First load date", errors);

  checkDateOrder(born, onboarded, "onboarding_date",
    "Onboarding date cannot be before the carrier born date.", errors);
  checkDateOrder(onboarded, firstLoad, "first_load_date",
    "First load date cannot be before the onboarding date.", errors);

  const input: CarrierInput = {
    serial: str(f("serial"), 40),
    legal_name: required(f("legal_name"), "legal_name", "Legal name", errors),
    owner_name: str(f("owner_name"), 160),
    phone: ph.value,
    phone_digits: ph.digits,
    email: email(f("email"), "email", errors),
    address: str(f("address"), 400),

    status_id: choice(f("status_id"), "status_id", "Status", allowed.status, errors, true),
    dispatcher_id: choice(f("dispatcher_id"), "dispatcher_id", "Dispatcher", allowed.users, errors),
    account_manager_id: choice(
      f("account_manager_id"), "account_manager_id", "Account Manager", allowed.users, errors,
    ),

    mc_number: digitsOnly(f("mc_number"), "mc_number", "MC number", errors, 10),
    usdot: digitsOnly(f("usdot"), "usdot", "USDOT number", errors, 10),
    trailer_type_id: choice(
      f("trailer_type_id"), "trailer_type_id", "Trailer Type", allowed.trailer_type, errors,
    ),
    trailer_size: str(f("trailer_size"), 40),
    truck_count: integer(f("truck_count"), "truck_count", "Number of trucks/trailers", errors, {
      min: 0, max: 10000,
    }),

    born_date: born,
    onboarding_date: onboarded,
    first_load_date: firstLoad,
    onboarding_type_id: choice(
      f("onboarding_type_id"), "onboarding_type_id", "Onboarding Type",
      allowed.onboarding_type, errors,
    ),
    lead_source_id: choice(
      f("lead_source_id"), "lead_source_id", "Lead Source", allowed.lead_source, errors,
    ),

    plan_id: choice(f("plan_id"), "plan_id", "Plan", allowed.plan, errors),
    pricing_type_id: choice(
      f("pricing_type_id"), "pricing_type_id", "Pricing Type", allowed.pricing_type, errors,
    ),
    rate: decimal(f("rate"), "rate", "Rate", errors, { min: 0, max: 1_000_000 }),
    percentage: percentage(f("percentage"), "percentage", errors),
    billing_frequency_id: choice(
      f("billing_frequency_id"), "billing_frequency_id", "Billing Frequency",
      allowed.billing_frequency, errors,
    ),
    subscription_id: choice(
      f("subscription_id"), "subscription_id", "Subscription", allowed.subscription, errors,
    ),
    agreement_status_id: choice(
      f("agreement_status_id"), "agreement_status_id", "Agreement Status",
      allowed.agreement_status, errors,
    ),
    invoice_mode_id: choice(
      f("invoice_mode_id"), "invoice_mode_id", "Invoice Collection Mode",
      allowed.invoice_mode, errors,
    ),
  };

  return { input, errors };
}
