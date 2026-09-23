"use client";

import { useActionState, useState } from "react";
import type { ApplicationRow } from "@/lib/applications";
import {
  convertApplicationAction, rejectApplicationAction, type ReviewState,
} from "@/lib/application-actions";
import { Badge, Card, CardHeader, EmptyState } from "./ui";

export type QueueRow = {
  application: ApplicationRow;
  duplicate: { id: number; legal_name: string } | null;
};

const TONE: Record<string, "blue" | "amber" | "green" | "slate"> = {
  draft: "amber",
  submitted: "blue",
  converted: "green",
  rejected: "slate",
};

const LABEL: Record<string, string> = {
  draft: "In progress",
  submitted: "Ready for review",
  converted: "Converted",
  rejected: "Rejected",
};

export function ApplicationQueue({
  open, closed, canConvert,
}: {
  open: QueueRow[];
  closed: QueueRow[];
  canConvert: boolean;
}) {
  const [state, convert, converting] = useActionState<ReviewState, FormData>(
    convertApplicationAction, {});
  const [rejectState, reject, rejecting] = useActionState<ReviewState, FormData>(
    rejectApplicationAction, {});
  const [rejectingId, setRejectingId] = useState<number | null>(null);

  const banner = state.error ?? rejectState.error ?? state.ok ?? rejectState.ok;
  const bad = Boolean(state.error ?? rejectState.error);

  return (
    <div className="space-y-6">
      {banner && (
        <p
          role={bad ? "alert" : undefined}
          className={
            bad
              ? "rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700"
              : "rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-800"
          }
        >
          {banner}
        </p>
      )}

      {open.length === 0 ? (
        <EmptyState
          title="No applications waiting"
          description="When a carrier applies through your portal, they appear here for review."
        />
      ) : (
        <div className="space-y-4">
          {open.map(({ application, duplicate }) => (
            <Card key={application.id}>
              <CardHeader
                title={application.legal_name}
                action={<Badge tone={TONE[application.status]}>{LABEL[application.status]}</Badge>}
              />
              <dl className="grid gap-x-6 gap-y-2 px-4 py-3 text-sm sm:grid-cols-2">
                <Row label="USDOT" value={application.usdot} />
                <Row label="Applied" value={application.created_at.slice(0, 10)} />
                <Row label="Phone" value={`${application.phone} · confirmed`} />
                <Row label="Email" value={application.email} />
                {application.dba_name && <Row label="Trading as" value={application.dba_name} />}
                {application.operating_state && (
                  <Row label="State" value={application.operating_state} />
                )}
                <Row
                  label="Company name"
                  value={application.name_source === "fmcsa" ? "Confirmed against FMCSA" : "Typed by the carrier"}
                />
              </dl>

              {application.allowed_to_operate === 0 && (
                <p className="mx-4 mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  FMCSA showed this carrier as <strong>not authorised to operate</strong> when
                  they applied. Check before converting.
                </p>
              )}
              {duplicate && (
                <p className="mx-4 mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  You already have a carrier on USDOT {application.usdot} —{" "}
                  <strong>{duplicate.legal_name}</strong>. Converting creates a second record.
                </p>
              )}

              {canConvert && (
                <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
                  <form action={convert}>
                    <input type="hidden" name="id" value={application.id} />
                    <button
                      type="submit"
                      disabled={converting}
                      className="rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
                    >
                      {converting ? "Converting…" : "Convert to carrier"}
                    </button>
                  </form>
                  <button
                    type="button"
                    onClick={() => setRejectingId(rejectingId === application.id ? null : application.id)}
                    className="rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-sm font-semibold text-ink-700 transition hover:bg-ink-50"
                  >
                    Reject
                  </button>
                </div>
              )}

              {canConvert && rejectingId === application.id && (
                <form action={reject} className="flex flex-wrap items-end gap-2 border-t border-line px-4 py-3">
                  <input type="hidden" name="id" value={application.id} />
                  <label className="flex-1 text-sm">
                    <span className="mb-1 block font-medium text-ink-700">Reason</span>
                    {/* Required, because a rejection nobody can explain is one nobody can
                        answer a phone call about. */}
                    <input name="reason" required className="field" placeholder="Authority revoked, insurance lapsed…" />
                  </label>
                  <button
                    type="submit"
                    disabled={rejecting}
                    className="rounded-lg border border-red-300 bg-red-50 px-3.5 py-2 text-sm font-semibold text-red-700 transition hover:bg-red-100 disabled:opacity-60"
                  >
                    {rejecting ? "Rejecting…" : "Confirm rejection"}
                  </button>
                </form>
              )}
            </Card>
          ))}
        </div>
      )}

      {closed.length > 0 && (
        <details className="rounded-lg border border-line bg-surface">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-ink-700">
            Converted and rejected ({closed.length})
          </summary>
          <ul className="divide-y divide-line border-t border-line">
            {closed.map(({ application }) => (
              <li key={application.id} className="flex items-center justify-between gap-4 px-4 py-2.5 text-sm">
                <span className="text-ink-900">{application.legal_name}</span>
                <span className="flex items-center gap-3">
                  {application.rejected_reason && (
                    <span className="text-xs text-ink-500">{application.rejected_reason}</span>
                  )}
                  <Badge tone={TONE[application.status]}>{LABEL[application.status]}</Badge>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4 sm:block">
      <dt className="text-ink-500 sm:text-xs">{label}</dt>
      <dd className="font-medium text-ink-900">{value}</dd>
    </div>
  );
}
