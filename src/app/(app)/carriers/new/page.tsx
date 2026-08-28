import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { carrierFormOptions } from "@/lib/form-options";
import { idOf } from "@/lib/lookups";
import { STATUS } from "@/lib/constants";
import { createCarrierAction } from "@/lib/carrier-actions";
import { CarrierForm } from "@/components/carrier-form";
import { PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Add Carrier" };

export default async function NewCarrierPage() {
  const { user, org } = await requireOrg();
  if (!can(user, "carrier:create")) redirect("/carriers");

  const options = carrierFormOptions(org);

  // Sensible starting point: a brand new carrier is almost always onboarding, with
  // paperwork pending and nothing billed yet.
  const defaults: Record<string, string> = {
    onboarding_date: new Date().toISOString().slice(0, 10),
  };
  const set = (key: string, id: number | undefined) => {
    if (id !== undefined) defaults[key] = String(id);
  };
  set("status_id", idOf(org, "status", STATUS.ABOUT_TO_BE_ACTIVE));
  set("subscription_id", idOf(org, "subscription", "none"));
  set("agreement_status_id", idOf(org, "agreement_status", "pending"));
  set("invoice_mode_id", idOf(org, "invoice_mode", "not_set"));
  if (user.role === "dispatcher") set("dispatcher_id", user.id);
  if (user.role === "account_manager") set("account_manager_id", user.id);

  return (
    <>
      <PageHeader
        title="Add Carrier"
        subtitle="Nine short sections. Dropdowns and date pickers throughout — nothing needs formatting by hand."
      />
      <CarrierForm
        action={createCarrierAction}
        mode="create"
        options={options}
        defaults={defaults}
        cancelHref="/carriers"
      />
    </>
  );
}
