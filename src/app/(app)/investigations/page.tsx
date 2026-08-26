import type { Metadata } from "next";
import { CarrierListView } from "@/components/carrier-list-view";

export const metadata: Metadata = { title: "Investigations" };

export default async function InvestigationsPage(props: PageProps<"/investigations">) {
  return (
    <CarrierListView
      basePath="/investigations"
      title="Investigations"
      subtitle="Carriers held for review — resolve before activating or offboarding."
      searchParams={await props.searchParams}
      group="investigations"
    />
  );
}
