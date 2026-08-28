import "server-only";
import { all, get, run, transaction } from "./db.ts";
import { loadLookups } from "./lookups.ts";
import { recordActivity } from "./activity.ts";
import type { LookupKind } from "./constants.ts";
import { TARGET_MAP, normalize } from "./import-targets.ts";

export { TARGETS, TARGET_MAP, suggestMapping, type TargetField } from "./import-targets.ts";
import {
  checkDateOrder, date, decimal, digitsOnly, email as parseEmail, integer,
  percentage as parsePercentage, phone as parsePhone, str, type FieldErrors,
} from "./validate.ts";

export type RowIssue = { field: string; message: string; severity: "error" | "flag" };

export type PreviewRow = {
  index: number;
  values: Record<string, string>;
  issues: RowIssue[];
  duplicateOf: { id: number; legal_name: string; on: "MC" | "USDOT" } | null;
  /** Duplicate inside the uploaded file itself. */
  duplicateInFile: boolean;
  skip: boolean;
};

export type DuplicateMode = "skip" | "update" | "create";

/** Resolve free text against a vocabulary. Unmatched text is preserved and flagged. */
function resolveLookup(kind: LookupKind, raw: string): { id: number | null; matched: boolean } {
  const list = loadLookups().byKind.get(kind) ?? [];
  const n = normalize(raw);
  const hit =
    list.find((l) => normalize(l.label) === n) ??
    list.find((l) => normalize(l.value) === n) ??
    list.find((l) => normalize(l.label).startsWith(n) && n.length >= 3);
  return { id: hit?.id ?? null, matched: Boolean(hit) };
}

function resolveUser(raw: string): { id: number | null; matched: boolean } {
  const n = normalize(raw);
  const users = all<{ id: number; name: string }>(
    "SELECT id, name FROM users WHERE active = 1",
  );
  const hit =
    users.find((u) => normalize(u.name) === n) ??
    users.find((u) => normalize(u.name).split(" ")[0] === n) ??
    users.find((u) => normalize(u.name).startsWith(n) && n.length >= 3);
  return { id: hit?.id ?? null, matched: Boolean(hit) };
}

/** Accepts the date shapes a spreadsheet actually produces, not just ISO. */
export function parseLooseDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) {
    const [y, m, d] = s.split("-").map(Number) as [number, number, number];
    return isoIfReal(y, m, d);
  }
  // US convention: the spreadsheet this replaces is American, so M/D/Y.
  const slash = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})$/);
  if (slash) {
    const m = Number(slash[1]);
    const d = Number(slash[2]);
    let y = Number(slash[3]);
    if (y < 100) y += y < 70 ? 2000 : 1900;
    return isoIfReal(y, m, d);
  }
  const named = new Date(s);
  if (!Number.isNaN(named.getTime()) && /[a-z]{3}/i.test(s)) {
    // `new Date("Mar 4, 2025")` is LOCAL midnight. Calling toISOString() on it shifts
    // the calendar day backwards in any timezone east of UTC, so read the local
    // components and rebuild the date from those instead.
    return isoIfReal(named.getFullYear(), named.getMonth() + 1, named.getDate());
  }
  return null;
}

function isoIfReal(y: number, m: number, d: number): string | null {
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return dt.toISOString().slice(0, 10);
}

export type ParsedRow = {
  input: Record<string, unknown>;
  issues: RowIssue[];
  legalName: string | null;
  mc: string | null;
  usdot: string | null;
};

/**
 * Validates one spreadsheet row.
 *
 * An unrecognised vocabulary value is never silently corrected or dropped: the original
 * text is kept in `review_flags` and the record is flagged, so a human decides.
 * Only a missing legal name is fatal — everything else imports and gets flagged.
 */
