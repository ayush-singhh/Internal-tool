import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { listTeam } from "@/lib/team";
import { PageHeader } from "@/components/ui";
import { TeamManager } from "@/components/team-manager";

export const metadata: Metadata = { title: "Team" };

export default async function TeamPage() {
  const user = await requireUser();
  if (!can(user, "team:manage")) redirect("/");

  return (
    <>
      <PageHeader
        title="Team"
        subtitle="Who can sign in, what they can do, and how many carriers they carry."
      />
      <TeamManager team={listTeam()} currentUserId={user.id} />
    </>
  );
}
