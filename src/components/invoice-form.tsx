"use client";

import { useActionState } from "react";
import { createInvoiceAction, type InvoiceFormState } from "@/lib/invoice-actions";
import { formatDate, formatMoney } from "@/lib/format";
import { Banner } from "./ui";

type PreviewRow = {
  load: { id: number; load_number: string | null; delivered_at: string | null };
  finalAmount: number | null;
  feeAmount: number | null;
};

export function InvoiceForm({
  carrierId,
  carrierName,
  loads,
}: {
  carrierId: number;
  carrierName: string;
  loads: PreviewRow[];
}) {
  const [state, action, pending] = useActionState<InvoiceFormState, FormData>(createInvoiceAction, {});
  const today = new Date().toISOString().slice(0, 10);
  const invoiceable = loads.some((r) => r.feeAmount !== null);

  return (
    <div className="space-y-4">
      <Banner state={state} />
      <form action={action} className="space-y-4">
        <input type="hidden" name="carrier_id" value={carrierId} />
        <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-ink-50/70">
                {["", "Load", "Delivered", "Final Load Amount", "Dispatch Fee"].map((h) => (
                  <th key={h} scope="col" className="px-4 py-2.5 text-left text-xs font-semibold text-ink-600">
                    {h === "" ? <span className="sr-only">Include</span> : h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loads.map(({ load, finalAmount, feeAmount }) => (
                <tr key={load.id} className="border-b border-line/70 last:border-0">
                  <td className="px-4 py-2.5">
                    <input
                      type="checkbox" name="load_id" value={load.id}
                      defaultChecked={feeAmount !== null} disabled={feeAmount === null}
                    />
                  </td>
                  <td className="px-4 py-2.5 text-ink-900">{load.load_number || `Load #${load.id}`}</td>
                  <td className="px-4 py-2.5 text-ink-600">{formatDate(load.delivered_at?.slice(0, 10) ?? null)}</td>
                  <td className="px-4 py-2.5 font-mono tnum text-ink-900">{formatMoney(finalAmount)}</td>
                  <td className="px-4 py-2.5 font-mono tnum text-ink-900">
                    {feeAmount === null ? (
                      <span className="text-red-600">No billable amount yet</span>
                    ) : (
                      formatMoney(feeAmount)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="label" htmlFor="issued_on">Issued</label>
            <input id="issued_on" name="issued_on" type="date" defaultValue={today} className="field" required />
          </div>
          <div className="min-w-[16rem] flex-1">
            <label className="label" htmlFor="notes">Notes</label>
            <input id="notes" name="notes" type="text" className="field w-full" placeholder="Optional" />
          </div>
          <button
            type="submit"
            disabled={pending || !invoiceable}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
          >
            {pending ? "Creating…" : `Create Invoice for ${carrierName}`}
          </button>
        </div>
      </form>
    </div>
  );
}
