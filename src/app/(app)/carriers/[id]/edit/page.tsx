import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { getCarrier } from "@/lib/carriers";
import { carrierFormOptions } from "@/lib/form-options";
import { updateCarrierAction } from "@/lib/carrier-actions";
import { CarrierForm } from "@/components/carrier-form";
import { PageHeader } from "@/components/ui";

export async function generateMetadata(
  props: PageProps<"/carriers/[id]/edit">,
): Promise<Metadata> {
  const { org } = await requireOrg();
  const { id } = await props.params;
  const carrier = getCarrier(org, Number(id));
  return { title: carrier ? `Edit ${carrier.legal_name}` : "Edit Carrier" };
}

export default async function EditCarrierPage(props: PageProps<"/carriers/[id]/edit">) {
  const { user, org } = await requireOrg();
  const { id } = await props.params;
  const carrierId = Number(id);
  if (!Number.isInteger(carrierId)) notFound();

  const carrier = getCarrier(org, carrierId);
  if (!carrier) notFound();
  if (!can(user, "carrier:edit", carrier)) redirect(`/carriers/${carrierId}`);

  // Every stored value is pre-filled, so saving without touching a field is a no-op
  // rather than a way to accidentally blank something.
  const defaults: Record<string, string> = {};
  const put = (key: string, value: string | number | null) => {
    if (value !== null && value !== undefined) defaults[key] = String(value);
  };
  put("serial", carrier.serial);
  put("legal_name", carrier.legal_name);
  put("owner_name", carrier.owner_name);
  put("phone", carrier.phone);
  put("email", carrier.email);
  put("address", carrier.address);
  put("status_id", carrier.status_id);
  put("dispatcher_id", carrier.dispatcher_id);
  put("account_manager_id", carrier.account_manager_id);
  put("mc_number", carrier.mc_number);
  put("usdot", carrier.usdot);
  put("trailer_type_id", carrier.trailer_type_id);
  put("trailer_size", carrier.trailer_size);
  put("truck_count", carrier.truck_count);
  put("born_date", carrier.born_date);
  put("onboarding_date", carrier.onboarding_date);
  put("first_load_date", carrier.first_load_date);
  put("onboarding_type_id", carrier.onboarding_type_id);
  put("lead_source_id", carrier.lead_source_id);
  put("plan_id", carrier.plan_id);
  put("pricing_type_id", carrier.pricing_type_id);
  put("rate", carrier.rate);
  put("percentage", carrier.percentage);
  put("billing_frequency_id", carrier.billing_frequency_id);
  put("subscription_id", carrier.subscription_id);
  put("agreement_status_id", carrier.agreement_status_id);
  put("invoice_mode_id", carrier.invoice_mode_id);

  return (
    <>
      <PageHeader
        title={`Edit ${carrier.legal_name}`}
        subtitle="Changes to status, assignment, pricing, agreement and subscription are recorded in the carrier's history."
      />
      <CarrierForm
        action={updateCarrierAction}
        mode="edit"
        options={carrierFormOptions(org)}
        defaults={defaults}
        carrierId={carrier.id}
        cancelHref={`/carriers/${carrier.id}`}
      />
    </>
  );
}
