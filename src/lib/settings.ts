import "server-only";
import { all, run, transaction } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import { DEFAULT_SETTINGS } from "./constants.ts";

export type SettingDef = {
  key: string;
  label: string;
  help: string;
  type: "number" | "text";
  min?: number;
  max?: number;
};

export const SETTING_DEFS: SettingDef[] = [
  { key: "company_name", label: "Company name", help: "Shown in exports and page titles.", type: "text" },
  { key: "about_to_be_active_days", label: "About to be active — overdue after", help: "Days a carrier may sit in About to Be Active before it reaches Needs Attention.", type: "number", min: 1, max: 365 },
  { key: "missing_first_load_days", label: "Missing first load — overdue after", help: "Days after onboarding without a first load before an active carrier is flagged.", type: "number", min: 1, max: 365 },
  { key: "investigation_stale_days", label: "Investigation — stale after", help: "Days a carrier may stay under investigation before it is escalated.", type: "number", min: 1, max: 365 },
  { key: "insurance_expiry_days", label: "Insurance — warn before expiry", help: "Days ahead of a certificate of insurance expiring that the carrier reaches Needs Attention.", type: "number", min: 1, max: 365 },
];

export type SettingsResult = { ok: true } | { ok: false; errors: Record<string, string> };

export function saveSettings(org: Org, values: Record<string, string>): SettingsResult {
  const errors: Record<string, string> = {};
  const clean: Record<string, string> = {};

  for (const def of SETTING_DEFS) {
    const raw = values[def.key];
    if (raw === undefined) continue;
    const value = raw.trim();

    if (def.type === "number") {
      const n = Number(value);
      if (!Number.isInteger(n)) { errors[def.key] = "Enter a whole number of days."; continue; }
      if (def.min !== undefined && n < def.min) { errors[def.key] = `Must be at least ${def.min}.`; continue; }
      if (def.max !== undefined && n > def.max) { errors[def.key] = `Must be at most ${def.max}.`; continue; }
      clean[def.key] = String(n);
    } else {
      if (!value) { errors[def.key] = "This cannot be empty."; continue; }
      clean[def.key] = value.slice(0, 120);
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  transaction(() => {
    for (const [key, value] of Object.entries(clean)) {
      run(
        `INSERT INTO app_settings (organization_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT (organization_id, key) DO UPDATE SET value = excluded.value`,
        [org.id, key, value],
      );
    }
  });
  return { ok: true };
}

export function resetSettings(org: Org): void {
  transaction(() => {
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      run(
        `INSERT INTO app_settings (organization_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT (organization_id, key) DO UPDATE SET value = excluded.value`,
        [org.id, key, value],
      );
    }
  });
}

export type LookupUsage = {
  id: number;
  kind: string;
  value: string;
  label: string;
  sort: number;
  active: number;
  usage: number;
};

/** Vocabulary values with how many carriers use each — so nothing is retired blindly. */
export function lookupUsage(org: Org): LookupUsage[] {
  const COLUMN: Record<string, string> = {
    status: "status_id", trailer_type: "trailer_type_id", onboarding_type: "onboarding_type_id",
    lead_source: "lead_source_id", plan: "plan_id", pricing_type: "pricing_type_id",
    billing_frequency: "billing_frequency_id", subscription: "subscription_id",
    agreement_status: "agreement_status_id", invoice_mode: "invoice_mode_id",
  };

  const rows = all<Omit<LookupUsage, "usage">>(
    "SELECT id, kind, value, label, sort, active FROM lookups WHERE organization_id = ? ORDER BY kind, sort, label",
    [org.id],
  );

  return rows.map((row) => {
    const column = COLUMN[row.kind];
    const usage = column
      ? all<{ n: number }>(
          `SELECT COUNT(*) AS n FROM carriers WHERE organization_id = ? AND ${column} = ?`,
          [org.id, row.id],
        )[0]!.n
      : 0;
    return { ...row, usage };
  });
}

/** Retiring hides a value from new records without touching carriers already using it. */
export function setLookupActive(org: Org, id: number, active: boolean): void {
  run("UPDATE lookups SET active = ? WHERE organization_id = ? AND id = ?", [active ? 1 : 0, org.id, id]);
}
