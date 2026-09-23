import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { portalFor } from "@/lib/portal";
import { applicantFor } from "@/lib/applicant-auth";
import { getApplication } from "@/lib/applications";

export const metadata: Metadata = { title: "Your application" };
export const dynamic = "force-dynamic";

export default async function ApplicationPage({ params }: PageProps<"/apply/[slug]/application">) {
  const { slug } = await params;
  const portal = portalFor(slug);
  if (!portal) notFound();

  // The page's own gate. A layout cannot be one — Next runs the page regardless of what
  // a layout decides.
  const applicant = await applicantFor(portal);
  if (!applicant) redirect(`/apply/${slug}`);

  const application = getApplication(applicant.org, applicant.applicationId);
  if (!application) redirect(`/apply/${slug}`);

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight text-ink-900">Your application</h1>
      <p className="mt-1.5 mb-7 text-sm text-ink-500">
        Your number is confirmed and {portal.orgName} can see your application. Come back to
        this page on this device to carry on.
      </p>

      <dl className="divide-y divide-line rounded-lg border border-line bg-white px-4">
        {[
          ["Company", application.legal_name],
          ["Trading as", application.dba_name],
          ["USDOT", application.usdot],
          ["State", application.operating_state],
          ["Mobile", `${application.phone} · confirmed`],
          ["Email", application.email],
        ]
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label} className="flex justify-between gap-6 py-3 text-sm">
              <dt className="text-ink-500">{label}</dt>
              <dd className="text-right font-medium text-ink-900">{value}</dd>
            </div>
          ))}
      </dl>

      <div className="mt-6 rounded-lg border border-line bg-paper-50 px-4 py-3.5">
        <p className="text-sm font-semibold text-ink-900">What happens next</p>
        {/* Honest about the seam: the remaining steps are specified and not yet built, and
            saying so beats a progress bar that never moves. */}
        <p className="mt-1 text-sm text-ink-500">
          Your fleet details, documents, pricing and agreement are the next steps. We will
          text you on {application.phone} as soon as they are ready for you.
        </p>
      </div>
    </>
  );
}
