import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { listApplications, duplicateCarrierFor, APPLICATION_STATUS } from "@/lib/applications";
import { PageHeader } from "@/components/ui";
import { ApplicationQueue } from "@/components/application-queue";

export const metadata: Metadata = { title: "Applications" };

export default async function ApplicationsPage() {
  const { user, org } = await requireOrg();
  // The page's own gate. The sidebar hiding a link is presentation, and /reports went
  // fourteen phases without this check (BUGS.md) — the list of pages to audit is the
  // router's, never the nav's.
  if (!can(user, "application:view")) redirect("/");

  const rows = listApplications(org).map((application) => ({
    application,
    // Reported, never acted on: merging two carrier records is a human decision.
    duplicate: duplicateCarrierFor(org, application.usdot) ?? null,
  }));

  const open = rows.filter((r) =>
    r.application.status === APPLICATION_STATUS.DRAFT ||
    r.application.status === APPLICATION_STATUS.SUBMITTED);
  const closed = rows.filter((r) => !open.includes(r));

  return (
    <>
      <PageHeader
        title="Applications"
        subtitle="Carriers who applied through your onboarding portal. Converting one creates the carrier record."
      />
      <ApplicationQueue
        open={open}
        closed={closed}
        canConvert={can(user, "application:convert")}
      />
    </>
  );
}
