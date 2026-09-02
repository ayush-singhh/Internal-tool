import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { carrierOptions } from "@/lib/form-options";
import { getCarrier } from "@/lib/carriers";
import { lookup } from "@/lib/lookups";
import { listInvoiceableLoads, computeDispatchFee } from "@/lib/invoices";
import { finalLoadAmount } from "@/lib/loads";
import { Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { InvoiceForm } from "@/components/invoice-form";

export const metadata: Metadata = { title: "Create Invoice" };

export default async function NewInvoicePage(props: PageProps<"/invoices/new">) {
  const { user, org } = await requireOrg();
  if (!can(user, "invoice:manage")) redirect("/invoices");

  const sp = await props.searchParams;
  const raw = Array.isArray(sp.carrier) ? sp.carrier[0] : sp.carrier;
  const carrierId = raw ? Number(raw) : null;
  const carriers = carrierOptions(org);

  let panel: React.ReactNode = null;
  if (carrierId) {
    const carrier = getCarrier(org, carrierId);
    if (!carrier) {
      panel = <EmptyState title="Unknown carrier" />;
    } else {
      const pricingType = lookup(org, carrier.pricing_type_id)?.value ?? null;
      // Probing with an arbitrary amount surfaces a carrier-level problem (no percentage
      // configured, or a pricing type that isn't per-load at all) without duplicating
      // computeDispatchFee's own validation here.
      const probe = computeDispatchFee({ pricingType, rate: carrier.rate, percentage: carrier.percentage }, 1);
      if (!probe.ok) {
        panel = (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {probe.error}
          </div>
        );
      } else {
        const eligible = listInvoiceableLoads(org, carrierId);
        panel =
          eligible.length === 0 ? (
            <EmptyState
              title="Nothing to invoice"
              description={`${carrier.legal_name} has no Delivered, uninvoiced loads right now.`}
            />
          ) : (
            <InvoiceForm
              carrierId={carrierId}
              carrierName={carrier.legal_name}
              loads={eligible.map((load) => {
                const amount = finalLoadAmount(load);
                const fee = amount === null
                  ? null
                  : computeDispatchFee({ pricingType, rate: carrier.rate, percentage: carrier.percentage }, amount);
                return {
                  load: { id: load.id, load_number: load.load_number, delivered_at: load.delivered_at },
                  finalAmount: amount,
                  feeAmount: fee && fee.ok ? fee.amount : null,
                };
              })}
            />
          );
      }
    }
  }

  return (
    <>
      <PageHeader title="Create Invoice" subtitle="Pick a carrier, then the Delivered loads to bill for dispatch." />
      <Card className="mb-5">
        <CardHeader title="Carrier" />
        <form className="flex flex-wrap items-end gap-3">
          <div className="min-w-[16rem] flex-1">
            <label className="label" htmlFor="carrier">Carrier</label>
            <select id="carrier" name="carrier" defaultValue={carrierId ?? ""} className="field w-full" required>
              <option value="" disabled>Choose a carrier</option>
              {carriers.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </div>
          <button className="rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50">
            Show loads
          </button>
        </form>
      </Card>
      {panel}
    </>
  );
}
