"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { FormSection, Select, Text, TextArea, type FormOption } from "./form-fields";
import { Icon } from "./icons";
import { Badge } from "./ui";
import type { CarrierFormState } from "@/lib/carrier-actions";

export type CarrierFormOptions = {
  status: FormOption[];
  users: FormOption[];
  trailer_type: FormOption[];
  onboarding_type: FormOption[];
  lead_source: FormOption[];
  plan: FormOption[];
  pricing_type: FormOption[];
  billing_frequency: FormOption[];
  subscription: FormOption[];
  agreement_status: FormOption[];
  invoice_mode: FormOption[];
};

export type CarrierDefaults = Partial<Record<string, string>>;

type Action = (state: CarrierFormState, formData: FormData) => Promise<CarrierFormState>;

/** Pricing types that make the percentage field meaningful, and those that make the
 *  flat rate meaningful. Drives which of the two is shown. */
const PERCENT_TYPES = new Set(["percentage_per_load"]);
const RATE_TYPES = new Set(["fixed_monthly", "fixed_weekly"]);
const NO_PRICE_TYPES = new Set(["not_yet_pitched", "not_accepting"]);

/** Choosing a pricing type implies its billing frequency — one less thing to get wrong. */
const IMPLIED_FREQUENCY: Record<string, string> = {
  percentage_per_load: "per_load",
  fixed_monthly: "monthly",
  fixed_weekly: "weekly",
};

