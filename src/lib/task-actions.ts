"use server";

import { revalidatePath } from "next/cache";
import { requireOrg } from "./auth.ts";
import { can } from "./permissions.ts";
import { getTask, saveTask, setTaskDone } from "./tasks.ts";

export type TaskState = { error?: string; ok?: string };

const text = (f: FormData, k: string) => {
  const v = String(f.get(k) ?? "").trim();
  return v || null;
};
const id = (f: FormData, k: string) => {
  const n = Number(f.get(k));
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function saveTaskAction(_prev: TaskState, form: FormData): Promise<TaskState> {
  const { user, org } = await requireOrg();
  const taskId = id(form, "id");

  if (taskId) {
    const existing = getTask(org, taskId);
    if (!existing) return { error: "Unknown task." };
    if (!can(user, "task:manage", existing)) {
      return { error: "This task is not yours to change." };
    }
  }

  // Assigning to somebody else is the gated half. Everyone may keep their own list, so a
  // caller without `task:assign` gets themselves regardless of what the form posted —
  // decided here rather than trusted from the field.
  const requested = id(form, "assigned_to");
  const assignedTo = can(user, "task:assign") ? requested : user.id;

  const result = saveTask(
    org,
    {
      id: taskId,
      title: String(form.get("title") ?? ""),
      details: text(form, "details"),
      assignedTo,
      carrierId: can(user, "carrier:view") ? id(form, "carrier_id") : null,
      dueOn: text(form, "due_on"),
      priority: text(form, "priority"),
    },
    user.id,
  );
  if (!result.ok) return { error: result.error };
  revalidatePath("/tasks");
  revalidatePath("/alerts");
  return { ok: taskId ? "Task updated." : "Task added." };
}

export async function toggleTaskAction(form: FormData) {
  const { user, org } = await requireOrg();
  const taskId = id(form, "id");
  if (!taskId) return;

  const task = getTask(org, taskId);
  if (!task) return;
  if (!can(user, "task:manage", task)) {
    throw new Error("This task is not yours to change.");
  }

  setTaskDone(org, taskId, form.get("done") === "1", user.id);
  revalidatePath("/tasks");
  revalidatePath("/alerts");
}
