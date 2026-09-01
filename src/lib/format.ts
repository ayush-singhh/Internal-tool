/** Display formatting. Pure functions — no database, no server-only, testable directly. */

/** (555) 123-4567 for 10-digit US numbers; +1 (555) 123-4567 for 11 starting with 1. */
export function formatPhone(raw: string | null | undefined): string {
  if (!raw) return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return raw.trim(); // Unrecognised shape (extension, international) — show what was entered.
}

const DATE_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

/** ISO `YYYY-MM-DD` → `Mar 4, 2025`. Parsed as UTC so the day never shifts. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : DATE_FMT.format(d);
}

const DATETIME_FMT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : DATETIME_FMT.format(d);
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(iso.slice(0, 10));
}

/** Whole days between an ISO date and today. Negative means the date is in the future. */
export function daysSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const then = new Date(`${iso.slice(0, 10)}T00:00:00Z`).getTime();
  if (Number.isNaN(then)) return null;
  const today = new Date();
  const todayUtc = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((todayUtc - then) / 86400_000);
}

const MONEY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

export function formatMoney(n: number | null | undefined): string {
  return n == null ? "" : MONEY.format(n);
}

export type PricingParts = {
  pricingType: string | null;
  planName: string | null;
  rate: number | null;
  percentage: number | null;
  billingFrequency: string | null;
};

/**
 * Renders the structured pricing columns as one readable line —
 * "12% per load · Royal", "$1,200 / month". Structure is stored; prose is derived.
 */
export function formatPricing(p: PricingParts): string {
  const parts: string[] = [];
  const freq = p.billingFrequency ? p.billingFrequency.toLowerCase() : null;

  if (p.percentage != null) {
    parts.push(`${trimNum(p.percentage)}%${freq ? ` ${freq}` : ""}`);
  } else if (p.rate != null) {
    parts.push(`${formatMoney(p.rate)}${freq ? ` / ${freq.replace(/^per /, "")}` : ""}`);
  } else if (p.pricingType) {
    parts.push(p.pricingType);
  }

  // Only name the pricing type separately when it adds something the number doesn't.
  if (p.pricingType && parts[0] !== p.pricingType && p.percentage == null && p.rate == null) {
    parts.push(p.pricingType);
  }
  if (p.planName) parts.push(p.planName);

  return parts.length ? parts.join(" · ") : "";
}

function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(2)));
}

/** "3 trucks" / "1 truck" — avoids "1 trucks" showing up in a table all day. */
export function pluralize(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "240 KB" / "2.4 MB" — a file size is always shown human-scaled, never raw bytes. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
