/** Import target fields and header auto-mapping. Pure — the mapping UI runs in the
 *  browser, so this must not pull in the database layer. */

import type { LookupKind } from "./constants.ts";

/** A destination field the importer can map a spreadsheet column onto. */
export type TargetField = {
  key: string;
  label: string;
  /** Lookup vocabulary to resolve free text against, if any. */
  kind?: LookupKind;
  /** Resolve against team members instead of a lookup vocabulary. */
  user?: boolean;
  /** Header names that should auto-map to this field. */
  aliases: string[];
};

export const TARGETS: TargetField[] = [
  { key: "serial",              label: "Carrier ID / Serial",     aliases: ["carrier id", "serial", "serial number", "sr", "sr no", "s no", "id", "#"] },
  { key: "legal_name",          label: "Lead Legal Name",         aliases: ["legal name", "lead legal name", "carrier name", "company", "company name", "name", "carrier"] },
  { key: "owner_name",          label: "Owner Name",              aliases: ["owner", "owner name", "contact", "contact name"] },
  { key: "phone",               label: "Phone Number",            aliases: ["phone", "phone number", "contact number", "mobile", "cell", "tel"] },
  { key: "email",               label: "Email",                   aliases: ["email", "email address", "e-mail", "mail"] },
  { key: "address",             label: "Address",                 aliases: ["address", "location", "city", "full address"] },
  { key: "status",              label: "Status",                  kind: "status",            aliases: ["status", "carrier status", "current status"] },
  { key: "dispatcher",          label: "Assigned Dispatcher",     user: true,                aliases: ["dispatcher", "assigned dispatcher", "dispatch", "agent"] },
  { key: "account_manager",     label: "Account Manager",         user: true,                aliases: ["account manager", "am", "manager", "acc manager"] },
  { key: "mc_number",           label: "MC Number",               aliases: ["mc", "mc number", "mc#", "mc no", "motor carrier"] },
  { key: "usdot",               label: "USDOT",                   aliases: ["usdot", "dot", "us dot", "dot number", "usdot number"] },
  { key: "trailer_type",        label: "Trailer Type",            kind: "trailer_type",      aliases: ["trailer type", "equipment", "trailer", "equipment type"] },
  { key: "trailer_size",        label: "Trailer Size",            aliases: ["trailer size", "size", "length"] },
  { key: "truck_count",         label: "Number of Trucks",        aliases: ["trucks", "number of trucks", "no of trucks", "truck count", "units", "fleet size", "trailers"] },
  { key: "born_date",           label: "Carrier Born Date",       aliases: ["carrier born date", "born date", "authority date", "mc date"] },
  { key: "onboarding_date",     label: "Onboarding Date",         aliases: ["onboarding date", "onboarded", "join date", "start date", "date onboarded"] },
  { key: "onboarding_type",     label: "Onboarding Type",         kind: "onboarding_type",   aliases: ["onboarding type", "type of onboarding"] },
  { key: "lead_source",         label: "Source of Lead",          kind: "lead_source",       aliases: ["source", "lead source", "source of lead", "channel"] },
  { key: "first_load_date",     label: "First Load Date",         aliases: ["first load", "first load date", "first dispatch"] },
  { key: "insurance_expires_on", label: "Insurance Expires On",   aliases: ["insurance", "insurance expiry", "insurance expiration", "coi expiry", "coi expiration", "cert expiry", "insurance expires", "policy expiry"] },
  { key: "insurance_provider",  label: "Insurance Provider",      aliases: ["insurer", "insurance company", "insurance carrier", "coi provider", "policy provider"] },
  { key: "plan",                label: "Plan Offered",            kind: "plan",              aliases: ["plan", "plan offered", "package"] },
  { key: "pricing_type",        label: "Pricing Type",            kind: "pricing_type",      aliases: ["pricing type", "pricing", "billing type"] },
  { key: "rate",                label: "Rate",                    aliases: ["rate", "fee", "amount", "monthly", "weekly rate"] },
  { key: "percentage",          label: "Percentage",              aliases: ["percentage", "percent", "%", "commission", "pct"] },
  { key: "billing_frequency",   label: "Billing Frequency",       kind: "billing_frequency", aliases: ["billing frequency", "frequency", "billing cycle"] },
  { key: "subscription",        label: "Subscription",            kind: "subscription",      aliases: ["subscription", "subscription status"] },
  { key: "agreement_status",    label: "Agreement Status",        kind: "agreement_status",  aliases: ["agreement", "agreement status", "contract", "contract status"] },
  { key: "invoice_mode",        label: "Invoice Collection Mode", kind: "invoice_mode",      aliases: ["invoice", "invoice mode", "invoice collection", "collection mode", "payment method"] },
];

export const TARGET_MAP = new Map(TARGETS.map((t) => [t.key, t]));

export const normalize = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9%#]+/g, " ").trim();

/** Best-guess mapping from spreadsheet headers to fields. Exact alias first, then prefix. */
export function suggestMapping(headers: string[]): Record<number, string> {
  const mapping: Record<number, string> = {};
  const taken = new Set<string>();

  const claim = (index: number, key: string) => {
    if (taken.has(key)) return false;
    mapping[index] = key;
    taken.add(key);
    return true;
  };

  headers.forEach((header, i) => {
    const h = normalize(header);
    if (!h) return;
    const exact = TARGETS.find((t) => t.aliases.includes(h) || normalize(t.label) === h);
    if (exact) claim(i, exact.key);
  });

  headers.forEach((header, i) => {
    if (mapping[i]) return;
    const h = normalize(header);
    if (!h) return;
    const partial = TARGETS.find((t) =>
      t.aliases.some((a) => h.startsWith(a) || a.startsWith(h)),
    );
    if (partial) claim(i, partial.key);
  });

  return mapping;
}

