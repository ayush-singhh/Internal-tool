"use client";

import { useActionState, useRef, useState } from "react";
import {
  addBrokerAction, updateBrokerAction, setBrokerDnuAction, type AdminState,
} from "@/lib/dispatch-admin-actions";
import type { BrokerRow } from "@/lib/dispatch-admin";
import { relativeTime } from "@/lib/format";
import { Badge, Banner, Dialog, DialogActions, EmptyState } from "./ui";
import { Icon } from "./icons";
import { Text, TextArea } from "./form-fields";

export function BrokerManager({
  brokers,
  canCreate,
  canEdit,
}: {
  brokers: BrokerRow[];
  canCreate: boolean;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState<BrokerRow | null>(null);
  const [flagging, setFlagging] = useState<BrokerRow | null>(null);
  const [q, setQ] = useState("");
  const addRef = useRef<HTMLDialogElement>(null);
  const editRef = useRef<HTMLDialogElement>(null);
  const dnuRef = useRef<HTMLDialogElement>(null);

  const rows = q.trim()
    ? brokers.filter((b) => b.name.toLowerCase().includes(q.trim().toLowerCase()))
    : brokers;

  const blocked = brokers.filter((b) => b.dnu === 1);

  return (
    <div className="space-y-4">
      {/*
        The Do Not Use list, at the top of the page it belongs to rather than on a route
        of its own. A second page listing a subset of one table is a filter, and a filter
        that lives away from the thing it filters goes stale in somebody's memory.
      */}
      {blocked.length > 0 && (
        <section
          aria-label="Do Not Use list"
          className="rounded-card border border-red-200 bg-red-50/60 p-4"
        >
          <h2 className="flex items-center gap-2 text-sm font-semibold text-red-800">
            <Icon name="warning" className="h-4 w-4" />
            Do Not Use — {blocked.length} broker{blocked.length === 1 ? "" : "s"}
          </h2>
          <ul className="mt-2.5 space-y-1.5">
            {blocked.map((b) => (
              <li key={b.id} className="text-xs text-red-900">
                <span className="font-semibold">{b.name}</span>
                {b.dnu_reason && <span> — {b.dnu_reason}</span>}
                <span className="text-red-700/70">
                  {b.dnu_by_name && ` · ${b.dnu_by_name}`}
                  {b.dnu_at && ` · ${relativeTime(b.dnu_at)}`}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-2.5 text-xs text-red-700">
            A load cannot be created against these. Loads already booked with them are
            untouched — flagging a broker today does not rewrite what has already run.
          </p>
        </section>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative min-w-[15rem] flex-1">
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Filter brokers…"
            aria-label="Filter brokers"
            className="field w-full pl-9"
          />
        </div>
        {canCreate && (
          <button
            type="button"
            onClick={() => addRef.current?.showModal()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700"
          >
            <Icon name="plus" className="h-4 w-4" />
            Add broker
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <EmptyState title="No brokers match" description="Try a different search." />
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-ink-50/70">
                {["Name", "MC #", "Contact", "Phone", "Source", "Loads", "Status", ""].map((h, i) => (
                  <th
                    key={h || i}
                    scope="col"
                    className={`px-4 py-2.5 text-xs font-semibold text-ink-600 ${
                      i === 5 ? "text-right" : "text-left"
                    }`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr
                  key={b.id}
                  className={`border-b border-line/70 last:border-0 ${
                    b.dnu ? "bg-red-50/40" : b.active ? "" : "opacity-60"
                  }`}
                >
                  <td className="px-4 py-2.5 font-medium text-ink-900">
                    {b.name}
                    {b.dnu === 1 && b.dnu_reason && (
                      <span className="mt-0.5 block text-xs font-normal text-red-700">{b.dnu_reason}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-ink-600">{b.mc_number ?? "—"}</td>
                  <td className="px-4 py-2.5 text-ink-600">{b.contact_name ?? "—"}</td>
                  <td className="px-4 py-2.5 text-ink-600">{b.phone ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={b.seeded ? "slate" : "blue"}>{b.seeded ? "Shipped" : "Added"}</Badge>
                  </td>
                  <td className="tnum px-4 py-2.5 text-right text-ink-700">{b.load_count}</td>
                  <td className="px-4 py-2.5">
                    {b.dnu === 1 ? (
                      <Badge tone="red">Do Not Use</Badge>
                    ) : (
                      <Badge tone={b.active ? "green" : "slate"}>{b.active ? "Active" : "Retired"}</Badge>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {canEdit && (
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => { setFlagging(b); dnuRef.current?.showModal(); }}
                          className={`rounded px-2 py-1 text-xs font-medium transition ${
                            b.dnu
                              ? "text-emerald-700 hover:bg-emerald-50"
                              : "text-red-600 hover:bg-red-50"
                          }`}
                        >
                          {b.dnu ? "Allow again" : "Do not use"}
                        </button>
                        <button
                          type="button"
                          onClick={() => { setEditing(b); editRef.current?.showModal(); }}
                          className="rounded p-1.5 text-ink-500 transition hover:bg-ink-100 hover:text-ink-900"
                          title={`Edit ${b.name}`}
                        >
                          <Icon name="edit" className="h-4 w-4" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-ink-500">
        Dispatch can add a broker the shipped list is missing. Correcting or retiring one is
        an administrator's job, so a typo never quietly becomes a second broker.
      </p>

      {canCreate && (
        <Dialog ref={addRef} title="Add a broker">
          <AddBrokerForm dialogRef={addRef} />
        </Dialog>
      )}

      {canEdit && (
        <>
          <Dialog ref={editRef} title={editing ? `Edit ${editing.name}` : "Edit broker"}>
            {editing && <EditBrokerForm broker={editing} dialogRef={editRef} />}
          </Dialog>
          <Dialog
            ref={dnuRef}
            title={
              flagging
                ? flagging.dnu
                  ? `Allow ${flagging.name} again`
                  : `Do not use ${flagging.name}`
                : "Do Not Use"
            }
          >
            {flagging && <DnuForm broker={flagging} dialogRef={dnuRef} />}
          </Dialog>
        </>
      )}
    </div>
  );
}

/**
 * Flagging a broker, or clearing the flag.
 *
 * A reason is required to flag and is wiped when the flag is cleared — a stale reason on a
 * broker who is fine again reads as though the flag is still on.
 */
function DnuForm({
  broker,
  dialogRef,
}: {
  broker: BrokerRow;
  dialogRef: React.RefObject<HTMLDialogElement | null>;
}) {
  const [state, action, pending] = useActionState<AdminState, FormData>(setBrokerDnuAction, {});
  const clearing = broker.dnu === 1;
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="id" value={broker.id} />
      <input type="hidden" name="dnu" value={clearing ? "0" : "1"} />
      <Banner state={state} />
      {clearing ? (
        <>
          <p className="text-sm text-ink-600">
            {broker.name} was flagged
            {broker.dnu_by_name ? ` by ${broker.dnu_by_name}` : ""}
            {broker.dnu_reason ? `: ${broker.dnu_reason}` : "."}
          </p>
          <p className="text-sm text-ink-600">
            Clearing it lets loads be booked against them again, and removes the reason.
          </p>
        </>
      ) : (
        <>
          <p className="text-sm text-ink-600">
            No new load can be created against {broker.name}. The{" "}
            {broker.load_count === 1 ? "load" : "loads"} already booked with them —{" "}
            {broker.load_count} — {broker.load_count === 1 ? "is" : "are"} untouched.
          </p>
          <TextArea
            name="dnu_reason"
            label="Why"
            rows={3}
            placeholder="Slow pay, disputed a detention charge, cannot reach anyone…"
            hint="Required. Whoever hits this in six months needs to know what happened."
          />
        </>
      )}
      <DialogActions
        dialogRef={dialogRef}
        pending={pending}
        label={clearing ? "Allow again" : "Add to Do Not Use"}
      />
    </form>
  );
}

function AddBrokerForm({ dialogRef }: { dialogRef: React.RefObject<HTMLDialogElement | null> }) {
  const [state, action, pending] = useActionState<AdminState, FormData>(addBrokerAction, {});
  return (
    <form action={action} className="space-y-4">
      <Banner state={state} />
      <Text name="name" label="Broker name" required />
      <p className="text-xs text-ink-500">
        An administrator can correct the details afterward — MC number, contact, phone.
      </p>
      <DialogActions dialogRef={dialogRef} pending={pending} label="Add broker" />
    </form>
  );
}

function EditBrokerForm({
  broker,
  dialogRef,
}: {
  broker: BrokerRow;
  dialogRef: React.RefObject<HTMLDialogElement | null>;
}) {
  const [state, action, pending] = useActionState<AdminState, FormData>(updateBrokerAction, {});
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="id" value={broker.id} />
      <Banner state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Text name="name" label="Broker name" required defaultValue={broker.name} />
        <Text name="mc_number" label="MC Number" defaultValue={broker.mc_number ?? ""} />
        <Text name="contact_name" label="Contact" defaultValue={broker.contact_name ?? ""} />
        <Text name="phone" label="Phone" type="tel" defaultValue={broker.phone ?? ""} />
        <Text name="email" label="Email" type="email" defaultValue={broker.email ?? ""} />
        {/* A boolean stored as a lookup-id select would misread — same reasoning as RoleSelect. */}
        <div>
          <label className="label" htmlFor="active">Status</label>
          <select id="active" name="active" defaultValue={broker.active === 1 ? "1" : "0"} className="field">
            <option value="1">Active</option>
            <option value="0">Retired</option>
          </select>
        </div>
      </div>
      <DialogActions dialogRef={dialogRef} pending={pending} label="Save changes" />
    </form>
  );
}
