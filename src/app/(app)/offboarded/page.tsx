import type { Metadata } from "next";
import { CarrierListView } from "@/components/carrier-list-view";

export const metadata: Metadata = { title: "Offboarded / Inactive" };

export default async function OffboardedPage(props: PageProps<"/offboarded">) {
  return (
    <CarrierListView
      basePath="/offboarded"
      title="Offboarded / Inactive"
      subtitle="Inactive, suspended, blacklisted and backed-off carriers. Records are retained in full."
      searchParams={await props.searchParams}
      group="offboarded"
    />
  );
}