export function CarrierForm({
  action,
  mode,
  options,
  defaults = {},
  carrierId,
  cancelHref,
}: {
  action: Action;
  mode: "create" | "edit";
  options: CarrierFormOptions;
  defaults?: CarrierDefaults;
  carrierId?: number;
  cancelHref: string;
}) {
  const [state, formAction, pending] = useActionState<CarrierFormState, FormData>(action, {});
  const v = (name: string) => state.values?.[name] ?? defaults[name] ?? "";
  const err = (name: string) => state.errors?.[name];

  const [pricingTypeId, setPricingTypeId] = useState(v("pricing_type_id"));
  const [frequencyId, setFrequencyId] = useState(v("billing_frequency_id"));

  const pricingSlug =
    options.pricing_type.find((o) => String(o.id) === pricingTypeId)?.value ?? "";
  const showPercent = PERCENT_TYPES.has(pricingSlug);
  const showRate = RATE_TYPES.has(pricingSlug);
  const showNeither = pricingSlug !== "" && NO_PRICE_TYPES.has(pricingSlug);

  function onPricingTypeChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const id = e.target.value;
    setPricingTypeId(id);
    const slug = options.pricing_type.find((o) => String(o.id) === id)?.value ?? "";
    const impliedSlug = IMPLIED_FREQUENCY[slug];
    if (impliedSlug) {
      const match = options.billing_frequency.find((o) => o.value === impliedSlug);
      if (match) setFrequencyId(String(match.id));
    }
  }

  const duplicates = state.duplicates;
  const hasDuplicates =
    !!duplicates && (duplicates.mc.length > 0 || duplicates.usdot.length > 0);

  return (
    <form action={formAction} className="space-y-4 pb-24">
      {carrierId !== undefined && <input type="hidden" name="id" value={carrierId} />}

      {state.message && !hasDuplicates && (
        <p
          role="alert"
          className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
          {state.message}
        </p>
      )}

      {hasDuplicates && (
        <div className="rounded-card border border-amber-300 bg-amber-50 p-4">
          <div className="flex items-start gap-2.5">
            <span className="mt-px shrink-0 text-amber-600">
              <Icon name="warning" className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-amber-900">
                {state.message}
              </p>
              <p className="mt-1 text-xs text-amber-800">
                Review the existing record before continuing. MC number is our primary
                carrier identifier.
              </p>

              <ul className="mt-3 space-y-2">
                {[
                  ...duplicates.mc.map((d) => ({ d, on: "MC" as const })),
                  ...duplicates.usdot.map((d) => ({ d, on: "USDOT" as const })),
                ].map(({ d, on }) => (
                  <li
                    key={`${on}-${d.id}`}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-200 bg-surface px-3 py-2"
                  >
                    <span className="rounded bg-amber-100 px-1.5 py-px text-[0.68rem] font-semibold text-amber-800">
                      {on} match
                    </span>
                    <Link
                      href={`/carriers/${d.id}`}
                      target="_blank"
                      className="text-sm font-medium text-brand-700 underline-offset-2 hover:underline"
                    >
                      {d.legal_name}
                    </Link>
                    <span className="tnum text-xs text-ink-500">
                      {d.mc_number && `MC ${d.mc_number}`}
                      {d.mc_number && d.usdot && " · "}
                      {d.usdot && `USDOT ${d.usdot}`}
                    </span>
                    {d.status && <Badge>{d.status}</Badge>}
                    {d.dispatcher_name && (
                      <span className="text-xs text-ink-500">{d.dispatcher_name}</span>
                    )}
                  </li>
                ))}
              </ul>

              <label className="mt-3 flex items-start gap-2 text-xs font-medium text-amber-900">
                <input
                  type="checkbox"
                  name="confirm_duplicate"
                  value="yes"
                  required
                  className="mt-px h-3.5 w-3.5 accent-[var(--color-brand-600)]"
                />
                I have reviewed the existing record and this is a different carrier.
              </label>
            </div>
          </div>
        </div>
      )}

      <FormSection step={1} title="Basic Information">
        <Text name="legal_name" label="Lead Legal Name" required defaultValue={v("legal_name")} error={err("legal_name")} placeholder="Ironline Freight LLC" />
        <Text name="owner_name" label="Owner Name" defaultValue={v("owner_name")} error={err("owner_name")} placeholder="Andre Okafor" />
        <Text name="serial" label="Carrier ID / Serial" defaultValue={v("serial")} error={err("serial")} hint="Optional — your own reference number" />
      </FormSection>

      <FormSection step={2} title="Contact Information">
        <Text name="phone" label="Phone Number" type="tel" inputMode="tel" defaultValue={v("phone")} error={err("phone")} placeholder="(555) 123-4567" />
        <Text name="email" label="Email" type="email" inputMode="email" defaultValue={v("email")} error={err("email")} placeholder="dispatch@carrier.com" />
        <TextArea name="address" label="Address" rows={2} defaultValue={v("address")} error={err("address")} placeholder="1200 Industrial Pkwy, Dallas, TX 75201" className="sm:col-span-2 lg:col-span-1" />
      </FormSection>

      <FormSection step={3} title="Regulatory Information">
        <Text name="mc_number" label="MC Number" inputMode="numeric" defaultValue={v("mc_number")} error={err("mc_number")} placeholder="123456" hint="Digits only — our primary identifier" />
        <Text name="usdot" label="USDOT Number" inputMode="numeric" defaultValue={v("usdot")} error={err("usdot")} placeholder="1234567" hint="Digits only" />
      </FormSection>

      <FormSection step={4} title="Equipment">
        <Select name="trailer_type_id" label="Trailer Type" options={options.trailer_type} defaultValue={v("trailer_type_id")} error={err("trailer_type_id")} />
        <Text name="trailer_size" label="Trailer Size" defaultValue={v("trailer_size")} error={err("trailer_size")} placeholder="53'" />
        <Text name="truck_count" label="Number of Trucks / Trailers" type="number" inputMode="numeric" min={0} max={10000} defaultValue={v("truck_count")} error={err("truck_count")} />
      </FormSection>

      <FormSection step={5} title="Team Assignment">
        <Select name="dispatcher_id" label="Assigned Dispatcher" options={options.users} defaultValue={v("dispatcher_id")} error={err("dispatcher_id")} placeholder="Unassigned" />
        <Select name="account_manager_id" label="Account Manager" options={options.users} defaultValue={v("account_manager_id")} error={err("account_manager_id")} placeholder="Unassigned" />
        <Select name="status_id" label="Status" required options={options.status} defaultValue={v("status_id")} error={err("status_id")} />
      </FormSection>

      <FormSection step={6} title="Lead / Onboarding Information">
        <Select name="lead_source_id" label="Source of Lead" options={options.lead_source} defaultValue={v("lead_source_id")} error={err("lead_source_id")} />
        <Select name="onboarding_type_id" label="Onboarding Type" options={options.onboarding_type} defaultValue={v("onboarding_type_id")} error={err("onboarding_type_id")} />
        <Text name="born_date" label="Carrier Born Date" type="date" defaultValue={v("born_date")} error={err("born_date")} hint="When the carrier's authority began" />
        <Text name="onboarding_date" label="Onboarding Date" type="date" defaultValue={v("onboarding_date")} error={err("onboarding_date")} />
        <Text name="first_load_date" label="First Load Date" type="date" defaultValue={v("first_load_date")} error={err("first_load_date")} hint="Leave blank until the first load runs" />
      </FormSection>

      <FormSection step={7} title="Commercial Information" description="Pricing is stored as structured fields, not free text.">
        <Select name="plan_id" label="Plan Offered" options={options.plan} defaultValue={v("plan_id")} error={err("plan_id")} />
        <Select
          name="pricing_type_id"
          label="Pricing Type"
          options={options.pricing_type}
          value={pricingTypeId}
          onChange={onPricingTypeChange}
          error={err("pricing_type_id")}
        />
        <Select
          name="billing_frequency_id"
          label="Billing Frequency"
          options={options.billing_frequency}
          value={frequencyId}
          onChange={(e) => setFrequencyId(e.target.value)}
          error={err("billing_frequency_id")}
          hint="Set automatically from the pricing type"
        />

        {showPercent && (
          <Text name="percentage" label="Percentage" type="number" inputMode="decimal" min={0} max={100} step="0.01" defaultValue={v("percentage")} error={err("percentage")} hint="0–100" />
        )}
        {showRate && (
          <Text name="rate" label="Rate" type="number" inputMode="decimal" min={0} step="0.01" defaultValue={v("rate")} error={err("rate")} hint="Flat amount in USD" />
        )}
        {!showPercent && !showRate && !showNeither && (
          <>
            <Text name="percentage" label="Percentage" type="number" inputMode="decimal" min={0} max={100} step="0.01" defaultValue={v("percentage")} error={err("percentage")} hint="0–100, if applicable" />
            <Text name="rate" label="Rate" type="number" inputMode="decimal" min={0} step="0.01" defaultValue={v("rate")} error={err("rate")} hint="Flat amount, if applicable" />
          </>
        )}
        {showNeither && (
          <p className="self-end text-xs text-ink-500 sm:col-span-2">
            No rate or percentage is recorded for this pricing type.
          </p>
        )}
      </FormSection>

      <FormSection step={8} title="Agreement / Billing">
        <Select name="agreement_status_id" label="Agreement Status" options={options.agreement_status} defaultValue={v("agreement_status_id")} error={err("agreement_status_id")} />
        <Select name="subscription_id" label="Subscription" options={options.subscription} defaultValue={v("subscription_id")} error={err("subscription_id")} />
        <Select name="invoice_mode_id" label="Invoice Collection Mode" options={options.invoice_mode} defaultValue={v("invoice_mode_id")} error={err("invoice_mode_id")} />
      </FormSection>

      <FormSection step={9} title="Notes" columns={2}>
        <TextArea
          name="note"
          label={mode === "create" ? "Opening note" : "Add a note with this change"}
          rows={3}
          defaultValue={state.values?.note ?? ""}
          placeholder="Anything the next person picking up this carrier should know."
          className="sm:col-span-2"
        />
      </FormSection>

      <div className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur-sm sm:px-6 lg:pl-[calc(248px+2rem)] lg:pr-8">
        <div className="flex items-center justify-end gap-2">
          <Link
            href={cancelHref}
            className="rounded-lg border border-line-strong bg-surface px-4 py-2 text-sm font-semibold text-ink-700 transition hover:bg-ink-50"
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700 disabled:opacity-60"
          >
            {pending
              ? "Saving…"
              : hasDuplicates
                ? "Save anyway"
                : mode === "create"
                  ? "Create carrier"
                  : "Save changes"}
          </button>
        </div>
      </div>
    </form>
  );
}
