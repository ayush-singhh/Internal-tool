import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { listBrokers } from "@/lib/dispatch-admin";
import { PageHeader } from "@/components/ui";
import { BrokerManager } from "@/components/broker-manager";

export const metadata: Metadata = { title: "Brokers" };

export default async function BrokersPage() {
  const { user, org } = await requireOrg();
  const canCreate = can(user, "broker:create");
  const canEdit = can(user, "broker:edit");
  if (!canCreate && !canEdit) redirect("/");

  return (
    <>
      <PageHeader
        title="Brokers"
        subtitle="The shipped list, plus anything dispatch has added. Corrections are an administrator's job."
      />
      <BrokerManager brokers={listBrokers(org)} canCreate={canCreate} canEdit={canEdit} />
    </>
  );
}
