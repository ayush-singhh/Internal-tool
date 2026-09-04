import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { listTasks } from "@/lib/tasks";
import { carrierOptions } from "@/lib/form-options";
import { listAssignableUsers } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import { TaskManager } from "@/components/task-manager";

export const metadata: Metadata = { title: "Tasks" };

export default async function TasksPage({ searchParams }: PageProps<"/tasks">) {
  const { user, org } = await requireOrg();
  if (!can(user, "task:view")) redirect("/");

  const showingDone = (await searchParams).done === "1";

  // Whoever may assign work sees the whole board; everyone else sees their own — the same
  // test the sidebar badge and the alerts feed use, so the three cannot disagree.
  const managesBoard = can(user, "task:assign");

  return (
    <>
      <PageHeader
        title="Tasks"
        subtitle={
          managesBoard
            ? "Every open piece of work, most urgent first."
            : "What is on your list — assigned to you, or raised by you."
        }
      />
      <TaskManager
        tasks={listTasks(org, managesBoard ? undefined : user.id, showingDone)}
        people={managesBoard ? listAssignableUsers(org).map((u) => ({ id: u.id, label: u.name })) : []}
        carriers={can(user, "carrier:view") ? carrierOptions(org) : []}
        canAssign={managesBoard}
        currentUserId={user.id}
        showingDone={showingDone}
      />
    </>
  );
}
