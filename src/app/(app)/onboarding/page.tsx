import type { Metadata } from "next";
import { CarrierListView } from "@/components/carrier-list-view";

export const metadata: Metadata = { title: "Onboarding" };

export default async function OnboardingPage(props: PageProps<"/onboarding">) {
  return (
    <CarrierListView
      basePath="/onboarding"
      title="Onboarding"
      subtitle="Carriers marked About to Be Active — paperwork, setup and first load pending."
      searchParams={await props.searchParams}
      group="onboarding"
    />
  );
}
