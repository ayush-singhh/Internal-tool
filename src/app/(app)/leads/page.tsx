import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { listLeads } from "@/lib/leads";
import { leadFormOptions } from "@/lib/form-options";
import { PageHeader } from "@/components/ui";
import { LeadManager } from "@/components/lead-manager";

export const metadata: Metadata = { title: "Lead Management" };

export default async function LeadsPage() {
  const { user, org } = await requireOrg();
  if (!can(user, "lead:view")) redirect("/");

  // Whoever may convert manages the whole pipeline and sees all of it; everybody else
  // sees their own. Scoping the *query* rather than filtering the rendered list is what
  // keeps another rep's prospects out of the HTML entirely.
  const managesPipeline = can(user, "lead:convert");

  return (
    <>
      <PageHeader
        title="Lead Management"
        subtitle={
          managesPipeline
            ? "Every carrier prospect in the pipeline, and who is working it."
            : "The prospects you have submitted, and where each one stands."
        }
      />
      <LeadManager
        leads={listLeads(org, managesPipeline ? undefined : user.id)}
        options={leadFormOptions(org)}
        canCreate={can(user, "lead:create")}
        canConvert={managesPipeline}
        currentUserId={user.id}
      />
    </>
  );
}
