"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { changeStatusAction, type StatusState } from "@/lib/offboard-actions";
import { Select, Text, TextArea, type FormOption } from "./form-fields";
import { Icon } from "./icons";

export type StatusDialogOptions = {
  status: FormOption[];
  users: FormOption[];
  offboard_reason: FormOption[];
  offboard_category: FormOption[];
  final_status: FormOption[];
};

export function StatusDialog({
  carrierId,
  currentStatusId,
  currentStatusLabel,
  exitStatusIds,
  options,
  currentUserId,
  existing,
}: {
  carrierId: number;
  currentStatusId: number | null;
  currentStatusLabel: string;
  exitStatusIds: number[];
  options: StatusDialogOptions;
  currentUserId: number;
  existing?: {
    offboarded_on: string | null;
    reason_id: number | null;
    category_id: number | null;
    final_status_id: number | null;
    handled_by: number | null;
    last_load_date: string | null;
    outstanding_balance: number | null;
    subscription_cancelled: number;
    agreement_closed: number;
    can_return: number;
    notes: string | null;
  } | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [state, action, pending] = useActionState<StatusState, FormData>(
    changeStatusAction,
    {},
  );
  const [statusId, setStatusId] = useState(String(currentStatusId ?? ""));

  const exiting = exitStatusIds.includes(Number(statusId));
  const leavingExit = exitStatusIds.includes(currentStatusId ?? -1) && !exiting;
  const today = new Date().toISOString().slice(0, 10);

  useEffect(() => {
    if (state.ok) ref.current?.close();
  }, [state.ok]);

  const str = (v: string | number | null | undefined) =>
    v === null || v === undefined ? "" : String(v);

  return (
    <>
      <button
        type="button"
        onClick={() => ref.current?.showModal()}
        className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-sm font-semibold text-ink-700 shadow-sm transition hover:bg-ink-50"
      >
        <Icon name="history" className="h-4 w-4" />
        Change status
      </button>

      {/* Native <dialog> gives focus trapping, Esc-to-close and the backdrop for free. */}
      <dialog
        ref={ref}
        onClick={(e) => { if (e.target === ref.current) ref.current?.close(); }}
        className="m-auto w-[min(46rem,92vw)] rounded-card border border-line bg-surface p-0 shadow-pop backdrop:bg-ink-950/50"
      >
        <form action={action} className="max-h-[85vh] overflow-y-auto">
          <input type="hidden" name="carrierId" value={carrierId} />

          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div>
              <h2 className="text-base font-semibold tracking-tight text-ink-900">
                Change carrier status
              </h2>
              <p className="mt-0.5 text-xs text-ink-500">
                Currently <span className="font-medium text-ink-700">{currentStatusLabel}</span>.
                Every change is recorded in the carrier&rsquo;s history.
              </p>
            </div>
            <button
              type="button"
              onClick={() => ref.current?.close()}
              aria-label="Close"
              className="rounded p-1 text-ink-400 hover:text-ink-800"
            >
              <Icon name="close" />
            </button>
          </div>

          <div className="space-y-4 px-5 py-4">
            {state.message && (
              <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {state.message}
              </p>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Select
                name="status_id"
                label="New status"
                required
                options={options.status}
                value={statusId}
                onChange={(e) => setStatusId(e.target.value)}
                error={state.errors?.status_id}
              />
              <TextArea
                name="note"
                label="Note (optional)"
                rows={2}
                placeholder="Why is this changing?"
              />
            </div>

            {leavingExit && (
              <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
                This brings the carrier back into service. The existing offboarding record
                is kept as history.
              </p>
            )}

            {exiting && (
              <div className="rounded-lg border border-red-200 bg-red-50/50 p-4">
                <div className="mb-3 flex items-center gap-2">
                  <span className="text-red-600"><Icon name="offboarded" className="h-4 w-4" /></span>
                  <h3 className="text-sm font-semibold text-ink-900">Offboarding details</h3>
                </div>
                <p className="mb-4 text-xs text-ink-600">
                  The carrier record and its full history are retained — offboarding never
                  deletes anything.
                </p>

                <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Text name="offboarded_on" label="Offboarding Date" type="date"
                    defaultValue={existing?.offboarded_on ?? today}
                    error={state.errors?.offboarded_on} />
                  <Select name="reason_id" label="Reason" required options={options.offboard_reason}
                    defaultValue={str(existing?.reason_id)} error={state.errors?.reason_id} />
                  <Select name="category_id" label="Category" options={options.offboard_category}
                    defaultValue={str(existing?.category_id)} error={state.errors?.category_id} />
                  <Select name="handled_by" label="Handled By" options={options.users}
                    defaultValue={str(existing?.handled_by ?? currentUserId)}
                    error={state.errors?.handled_by} />
                  <Select name="final_status_id" label="Final Status" options={options.final_status}
                    defaultValue={str(existing?.final_status_id)}
                    error={state.errors?.final_status_id} />
                  <Text name="last_load_date" label="Last Load Date" type="date"
                    defaultValue={str(existing?.last_load_date)}
                    error={state.errors?.last_load_date} />
                  <Text name="outstanding_balance" label="Outstanding Balance" type="number"
                    inputMode="decimal" min={0} step="0.01"
                    defaultValue={str(existing?.outstanding_balance)}
                    error={state.errors?.outstanding_balance} hint="USD" />
                </div>

                <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
                  {[
                    { name: "subscription_cancelled", label: "Subscription cancelled", on: existing ? !!existing.subscription_cancelled : true },
                    { name: "agreement_closed", label: "Agreement closed", on: existing ? !!existing.agreement_closed : true },
                    { name: "can_return", label: "Carrier may return", on: existing ? !!existing.can_return : true },
                  ].map((box) => (
                    <label key={box.name} className="flex items-center gap-2 text-[0.83rem] text-ink-700">
                      <input
                        type="checkbox"
                        name={box.name}
                        defaultChecked={box.on}
                        className="h-3.5 w-3.5 accent-[var(--color-brand-600)]"
                      />
                      {box.label}
                    </label>
                  ))}
                </div>

                <TextArea
                  name="offboard_notes"
                  label="Offboarding notes"
                  rows={3}
                  defaultValue={existing?.notes ?? ""}
                  placeholder="Balance settled, equipment returned, anything relevant to a future re-engagement."
                  className="mt-3"
                />
              </div>
            )}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
            <button
              type="button"
              onClick={() => ref.current?.close()}
              className="rounded-lg border border-line-strong bg-surface px-4 py-2 text-sm font-semibold text-ink-700 transition hover:bg-ink-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={pending}
              className={`rounded-lg px-4 py-2 text-sm font-semibold text-white shadow-sm transition disabled:opacity-60 ${
                exiting ? "bg-red-600 hover:bg-red-700" : "bg-brand-600 hover:bg-brand-700"
              }`}
            >
              {pending ? "Saving…" : exiting ? "Record offboarding" : "Update status"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
