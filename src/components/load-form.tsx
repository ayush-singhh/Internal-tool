"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { createLoadAction, type LoadFormState } from "@/lib/load-actions";
import { FormSection, Select, Text, TextArea, type FormOption } from "./form-fields";
import { Icon } from "./icons";

export type LoadFormOptions = {
  carriers: FormOption[];
  drivers: (FormOption & { carrierId: number | null })[];
  brokers: FormOption[];
};

/**
 * Creating a load.
 *
 * Three details here are requirements rather than styling, all of them from the review of
 * the previous app:
 *
 *   - **No pre-filled zeros.** Numeric fields start empty. A field showing `0` that types
 *     as `0233` is worse than an empty one, and people could not delete the zero.
 *   - **No generated load number.** Formats differ per broker, so the field starts blank
 *     rather than inventing `L-0394`.
 *   - **One "add" button per kind**, appearing after the last row — not five plus-icons
 *     stacked up front.
 */
type StopRow = { key: number };

export function LoadForm({ options }: { options: LoadFormOptions }) {
  const [state, action, pending] = useActionState<LoadFormState, FormData>(createLoadAction, {});
  const [carrierId, setCarrierId] = useState("");
  const [pickups, setPickups] = useState<StopRow[]>([{ key: 0 }]);
  const [deliveries, setDeliveries] = useState<StopRow[]>([{ key: 0 }]);
  const [nextKey, setNextKey] = useState(1);

  // Assigning a driver picks the carrier for you: a driver belongs to one carrier, so
  // asking twice invites the two to disagree.
  const drivers = carrierId
    ? options.drivers.filter((d) => d.carrierId === Number(carrierId) || d.carrierId === null)
    : options.drivers;

  const addRow = (kind: "pickup" | "delivery") => {
    const row = { key: nextKey };
    setNextKey(nextKey + 1);
    if (kind === "pickup") setPickups([...pickups, row]);
    else setDeliveries([...deliveries, row]);
  };

  const stopRows = (kind: "pickup" | "delivery", rows: StopRow[], setRows: (r: StopRow[]) => void) => (
    <div className="sm:col-span-2 lg:col-span-3">
      <div className="space-y-3">
        {rows.map((row, i) => (
          <div key={row.key} className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
            <Text
              name={`${kind}_city`}
              label={`${kind === "pickup" ? "Pickup" : "Delivery"} ${i + 1} — City`}
              placeholder="Dallas"
              required={i === 0}
            />
            <Text name={`${kind}_state`} label="State" placeholder="TX" maxLength={2} />
            <Text name={`${kind}_address`} label="Address" placeholder="Optional" />
            <div className="flex items-end gap-2">
              <Text name={`${kind}_at`} label="Scheduled" type="datetime-local" className="flex-1" />
              {rows.length > 1 && (
                <button
                  type="button"
                  onClick={() => setRows(rows.filter((r) => r.key !== row.key))}
                  className="mb-1 rounded-lg border border-line-strong bg-surface p-2 text-ink-500 hover:bg-ink-50"
                  aria-label={`Remove ${kind} ${i + 1}`}
                >
                  <Icon name="close" className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {rows.length < 5 && (
        <button
          type="button"
          onClick={() => addRow(kind)}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-xs font-semibold text-ink-700 hover:bg-ink-50"
        >
          <Icon name="plus" className="h-3.5 w-3.5" />
          Add {kind === "pickup" ? "pickup" : "delivery"}
        </button>
      )}
    </div>
  );

  return (
    <form action={action} className="space-y-5">
      {state.error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-800">
          {state.error}
        </p>
      )}

      <FormSection step={1} title="Load" description="Load number is typed, never generated — formats differ per broker.">
        <Text name="load_number" label="Load Number" placeholder="As the broker wrote it" />
        <Select
          name="carrier_id"
          label="Carrier"
          options={options.carriers}
          required
          value={carrierId}
          onChange={(e) => setCarrierId(e.target.value)}
          placeholder="Choose a carrier…"
        />
        <Select name="broker_id" label="Brokerage" options={options.brokers} placeholder="Unassigned" />
      </FormSection>

      <FormSection step={2} title="Pickups" description="Up to five. The first is the origin." columns={3}>
        {stopRows("pickup", pickups, setPickups)}
      </FormSection>

      <FormSection step={3} title="Deliveries" description="Up to five. The last is the destination." columns={3}>
        {stopRows("delivery", deliveries, setDeliveries)}
      </FormSection>

      <FormSection step={4} title="Freight">
        <Text name="commodity" label="Commodity" placeholder="Frozen peas" />
        <Text name="weight_lbs" label="Weight (lbs)" inputMode="numeric" placeholder="42000" />
        <Text name="temperature_f" label="Temperature (°F)" inputMode="decimal" placeholder="Reefer only" hint="Leave blank unless it is a reefer load" />
      </FormSection>

      <FormSection step={5} title="Miles and rate" description="Rate per mile is calculated from these — it is never typed.">
        <Text name="deadhead_miles" label="Deadhead Miles" inputMode="decimal" placeholder="Empty miles to the pickup" />
        <Text name="loaded_miles" label="Loaded Miles" inputMode="decimal" placeholder="Pickup to delivery" />
        <Text name="rate" label="Rate (USD)" inputMode="decimal" placeholder="2000" />
      </FormSection>

      <FormSection step={6} title="Driver and notes" columns={2}>
        <Select
          name="driver_id"
          label="Assign Driver"
          options={drivers}
          placeholder="Leave unassigned for now"
          hint="Assigning a driver moves the load straight to Assigned"
        />
        <TextArea name="special_instructions" label="Special Instructions" rows={3} />
      </FormSection>

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
        >
          {pending ? "Creating…" : "Create Load"}
        </button>
        <Link href="/loads" className="text-sm font-medium text-ink-600 hover:text-ink-900">
          Cancel
        </Link>
      </div>
    </form>
  );
}
