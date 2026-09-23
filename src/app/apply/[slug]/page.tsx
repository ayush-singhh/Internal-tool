import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { portalFor } from "@/lib/portal";
import { applicantFor } from "@/lib/applicant-auth";
import { ApplyForm } from "./apply-form";

export const metadata: Metadata = { title: "Apply" };
// The portal can be opened and closed from the settings page, and a prerendered route
// would freeze that answer.
export const dynamic = "force-dynamic";

export default async function ApplyPage({ params }: PageProps<"/apply/[slug]">) {
  const { slug } = await params;
  const portal = portalFor(slug);
  // Closed, unknown and inactive are all this, so the URL cannot be used to find out
  // which companies are customers.
  if (!portal) notFound();

  // Already part-way through on this browser: carry on rather than start again.
  if (await applicantFor(portal)) redirect(`/apply/${slug}/application`);

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight text-ink-900">
        Apply to {portal.orgName}
      </h1>
      <p className="mt-1.5 mb-7 text-sm text-ink-500">
        Start with your USDOT number. We will check it against the FMCSA register so you do
        not have to type what they already hold.
      </p>
      <ApplyForm slug={slug} />
    </>
  );
}
