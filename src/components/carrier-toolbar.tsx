"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Icon } from "./icons";
import { ColumnPicker } from "./column-picker";
import { saveFilterAction, deleteFilterAction } from "@/lib/filter-actions";
import { buildQuery, type RawParams, type FilterParam } from "@/lib/query";
import type { ColumnKey } from "@/lib/columns";
import type { Tone } from "@/lib/constants";

export type Option = { id: number; label: string; tone?: Tone | null };
export type QuickFilter = { id: number | null; label: string; tone?: Tone | null };
export type SavedFilter = { id: number; name: string; query: string };

const ADVANCED: { param: FilterParam; label: string }[] = [
  { param: "status", label: "Status" },
  { param: "dispatcher", label: "Dispatcher" },
  { param: "am", label: "Account Manager" },
  { param: "source", label: "Lead Source" },
  { param: "otype", label: "Onboarding Type" },
  { param: "trailer", label: "Trailer Type" },
  { param: "plan", label: "Plan" },
  { param: "pricing", label: "Pricing Type" },
  { param: "agreement", label: "Agreement Status" },
  { param: "sub", label: "Subscription" },
  { param: "invoice", label: "Invoice Collection" },
];

function value(params: RawParams, key: string): string {
  const v = params[key];
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

export function CarrierToolbar({
  basePath,
  params,
  options,
  quickFilters,
  columns,
  savedFilters,
  activeFilterCount,
  total,
}: {
  basePath: string;
  params: RawParams;
  options: Record<FilterParam, Option[]>;
  quickFilters?: QuickFilter[];
  columns: ColumnKey[];
  savedFilters: SavedFilter[];
  activeFilterCount: number;
  total: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [showFilters, setShowFilters] = useState(activeFilterCount > 0 && !value(params, "q"));
  const [q, setQ] = useState(value(params, "q"));

  const go = (changes: Record<string, string | null>) =>
    startTransition(() => router.push(`${basePath}${buildQuery(params, changes)}`));

  // Debounced search — typing stays instant, the server sees one request per pause.
  useEffect(() => {
    const current = value(params, "q");
    if (q === current) return;
    const t = setTimeout(() => {
      startTransition(() => router.push(`${basePath}${buildQuery(params, { q: q || null })}`));
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const currentQuery = buildQuery(params, {});
  const statusValue = value(params, "status");

  return (
    <div className="space-y-3">
      {quickFilters && (
        <div className="flex flex-wrap items-center gap-1.5">
          {quickFilters.map((f) => {
            const active = f.id === null ? statusValue === "" : statusValue === String(f.id);
            return (
              <button
                key={f.label}
                type="button"
                onClick={() => go({ status: f.id === null ? null : String(f.id) })}
                className={`rounded-full border px-3 py-1 text-[0.78rem] font-medium transition ${
                  active
                    ? "border-brand-600 bg-brand-600 text-white"
                    : "border-line-strong bg-surface text-ink-600 hover:border-ink-400 hover:text-ink-900"
                }`}
              >
                {f.label}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[15rem] flex-1">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400">
            <Icon name="search" className="h-4 w-4" />
          </span>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, owner, phone, email, MC, USDOT, address…"
            aria-label="Search carriers"
            className="field field-sm pl-8"
          />
        </div>

        <button
          type="button"
          onClick={() => setShowFilters((s) => !s)}
          aria-expanded={showFilters}
          className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-[0.42rem] text-[0.82rem] font-medium transition ${
            activeFilterCount > 0
              ? "border-brand-300 bg-brand-50 text-brand-700"
              : "border-line-strong bg-surface text-ink-700 hover:bg-ink-50"
          }`}
        >
          <Icon name="filter" className="h-4 w-4" />
          Filters
          {activeFilterCount > 0 && (
            <span className="tnum rounded bg-brand-600 px-1.5 text-[0.7rem] font-semibold text-white">
              {activeFilterCount}
            </span>
          )}
        </button>

        <ColumnPicker selected={columns} />

        <Link
          href={`/api/export${currentQuery || "?"}${currentQuery ? "&" : ""}path=${encodeURIComponent(basePath)}`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 py-[0.42rem] text-[0.82rem] font-medium text-ink-700 transition hover:bg-ink-50"
        >
          <Icon name="download" className="h-4 w-4" />
          Export
        </Link>

        <span className="tnum ml-auto text-[0.8rem] text-ink-500">
          {pending ? "Loading…" : `${total.toLocaleString()} ${total === 1 ? "carrier" : "carriers"}`}
        </span>
      </div>

      {showFilters && (
        <div className="rounded-card border border-line bg-surface p-4 shadow-card">
          <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
            {ADVANCED.map(({ param, label }) => (
              <div key={param}>
                <label className="label" htmlFor={`f-${param}`}>{label}</label>
                <select
                  id={`f-${param}`}
                  className="field field-sm"
                  value={value(params, param)}
                  onChange={(e) => go({ [param]: e.target.value || null })}
                >
                  <option value="">Any</option>
                  {options[param].map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
              </div>
            ))}

            <div>
              <span className="label">Onboarded between</span>
              <div className="flex items-center gap-1.5">
                <input
                  type="date" className="field field-sm" aria-label="Onboarded from"
                  value={value(params, "from")}
                  onChange={(e) => go({ from: e.target.value || null })}
                />
                <input
                  type="date" className="field field-sm" aria-label="Onboarded to"
                  value={value(params, "to")}
                  onChange={(e) => go({ to: e.target.value || null })}
                />
              </div>
            </div>

            <div>
              <span className="label">First load between</span>
              <div className="flex items-center gap-1.5">
                <input
                  type="date" className="field field-sm" aria-label="First load from"
                  value={value(params, "flfrom")}
                  onChange={(e) => go({ flfrom: e.target.value || null })}
                />
                <input
                  type="date" className="field field-sm" aria-label="First load to"
                  value={value(params, "flto")}
                  onChange={(e) => go({ flto: e.target.value || null })}
                />
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <SavedFilters
              basePath={basePath}
              savedFilters={savedFilters}
              currentQuery={currentQuery}
            />
            {activeFilterCount > 0 && (
              <button
                type="button"
                onClick={() => { setQ(""); startTransition(() => router.push(basePath)); }}
                className="ml-auto text-[0.8rem] font-medium text-ink-500 hover:text-ink-900"
              >
                Clear all filters
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SavedFilters({
  basePath,
  savedFilters,
  currentQuery,
}: {
  basePath: string;
  savedFilters: SavedFilter[];
  currentQuery: string;
}) {
  const [naming, setNaming] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[0.7rem] font-semibold uppercase tracking-[0.1em] text-ink-400">
        Saved
      </span>

      {savedFilters.map((f) => (
        <span
          key={f.id}
          className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-ink-50 pl-2.5 pr-1 text-[0.78rem] text-ink-700"
        >
          <Link href={`${basePath}${f.query}`} className="py-0.5 hover:text-brand-700">
            {f.name}
          </Link>
          <form action={deleteFilterAction}>
            <input type="hidden" name="id" value={f.id} />
            <input type="hidden" name="path" value={basePath} />
            <button
              type="submit"
              aria-label={`Delete saved filter ${f.name}`}
              className="rounded-full p-0.5 text-ink-400 hover:text-red-600"
            >
              <Icon name="close" className="h-3 w-3" />
            </button>
          </form>
        </span>
      ))}

      {naming ? (
        <form
          action={saveFilterAction}
          onSubmit={() => setNaming(false)}
          className="flex items-center gap-1"
        >
          <input type="hidden" name="query" value={currentQuery} />
          <input type="hidden" name="path" value={basePath} />
          <input
            name="name"
            required
            autoFocus
            maxLength={80}
            placeholder="Filter name"
            className="field field-sm w-36"
          />
          <button
            type="submit"
            className="rounded-lg bg-brand-600 px-2.5 py-[0.35rem] text-[0.78rem] font-semibold text-white hover:bg-brand-700"
          >
            Save
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setNaming(true)}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-line-strong px-2.5 py-0.5 text-[0.78rem] text-ink-500 hover:border-brand-400 hover:text-brand-700"
        >
          <Icon name="plus" className="h-3 w-3" />
          Save current
        </button>
      )}
    </div>
  );
}
