"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { COLUMNS, COLUMN_GROUPS, DEFAULT_COLUMNS, type ColumnKey } from "@/lib/columns";
import { Icon } from "./icons";

const COOKIE = "ch_cols";

/** Written straight to `document.cookie` so the server can render the chosen columns on
 *  the next request — no action round trip, no client-side table re-implementation. */
function persist(cols: ColumnKey[]) {
  document.cookie = `${COOKIE}=${cols.join(",")}; path=/; max-age=31536000; samesite=lax`;
}

export function ColumnPicker({ selected }: { selected: ColumnKey[] }) {
  const [open, setOpen] = useState(false);
  const [cols, setCols] = useState<ColumnKey[]>(selected);
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setCols(selected), [selected]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function apply(next: ColumnKey[]) {
    setCols(next);
    persist(next);
    router.refresh();
  }

  function toggle(key: ColumnKey) {
    apply(cols.includes(key) ? cols.filter((c) => c !== key) : [...cols, key]);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 py-[0.42rem] text-[0.82rem] font-medium text-ink-700 transition hover:bg-ink-50"
      >
        <Icon name="columns" className="h-4 w-4" />
        Columns
        <span className="tnum rounded bg-ink-100 px-1.5 text-[0.7rem] font-semibold text-ink-600">
          {cols.length}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 z-40 mt-1.5 max-h-[26rem] w-[19rem] overflow-y-auto rounded-lg border border-line bg-surface p-3 shadow-pop">
          <div className="mb-2.5 flex items-center justify-between">
            <p className="text-xs font-semibold text-ink-700">Visible columns</p>
            <button
              type="button"
              onClick={() => apply(DEFAULT_COLUMNS)}
              className="text-xs font-medium text-brand-600 hover:underline"
            >
              Reset
            </button>
          </div>

          {COLUMN_GROUPS.map((group) => (
            <div key={group} className="mb-2.5 last:mb-0">
              <p className="mb-1 text-[0.65rem] font-semibold uppercase tracking-[0.1em] text-ink-400">
                {group}
              </p>
              <ul>
                {COLUMNS.filter((c) => c.group === group).map((c) => (
                  <li key={c.key}>
                    <label
                      className={`flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[0.82rem] ${
                        c.locked ? "cursor-not-allowed opacity-55" : "hover:bg-ink-50"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={cols.includes(c.key)}
                        disabled={c.locked}
                        onChange={() => toggle(c.key)}
                        className="h-3.5 w-3.5 accent-[var(--color-brand-600)]"
                      />
                      <span className="text-ink-700">{c.label}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