export function parseImportRow(
  values: Record<string, string>,
): ParsedRow {
  const issues: RowIssue[] = [];
  const errors: FieldErrors = {};
  const input: Record<string, unknown> = {};
  const flags: string[] = [];

  const raw = (key: string) => (values[key] ?? "").trim();

  const legalName = str(raw("legal_name"), 255);
  if (!legalName) {
    issues.push({ field: "legal_name", message: "Legal name is required.", severity: "error" });
  }
  input.legal_name = legalName;
  input.serial = str(raw("serial"), 40);
  input.owner_name = str(raw("owner_name"), 160);
  input.address = str(raw("address"), 400);
  input.trailer_size = str(raw("trailer_size"), 40);

  const ph = parsePhone(raw("phone"), "phone", errors);
  input.phone = ph.value;
  input.phone_digits = ph.digits;
  if (errors.phone) {
    flags.push(`Phone kept as entered: "${raw("phone")}" (${errors.phone})`);
    delete errors.phone;
  }

  const emailErrors: FieldErrors = {};
  const email = parseEmail(raw("email"), "email", emailErrors);
  if (emailErrors.email) {
    input.email = null;
    flags.push(`Email not recognised and not imported: "${raw("email")}"`);
  } else {
    input.email = email;
  }

  for (const [key, label, max] of [
    ["mc_number", "MC number", 10],
    ["usdot", "USDOT number", 10],
  ] as const) {
    const fieldErrors: FieldErrors = {};
    const value = digitsOnly(raw(key), key, label, fieldErrors, max);
    if (fieldErrors[key]) {
      input[key] = null;
      flags.push(`${label} not numeric, not imported: "${raw(key)}"`);
    } else {
      input[key] = value;
    }
  }

  const countErrors: FieldErrors = {};
  input.truck_count = integer(raw("truck_count"), "truck_count", "Trucks", countErrors, {
    min: 0, max: 10000,
  });
  if (countErrors.truck_count) {
    input.truck_count = null;
    flags.push(`Truck count not numeric: "${raw("truck_count")}"`);
  }

  const rateErrors: FieldErrors = {};
  input.rate = decimal(raw("rate"), "rate", "Rate", rateErrors, { min: 0 });
  if (rateErrors.rate) {
    input.rate = null;
    flags.push(`Rate not numeric: "${raw("rate")}"`);
  }

  const pctErrors: FieldErrors = {};
  input.percentage = parsePercentage(raw("percentage"), "percentage", pctErrors);
  if (pctErrors.percentage) {
    input.percentage = null;
    flags.push(`Percentage kept out of range: "${raw("percentage")}" (${pctErrors.percentage})`);
  }

  for (const key of ["born_date", "onboarding_date", "first_load_date"] as const) {
    const text = raw(key);
    if (!text) { input[key] = null; continue; }
    const iso = parseLooseDate(text);
    if (iso === null) {
      input[key] = null;
      flags.push(`Date not understood, not imported: ${key.replace(/_/g, " ")} "${text}"`);
    } else {
      input[key] = iso;
    }
  }

  const orderErrors: FieldErrors = {};
  checkDateOrder(
    input.onboarding_date as string | null, input.first_load_date as string | null,
    "first_load_date", "First load date precedes the onboarding date.", orderErrors,
  );
  if (orderErrors.first_load_date) flags.push(orderErrors.first_load_date);

  const lookupFields: [key: string, column: string, kind: LookupKind][] = [
    ["status", "status_id", "status"],
    ["trailer_type", "trailer_type_id", "trailer_type"],
    ["onboarding_type", "onboarding_type_id", "onboarding_type"],
    ["lead_source", "lead_source_id", "lead_source"],
    ["plan", "plan_id", "plan"],
    ["pricing_type", "pricing_type_id", "pricing_type"],
    ["billing_frequency", "billing_frequency_id", "billing_frequency"],
    ["subscription", "subscription_id", "subscription"],
    ["agreement_status", "agreement_status_id", "agreement_status"],
    ["invoice_mode", "invoice_mode_id", "invoice_mode"],
  ];
  for (const [key, column, kind] of lookupFields) {
    const text = raw(key);
    if (!text) { input[column] = null; continue; }
    const { id, matched } = resolveLookup(kind, text);
    input[column] = id;
    if (!matched) {
      flags.push(`${TARGET_MAP.get(key)?.label ?? key} "${text}" did not match a known option`);
    }
  }

  for (const [key, column] of [["dispatcher", "dispatcher_id"], ["account_manager", "account_manager_id"]] as const) {
    const text = raw(key);
    if (!text) { input[column] = null; continue; }
    const { id, matched } = resolveUser(text);
    input[column] = id;
    if (!matched) {
      flags.push(`${TARGET_MAP.get(key)?.label ?? key} "${text}" did not match a team member`);
    }
  }

  for (const flag of flags) {
    issues.push({ field: "", message: flag, severity: "flag" });
  }
  input.review_flags = flags.length > 0 ? JSON.stringify(flags) : null;

  return {
    input,
    issues,
    legalName,
    mc: (input.mc_number as string | null) ?? null,
    usdot: (input.usdot as string | null) ?? null,
  };
}

