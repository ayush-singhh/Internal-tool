import type { ReactNode } from "react";
import type { Tone } from "@/lib/constants";

const TONE_CLASS: Record<Tone, string> = {
  green:  "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  blue:   "bg-blue-50 text-blue-700 ring-blue-600/20",
  amber:  "bg-amber-50 text-amber-800 ring-amber-600/25",
  slate:  "bg-ink-100 text-ink-600 ring-ink-500/20",
  orange: "bg-orange-50 text-orange-700 ring-orange-600/25",
  red:    "bg-red-50 text-red-700 ring-red-600/20",
  purple: "bg-purple-50 text-purple-700 ring-purple-600/20",
};

/** Status pill. Tone comes from the lookup row, never from a hardcoded label match. */
export function Badge({
  tone = "slate",
  children,
  dot = false,
}: {
  tone?: Tone | null;
  children: ReactNode;
  dot?: boolean;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${
        TONE_CLASS[tone ?? "slate"]
      }`}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />}
      {children}
    </span>
  );
}

export function Card({
  children,
  className = "",
  padded = true,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section
      className={`rounded-card border border-line bg-surface shadow-card ${
        padded ? "p-5" : ""
      } ${className}`}
    >
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-start justify-between gap-4">
      <div>
        <h2 className="text-sm font-semibold tracking-tight text-ink-900">{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-ink-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-[1.4rem] font-semibold tracking-tight text-ink-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-card border border-dashed border-line-strong bg-surface px-6 py-14 text-center">
      <p className="text-sm font-semibold text-ink-800">{title}</p>
      {description && (
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-ink-500">{description}</p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** Label/value pair used throughout the carrier profile. */
export function Field({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  const empty = children === null || children === undefined || children === "";
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium text-ink-500">{label}</dt>
      <dd
        className={`mt-1 break-words text-sm ${
          empty ? "text-ink-400" : "text-ink-900"
        } ${mono ? "font-mono tnum" : ""}`}
      >
        {empty ? "—" : children}
      </dd>
    </div>
  );
}
