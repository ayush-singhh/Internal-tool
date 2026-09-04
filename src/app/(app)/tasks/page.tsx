import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { can, taskScope } from "@/lib/permissions";
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

  // Two questions that happen to share a permission, and they stay separate. `scope` is
  // whose tasks to fetch — the rule `permissions.ts` owns, so the badge, the dashboard,
  // alerts and the calendar all narrow the same way this page does. `managesBoard` is
  // whether to offer an assignee dropdown and which subtitle to write, which is this
  // page's own business and nobody else's.
  const scope = taskScope(user);
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
        tasks={listTasks(org, scope, showingDone)}
        people={managesBoard ? listAssignableUsers(org).map((u) => ({ id: u.id, label: u.name })) : []}
        carriers={can(user, "carrier:view") ? carrierOptions(org) : []}
        canAssign={managesBoard}
        currentUserId={user.id}
        showingDone={showingDone}
      />
    </>
  );
}
