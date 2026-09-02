"use client";

import { useActionState } from "react";
import { addAdjustmentAction, type AdjustmentState } from "@/lib/load-adjustment-actions";
import { ADJUSTMENT_KIND_LABELS, ADJUSTMENT_KIND_TONE, type AdjustmentKind } from "@/lib/constants";
import { formatDateTime } from "@/lib/format";
import { Badge, Banner, EmptyState } from "./ui";

type AdjustmentRow = {
  id: number;
  kind: AdjustmentKind;
  description: string;
  amount: number;
  created_at: string;
};

export function AdjustmentManager({
  loadId,
  adjustments,
  canAdd,
}: {
  loadId: number;
  adjustments: AdjustmentRow[];
  canAdd: boolean;
}) {
  const [state, action, pending] = useActionState<AdjustmentState, FormData>(addAdjustmentAction, {});
  const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

  return (
    <div className="space-y-4">
      {adjustments.length === 0 ? (
        <EmptyState title="No adjustments" description="Detention, lumper fees, a negotiated TONU amount — added here." />
      ) : (
        <table className="w-full border-collapse text-sm">
          <tbody>
            {adjustments.map((a) => (
              <tr key={a.id} className="border-b border-line/70 last:border-0">
                <td className="py-2 pr-3">
                  <Badge tone={ADJUSTMENT_KIND_TONE[a.kind]}>{ADJUSTMENT_KIND_LABELS[a.kind]}</Badge>
                </td>
                <td className="py-2 pr-3 text-ink-900">{a.description}</td>
                <td className="py-2 pr-3 text-right font-mono tnum text-ink-900">{money(a.amount)}</td>
                <td className="py-2 text-right text-xs text-ink-400">{formatDateTime(a.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canAdd && (
        <div className="space-y-3 border-t border-line pt-4">
          <Banner state={state} />
          <form action={action} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="load_id" value={loadId} />
            <div>
              <label className="label" htmlFor="adjustment-kind">Kind</label>
              <select id="adjustment-kind" name="kind" defaultValue="extra_pay" className="field" required>
                {Object.entries(ADJUSTMENT_KIND_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
            <div className="min-w-[10rem] flex-1">
              <label className="label" htmlFor="adjustment-description">Description</label>
              <input id="adjustment-description" name="description" type="text" className="field w-full" placeholder="Detention, lumper fee…" required />
            </div>
            <div className="w-32">
              <label className="label" htmlFor="adjustment-amount">Amount</label>
              <input id="adjustment-amount" name="amount" type="number" step="0.01" min="0.01" className="field w-full" required />
            </div>
            <button
              type="submit"
              disabled={pending}
              className="rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
            >
              {pending ? "Adding…" : "Add"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
