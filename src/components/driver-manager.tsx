"use client";

import { useActionState, useRef, useState } from "react";
import {
  saveDriverAction, toggleDriverAction, type AdminState,
} from "@/lib/dispatch-admin-actions";
import type { DriverRow } from "@/lib/dispatch-admin";
import { Badge, Banner, Dialog, DialogActions, EmptyState } from "./ui";
import { Icon } from "./icons";
import { Text, Select, TextArea, type FormOption } from "./form-fields";

export function DriverManager({ drivers, carriers }: { drivers: DriverRow[]; carriers: FormOption[] }) {
  const [editing, setEditing] = useState<DriverRow | null>(null);
  const addRef = useRef<HTMLDialogElement>(null);
  const editRef = useRef<HTMLDialogElement>(null);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-500">
          {drivers.filter((d) => d.active).length} active ·{" "}
          {drivers.filter((d) => !d.active).length} deactivated
        </p>
        <button
          type="button"
          onClick={() => addRef.current?.showModal()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700"
        >
          <Icon name="plus" className="h-4 w-4" />
          Add driver
        </button>
      </div>

      {drivers.length === 0 ? (
        <EmptyState
          title="No drivers yet"
          description="Add a driver to assign them to loads. Owner-operators can be left without a carrier."
          action={
            <button
              type="button"
              onClick={() => addRef.current?.showModal()}
              className="rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700"
            >
              Add the first driver
            </button>
          }
        />
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-ink-50/70">
                {["Name", "Carrier", "Truck #", "Phone", "CDL Expires", "Open Loads", "Status", ""].map((h, i) => (
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
              {drivers.map((d) => (
                <tr key={d.id} className={`border-b border-line/70 last:border-0 ${d.active ? "" : "opacity-60"}`}>
                  <td className="px-4 py-2.5 font-medium text-ink-900">{d.name}</td>
                  <td className="px-4 py-2.5 text-ink-600">{d.carrier_name ?? "Owner-operator"}</td>
                  <td className="px-4 py-2.5 text-ink-600">{d.truck_number ?? "—"}</td>
                  <td className="px-4 py-2.5 text-ink-600">{d.phone ?? "—"}</td>
                  <td className="px-4 py-2.5 text-ink-600">{d.cdl_expires_on ?? "—"}</td>
                  <td className="tnum px-4 py-2.5 text-right text-ink-700">{d.open_loads}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={d.active ? "green" : "slate"}>{d.active ? "Active" : "Deactivated"}</Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => { setEditing(d); editRef.current?.showModal(); }}
                        className="rounded p-1.5 text-ink-500 transition hover:bg-ink-100 hover:text-ink-900"
                        title={`Edit ${d.name}`}
                      >
                        <Icon name="edit" className="h-4 w-4" />
                      </button>
                      <form action={toggleDriverAction}>
                        <input type="hidden" name="id" value={d.id} />
                        <input type="hidden" name="active" value={d.active ? "0" : "1"} />
                        <button
                          type="submit"
                          disabled={d.active === 1 && d.open_loads > 0}
                          title={
                            d.active === 1 && d.open_loads > 0
                              ? `Still on ${d.open_loads} open load${d.open_loads === 1 ? "" : "s"}`
                              : undefined
                          }
                          className="rounded px-2 py-1 text-xs font-medium text-ink-500 transition hover:bg-ink-100 hover:text-ink-900 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {d.active ? "Deactivate" : "Reactivate"}
                        </button>
                      </form>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-ink-500">
        Deactivating keeps a driver on every load they ever ran. A driver still on an open
        load cannot be deactivated out from under it.
      </p>

      <Dialog ref={addRef} title="Add a driver">
        <DriverForm carriers={carriers} dialogRef={addRef} />
      </Dialog>

      <Dialog ref={editRef} title={editing ? `Edit ${editing.name}` : "Edit driver"}>
        {editing && <DriverForm driver={editing} carriers={carriers} dialogRef={editRef} />}
      </Dialog>
    </div>
  );
}

function DriverForm({
  driver,
  carriers,
  dialogRef,
}: {
  driver?: DriverRow;
  carriers: FormOption[];
  dialogRef: React.RefObject<HTMLDialogElement | null>;
}) {
  const [state, action, pending] = useActionState<AdminState, FormData>(saveDriverAction, {});
  return (
    <form action={action} className="space-y-4">
      {driver && <input type="hidden" name="id" value={driver.id} />}
      <Banner state={state} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Text name="name" label="Full name" required defaultValue={driver?.name} />
        <Select
          name="carrier_id"
          label="Carrier"
          options={carriers}
          defaultValue={driver?.carrier_id != null ? String(driver.carrier_id) : undefined}
          placeholder="Owner-operator / unassigned"
        />
        <Text name="phone" label="Phone" type="tel" defaultValue={driver?.phone ?? ""} />
        <Text name="email" label="Email" type="email" defaultValue={driver?.email ?? ""} />
        <Text name="truck_number" label="Truck #" defaultValue={driver?.truck_number ?? ""} />
        <Text name="cdl_number" label="CDL Number" defaultValue={driver?.cdl_number ?? ""} />
        <Text name="cdl_expires_on" label="CDL Expires" type="date" defaultValue={driver?.cdl_expires_on ?? ""} />
      </div>
      <TextArea name="notes" label="Notes" defaultValue={driver?.notes ?? ""} rows={2} />
      <DialogActions dialogRef={dialogRef} pending={pending} label={driver ? "Save changes" : "Add driver"} />
    </form>
  );
}
