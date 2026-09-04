"use client";

import Link from "next/link";
import { useActionState, useRef, useState } from "react";
import { saveLeadAction, convertLeadAction, type LeadState } from "@/lib/lead-actions";
import type { LeadRow } from "@/lib/leads";
import {
  LEAD_STATUS, LEAD_STATUS_LABELS, LEAD_STATUS_SETTABLE, LEAD_STATUS_TONE,
} from "@/lib/constants";
import { Badge, Banner, Dialog, DialogActions, EmptyState } from "./ui";
import { Icon } from "./icons";
import { Text, Select, TextArea, type FormOption } from "./form-fields";

export type LeadOptions = {
  trailerTypes: FormOption[];
  sources: FormOption[];
  owners: FormOption[];
};

export function LeadManager({
  leads,
  options,
  canCreate,
  canConvert,
  currentUserId,
}: {
  leads: LeadRow[];
  options: LeadOptions;
  canCreate: boolean;
  /** Administrators only. Also what decides whether the owner picker renders at all. */
  canConvert: boolean;
  currentUserId: number;
}) {
  const [editing, setEditing] = useState<LeadRow | null>(null);
  const [converting, setConverting] = useState<LeadRow | null>(null);
  const addRef = useRef<HTMLDialogElement>(null);
  const editRef = useRef<HTMLDialogElement>(null);
  const convertRef = useRef<HTMLDialogElement>(null);

  const open = leads.filter((l) => l.status !== LEAD_STATUS.WON && l.status !== LEAD_STATUS.LOST);
  const won = leads.filter((l) => l.status === LEAD_STATUS.WON);

  /** A converted lead is history and is read-only for everyone. Otherwise it is the
   *  owner's, or an administrator's — the server re-checks both, this only hides. */
  const mayEdit = (lead: LeadRow) =>
    !lead.converted_carrier_id && (canConvert || lead.owner_id === currentUserId);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-500">
          {open.length} open · {won.length} converted · {leads.length} total
        </p>
        {canCreate && (
          <button
            type="button"
            onClick={() => addRef.current?.showModal()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700"
          >
            <Icon name="plus" className="h-4 w-4" />
            Submit lead
          </button>
        )}
      </div>

      {leads.length === 0 ? (
        <EmptyState
          title="No leads yet"
          description="A lead is a carrier prospect before there is a carrier record. Submit one to start tracking it."
          action={
            canCreate ? (
              <button
                type="button"
                onClick={() => addRef.current?.showModal()}
                className="rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700"
              >
                Submit the first lead
              </button>
            ) : undefined
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-ink-50/70">
                {["Company", "Contact", "Phone", "MC #", "Trucks", "Source", "Owner", "Stage", ""].map((h, i) => (
                  <th
                    key={h || i}
                    scope="col"
                    className={`px-4 py-2.5 text-xs font-semibold text-ink-600 ${
                      i === 4 ? "text-right" : "text-left"
                    }`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {leads.map((lead) => (
                <tr
                  key={lead.id}
                  className={`border-b border-line/70 last:border-0 ${
                    lead.converted_carrier_id ? "opacity-70" : ""
                  }`}
                >
                  <td className="px-4 py-2.5 font-medium text-ink-900">{lead.company_name}</td>
                  <td className="px-4 py-2.5 text-ink-600">{lead.contact_name ?? "—"}</td>
                  <td className="px-4 py-2.5 text-ink-600">{lead.phone ?? "—"}</td>
                  <td className="px-4 py-2.5 text-ink-600">{lead.mc_number ?? "—"}</td>
                  <td className="tnum px-4 py-2.5 text-right text-ink-700">{lead.truck_count ?? "—"}</td>
                  <td className="px-4 py-2.5 text-ink-600">{lead.source_label ?? "—"}</td>
                  <td className="px-4 py-2.5 text-ink-600">{lead.owner_name ?? "Unassigned"}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={LEAD_STATUS_TONE[lead.status]}>{LEAD_STATUS_LABELS[lead.status]}</Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-1.5">
                      {mayEdit(lead) && (
                        <button
                          type="button"
                          onClick={() => { setEditing(lead); editRef.current?.showModal(); }}
                          className="rounded p-1.5 text-ink-500 transition hover:bg-ink-100 hover:text-ink-900"
                          title={`Edit ${lead.company_name}`}
                        >
                          <Icon name="edit" className="h-4 w-4" />
                        </button>
                      )}
                      {canConvert && !lead.converted_carrier_id && lead.status !== LEAD_STATUS.LOST && (
                        <button
                          type="button"
                          onClick={() => { setConverting(lead); convertRef.current?.showModal(); }}
                          className="rounded px-2 py-1 text-xs font-medium text-brand-600 transition hover:bg-brand-50"
                        >
                          Convert
                        </button>
                      )}
                      {lead.converted_carrier_id && (
                        <Link
                          href={`/carriers/${lead.converted_carrier_id}`}
                          className="rounded px-2 py-1 text-xs font-medium text-brand-600 hover:underline"
                        >
                          View carrier
                        </Link>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-ink-500">
        Converting a lead creates a carrier record and keeps the lead as the history of how
        that carrier arrived. A converted lead can no longer be edited.
      </p>

      <Dialog ref={addRef} title="Submit a lead">
        <LeadForm options={options} canAssign={canConvert} dialogRef={addRef} />
      </Dialog>

      <Dialog ref={editRef} title={editing ? `Edit ${editing.company_name}` : "Edit lead"}>
        {editing && (
          <LeadForm lead={editing} options={options} canAssign={canConvert} dialogRef={editRef} />
        )}
      </Dialog>

      <Dialog ref={convertRef} title={converting ? `Convert ${converting.company_name}` : "Convert lead"}>
        {converting && <ConvertForm lead={converting} dialogRef={convertRef} />}
      </Dialog>
    </div>
  );
}

function LeadForm({
  lead,
  options,
  canAssign,
  dialogRef,
}: {
  lead?: LeadRow;
  options: LeadOptions;
  canAssign: boolean;
  dialogRef: React.RefObject<HTMLDialogElement | null>;
}) {
  const [state, action, pending] = useActionState<LeadState, FormData>(saveLeadAction, {});
  return (
    <form action={action} className="space-y-4">
      {lead && <input type="hidden" name="id" value={lead.id} />}
      <Banner state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Text name="company_name" label="Company name" required defaultValue={lead?.company_name} />
        <Text name="contact_name" label="Contact" defaultValue={lead?.contact_name ?? ""} />
        <Text name="phone" label="Phone" type="tel" defaultValue={lead?.phone ?? ""} />
        <Text name="email" label="Email" type="email" defaultValue={lead?.email ?? ""} />
        <Text name="mc_number" label="MC Number" defaultValue={lead?.mc_number ?? ""} />
        <Text name="usdot" label="USDOT" defaultValue={lead?.usdot ?? ""} />
        <Text
          name="truck_count"
          label="Trucks / trailers"
          type="number"
          defaultValue={lead?.truck_count != null ? String(lead.truck_count) : ""}
        />
        <Select
          name="trailer_type_id"
          label="Trailer type"
          options={options.trailerTypes}
          defaultValue={lead?.trailer_type_id != null ? String(lead.trailer_type_id) : undefined}
        />
        <Select
          name="lead_source_id"
          label="Lead source"
          options={options.sources}
          defaultValue={lead?.lead_source_id != null ? String(lead.lead_source_id) : undefined}
        />
        <StatusSelect defaultValue={lead?.status} />
        {canAssign && (
          <Select
            name="owner_id"
            label="Owner"
            options={options.owners}
            defaultValue={lead?.owner_id != null ? String(lead.owner_id) : undefined}
            placeholder="Unassigned"
            hint="Who is working this lead."
          />
        )}
      </div>
      <TextArea name="notes" label="Notes" defaultValue={lead?.notes ?? ""} rows={3} />
      <DialogActions dialogRef={dialogRef} pending={pending} label={lead ? "Save changes" : "Submit lead"} />
    </form>
  );
}

/** Won is absent by construction: it is what conversion writes, so it is never offered. */
function StatusSelect({ defaultValue }: { defaultValue?: string }) {
  return (
    <div>
      <label htmlFor="status" className="mb-1 block text-xs font-medium text-ink-600">
        Stage
      </label>
      <select id="status" name="status" defaultValue={defaultValue ?? LEAD_STATUS.NEW} className="field">
        {LEAD_STATUS_SETTABLE.map((s) => (
          <option key={s} value={s}>{LEAD_STATUS_LABELS[s]}</option>
        ))}
      </select>
    </div>
  );
}

function ConvertForm({
  lead,
  dialogRef,
}: {
  lead: LeadRow;
  dialogRef: React.RefObject<HTMLDialogElement | null>;
}) {
  const [state, action, pending] = useActionState<LeadState, FormData>(convertLeadAction, {});
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="id" value={lead.id} />
      <Banner state={state} />
      <p className="text-sm text-ink-600">
        This creates a carrier record for <strong>{lead.company_name}</strong> at status
        “About to Be Active”, carrying across the contact, MC/USDOT, fleet and lead source
        already on the lead. Nothing else is invented — plan, pricing and the agreement are
        filled in on the carrier profile afterwards.
      </p>
      <p className="text-sm text-ink-600">
        The lead is kept and marked Won. It cannot be converted or edited again.
      </p>
      <DialogActions dialogRef={dialogRef} pending={pending} label="Create carrier record" />
    </form>
  );
}
