import type { Metadata } from "next";
import { CarrierListView } from "@/components/carrier-list-view";

export const metadata: Metadata = { title: "Active Carriers" };

export default async function ActiveCarriersPage(props: PageProps<"/active">) {
  return (
    <CarrierListView
      basePath="/active"
      title="Active Carriers"
      subtitle="Carriers currently hauling and available for dispatch."
      searchParams={await props.searchParams}
      group="active"
    />
  );
}
