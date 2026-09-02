import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { listDrivers } from "@/lib/dispatch-admin";
import { carrierOptions } from "@/lib/form-options";
import { PageHeader } from "@/components/ui";
import { DriverManager } from "@/components/driver-manager";

export const metadata: Metadata = { title: "Drivers" };

export default async function DriversPage() {
  const { user, org } = await requireOrg();
  if (!can(user, "driver:manage")) redirect("/");

  return (
    <>
      <PageHeader
        title="Drivers"
        subtitle="Every driver dispatch can assign to a load, and the carrier they run for."
      />
      <DriverManager drivers={listDrivers(org)} carriers={carrierOptions(org)} />
    </>
  );
}
