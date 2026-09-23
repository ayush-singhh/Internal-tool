import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { portalFor } from "@/lib/portal";
import { applicantFor } from "@/lib/applicant-auth";
import { VerifyForm } from "./verify-form";

export const metadata: Metadata = { title: "Confirm your number" };
export const dynamic = "force-dynamic";

export default async function VerifyPage({ params }: PageProps<"/apply/[slug]/verify">) {
  const { slug } = await params;
  const portal = portalFor(slug);
  if (!portal) notFound();
  if (await applicantFor(portal)) redirect(`/apply/${slug}/application`);

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight text-ink-900">Confirm your number</h1>
      <p className="mt-1.5 mb-7 text-sm text-ink-500">
        We have texted you a six-digit code. It expires in ten minutes.
      </p>
      <VerifyForm slug={slug} />
    </>
  );
}
