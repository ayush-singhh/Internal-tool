"use client";

import { useActionState } from "react";
import { saveSettingsAction, resetSettingsAction, toggleLookupAction, setPasswordAction, type AdminState } from "@/lib/admin-actions";
import type { SettingDef } from "@/lib/settings";
import { Text } from "./form-fields";
import { Badge } from "./ui";

export function SettingsForm({
  defs,
  values,
}: {
  defs: SettingDef[];
  values: Record<string, string>;
}) {
  const [state, action, pending] = useActionState<AdminState, FormData>(saveSettingsAction, {});
  const v = (key: string) => state.values?.[key] ?? values[key] ?? "";

  return (
    <form action={action} className="space-y-4">
      {state.error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {state.ok}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        {defs.map((def) => (
          <Text
            key={def.key}
            name={def.key}
            label={def.label}
            hint={def.help}
            error={state.errors?.[def.key]}
            type={def.type === "number" ? "number" : "text"}
            inputMode={def.type === "number" ? "numeric" : undefined}
            min={def.min}
            max={def.max}
            defaultValue={v(def.key)}
          />
        ))}
      </div>

      <div className="flex items-center gap-2 border-t border-line pt-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save settings"}
        </button>
        <button
          type="submit"
          formAction={resetSettingsAction}
          className="rounded-lg border border-line-strong bg-surface px-4 py-2 text-sm font-semibold text-ink-700 transition hover:bg-ink-50"
        >
          Restore defaults
        </button>
      </div>
    </form>
  );
}

export function PasswordSelfForm({ userId }: { userId: number }) {
  const [state, action, pending] = useActionState<AdminState, FormData>(setPasswordAction, {});
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="id" value={userId} />
      {state.error && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {state.error}
        </p>
      )}
      {state.ok && (
        <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {state.ok}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Text name="password" label="New password" type="password" required hint="At least 8 characters." />
        <Text name="confirm" label="Confirm password" type="password" required />
      </div>
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
      >
        {pending ? "Saving…" : "Change my password"}
      </button>
    </form>
  );
}

export type LookupRow = {
  id: number;
  kind: string;
  label: string;
  active: number;
  usage: number;
};

export function LookupManager({ groups }: { groups: [string, LookupRow[]][] }) {
  return (
    <div className="space-y-5">
      {groups.map(([kind, rows]) => (
        <div key={kind}>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.1em] text-ink-500">
            {kind.replace(/_/g, " ")}
          </h3>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {rows.map((row) => (
              <li key={row.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <span className={`text-[0.83rem] ${row.active ? "text-ink-800" : "text-ink-400 line-through"}`}>
                  {row.label}
                </span>
                {row.usage > 0 && (
                  <span className="tnum text-xs text-ink-400">
                    {row.usage} carrier{row.usage === 1 ? "" : "s"}
                  </span>
                )}
                {!row.active && <Badge tone="slate">Retired</Badge>}
                <form action={toggleLookupAction} className="ml-auto">
                  <input type="hidden" name="id" value={row.id} />
                  <input type="hidden" name="active" value={row.active ? "0" : "1"} />
                  <button
                    type="submit"
                    className="rounded px-2 py-1 text-xs font-medium text-ink-500 transition hover:bg-ink-100 hover:text-ink-900"
                  >
                    {row.active ? "Retire" : "Restore"}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
