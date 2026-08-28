/** Server-side validation. Pure — the same rules run for the Add form, the Edit form
 *  and the CSV import, so the three can never drift apart.
 *  Client-side `type`/`min`/`pattern` attributes are UX; these rules are the truth. */

export type FieldErrors = Record<string, string>;

export type Parsed<T> = { values: T; errors: FieldErrors };

const DIGITS = /^\d+$/;
// Deliberately permissive: real addresses of real people, not a spec-compliant grammar.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function str(raw: FormDataEntryValue | null | undefined, max = 255): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  return s === "" ? null : s.slice(0, max);
}

/** MC and USDOT are digits only. Formatting like "MC-123456" is unwrapped, not rejected. */
export function digitsOnly(
  raw: FormDataEntryValue | null | undefined,
  field: string,
  label: string,
  errors: FieldErrors,
  max = 12,
): string | null {
  const s = str(raw);
  if (s === null) return null;
  const cleaned = s.replace(/[^\d]/g, "");
  if (cleaned === "") {
    errors[field] = `${label} must be a number.`;
    return null;
  }
  if (cleaned.length > max) {
    errors[field] = `${label} is too long.`;
    return null;
  }
  return cleaned;
}

export function email(
  raw: FormDataEntryValue | null | undefined,
  field: string,
  errors: FieldErrors,
): string | null {
  const s = str(raw, 254);
  if (s === null) return null;
  if (!EMAIL.test(s)) {
    errors[field] = "Enter a valid email address.";
    return null;
  }
  return s.toLowerCase();
}

/** Returns the value as entered plus a digits-only form used for search and dedupe. */
export function phone(
  raw: FormDataEntryValue | null | undefined,
  field: string,
  errors: FieldErrors,
): { value: string | null; digits: string | null } {
  const s = str(raw, 40);
  if (s === null) return { value: null, digits: null };
  const digits = s.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) {
    errors[field] = "Enter a phone number with 7–15 digits.";
    return { value: s, digits: null };
  }
  return { value: s, digits };
}

export function integer(
  raw: FormDataEntryValue | null | undefined,
  field: string,
  label: string,
  errors: FieldErrors,
  opts: { min?: number; max?: number } = {},
): number | null {
  const s = str(raw);
  if (s === null) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    errors[field] = `${label} must be a whole number.`;
    return null;
  }
  if (opts.min !== undefined && n < opts.min) {
    errors[field] = `${label} cannot be less than ${opts.min}.`;
    return null;
  }
  if (opts.max !== undefined && n > opts.max) {
    errors[field] = `${label} cannot be more than ${opts.max}.`;
    return null;
  }
  return n;
}

export function decimal(
  raw: FormDataEntryValue | null | undefined,
  field: string,
  label: string,
  errors: FieldErrors,
  opts: { min?: number; max?: number } = {},
): number | null {
  const s = str(raw);
  if (s === null) return null;
  // Accept "$1,200.50" and "12.5%" — people paste from the spreadsheet.
  const n = Number(s.replace(/[$,%\s]/g, ""));
  if (!Number.isFinite(n)) {
    errors[field] = `${label} must be a number.`;
    return null;
  }
  if (opts.min !== undefined && n < opts.min) {
    errors[field] = `${label} cannot be less than ${opts.min}.`;
    return null;
  }
  if (opts.max !== undefined && n > opts.max) {
    errors[field] = `${label} cannot be more than ${opts.max}.`;
    return null;
  }
  return Math.round(n * 100) / 100;
}

export function percentage(
  raw: FormDataEntryValue | null | undefined,
  field: string,
  errors: FieldErrors,
): number | null {
  return decimal(raw, field, "Percentage", errors, { min: 0, max: 100 });
}

export function date(
  raw: FormDataEntryValue | null | undefined,
  field: string,
  label: string,
  errors: FieldErrors,
): string | null {
  const s = str(raw, 10);
  if (s === null) return null;
  if (!ISO_DATE.test(s)) {
    errors[field] = `${label} must be a valid date.`;
    return null;
  }
  // Rejects 2025-02-31, which the regex alone would let through.
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(y, m - 1, d));
  if (
    parsed.getUTCFullYear() !== y ||
    parsed.getUTCMonth() !== m - 1 ||
    parsed.getUTCDate() !== d
  ) {
    errors[field] = `${label} is not a real date.`;
    return null;
  }
  return s;
}

/** Foreign keys into `lookups` / `users`: must be one of the ids we offered. */
export function choice(
  raw: FormDataEntryValue | null | undefined,
  field: string,
  label: string,
  allowed: Set<number>,
  errors: FieldErrors,
  required = false,
): number | null {
  const s = str(raw);
  if (s === null) {
    if (required) errors[field] = `${label} is required.`;
    return null;
  }
  const n = Number(s);
  if (!Number.isInteger(n) || !allowed.has(n)) {
    errors[field] = `Select a valid ${label.toLowerCase()}.`;
    return null;
  }
  return n;
}

export function required(
  raw: FormDataEntryValue | null | undefined,
  field: string,
  label: string,
  errors: FieldErrors,
  max = 255,
): string | null {
  const s = str(raw, max);
  if (s === null) {
    errors[field] = `${label} is required.`;
    return null;
  }
  return s;
}

/** Warns when a later milestone precedes an earlier one, e.g. first load before onboarding. */
export function checkDateOrder(
  earlier: string | null,
  later: string | null,
  field: string,
  message: string,
  errors: FieldErrors,
) {
  if (earlier && later && later < earlier) errors[field] = message;
}