export type ImportSummary = {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  flagged: number;
};

/**
 * Commits an import inside a single transaction: either the whole file lands or none
 * of it does. Existing records are only ever updated when the user explicitly chose
 * "update", and even then only the columns the spreadsheet actually carried.
 */
export function commitImport(
  rows: Record<string, string>[],
  mode: DuplicateMode,
  userId: number | null,
): ImportSummary {
  const summary: ImportSummary = { created: 0, updated: 0, skipped: 0, failed: 0, flagged: 0 };
  const now = new Date().toISOString();

  transaction(() => {
    for (const values of rows) {
      const parsed = parseImportRow(values);
      if (parsed.issues.some((i) => i.severity === "error")) {
        summary.failed++;
        continue;
      }

      const existing = findExisting(parsed.mc, parsed.usdot);

      if (existing && mode === "skip") { summary.skipped++; continue; }

      if (existing && mode === "update") {
        const sets: string[] = [];
        const params: unknown[] = [];
        for (const [column, value] of Object.entries(parsed.input)) {
          // Only overwrite with something the spreadsheet actually provided —
          // an empty cell never erases data already on file.
          if (value === null || value === undefined || value === "") continue;
          sets.push(`${column} = ?`);
          params.push(value);
        }
        if (sets.length > 0) {
          sets.push("updated_at = ?", "updated_by = ?");
          params.push(now, userId, existing.id);
          run(`UPDATE carriers SET ${sets.join(", ")} WHERE id = ?`, params);
        }
        recordActivity({
          carrierId: existing.id, userId, type: "import",
          summary: "Record updated from a spreadsheet import", at: now,
        });
        summary.updated++;
        if (parsed.input.review_flags) summary.flagged++;
        continue;
      }

      const columns = Object.keys(parsed.input);
      const values2 = columns.map((c) => parsed.input[c] ?? null);
      columns.push("status_changed_at", "created_at", "updated_at", "created_by", "updated_by");
      values2.push(now, now, now, userId, userId);

      run(
        `INSERT INTO carriers (${columns.join(", ")})
         VALUES (${columns.map(() => "?").join(", ")})`,
        values2,
      );
      const id = get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
      recordActivity({
        carrierId: id, userId, type: "import",
        summary: "Carrier created from a spreadsheet import", at: now,
      });
      summary.created++;
      if (parsed.input.review_flags) summary.flagged++;
    }
  });

  return summary;
}

export function findExisting(
  mc: string | null,
  usdot: string | null,
): { id: number; legal_name: string; on: "MC" | "USDOT" } | null {
  if (mc) {
    const hit = get<{ id: number; legal_name: string }>(
      "SELECT id, legal_name FROM carriers WHERE mc_number = ?", [mc],
    );
    if (hit) return { ...hit, on: "MC" };
  }
  if (usdot) {
    const hit = get<{ id: number; legal_name: string }>(
      "SELECT id, legal_name FROM carriers WHERE usdot = ?", [usdot],
    );
    if (hit) return { ...hit, on: "USDOT" };
  }
  return null;
}

/** Builds the preview the user confirms before anything is written. */
export function buildPreview(rows: Record<string, string>[]): {
  preview: PreviewRow[];
  counts: { total: number; errors: number; flagged: number; duplicates: number };
} {
  const seenMc = new Set<string>();
  const seenDot = new Set<string>();
  let errors = 0;
  let flagged = 0;
  let duplicates = 0;

  const preview = rows.map((values, index) => {
    const parsed = parseImportRow(values);
    const duplicateOf = findExisting(parsed.mc, parsed.usdot);

    let duplicateInFile = false;
    if (parsed.mc) {
      if (seenMc.has(parsed.mc)) duplicateInFile = true;
      seenMc.add(parsed.mc);
    }
    if (parsed.usdot) {
      if (seenDot.has(parsed.usdot)) duplicateInFile = true;
      seenDot.add(parsed.usdot);
    }

    const hasError = parsed.issues.some((i) => i.severity === "error");
    if (hasError) errors++;
    if (parsed.issues.some((i) => i.severity === "flag")) flagged++;
    if (duplicateOf || duplicateInFile) duplicates++;

    return {
      index,
      values,
      issues: parsed.issues,
      duplicateOf,
      duplicateInFile,
      skip: hasError,
    };
  });

  return { preview, counts: { total: rows.length, errors, flagged, duplicates } };
}
