import type { Metadata } from "next";
import { CarrierListView } from "@/components/carrier-list-view";

export const metadata: Metadata = { title: "Carriers" };

export default async function CarriersPage(props: PageProps<"/carriers">) {
  return (
    <CarrierListView
      basePath="/carriers"
      title="Carriers"
      subtitle="Every carrier on file, including offboarded records."
      searchParams={await props.searchParams}
      showQuickFilters
    />
  );
}
