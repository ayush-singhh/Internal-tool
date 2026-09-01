import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { loadFormOptions } from "@/lib/form-options";
import { PageHeader } from "@/components/ui";
import { LoadForm } from "@/components/load-form";

export const metadata: Metadata = { title: "Create Load" };

export default async function NewLoadPage() {
  const { user, org } = await requireOrg();
  if (!can(user, "load:manage")) redirect("/loads");

  return (
    <>
      <PageHeader
        title="Create Load"
        subtitle="A load needs a carrier, at least one pickup and one delivery. Everything else can follow."
      />
      <LoadForm options={loadFormOptions(org)} />
    </>
  );
}
