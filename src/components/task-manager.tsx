"use client";

import Link from "next/link";
import { useActionState, useRef, useState } from "react";
import { saveTaskAction, toggleTaskAction, type TaskState } from "@/lib/task-actions";
import type { TaskRow } from "@/lib/tasks";
import {
  TASK_PRIORITY, TASK_PRIORITY_LABELS, TASK_PRIORITY_ORDER, TASK_PRIORITY_TONE, TASK_STATUS,
} from "@/lib/constants";
import { Badge, Banner, Dialog, DialogActions, EmptyState } from "./ui";
import { Icon } from "./icons";
import { Text, Select, TextArea, type FormOption } from "./form-fields";

const todayIso = () => new Date().toISOString().slice(0, 10);

export function TaskManager({
  tasks,
  people,
  carriers,
  canAssign,
  currentUserId,
  showingDone,
}: {
  tasks: TaskRow[];
  /** Empty unless the viewer may assign — the picker is not rendered otherwise. */
  people: FormOption[];
  carriers: FormOption[];
  canAssign: boolean;
  currentUserId: number;
  showingDone: boolean;
}) {
  const [editing, setEditing] = useState<TaskRow | null>(null);
  const addRef = useRef<HTMLDialogElement>(null);
  const editRef = useRef<HTMLDialogElement>(null);

  const today = todayIso();
  const open = tasks.filter((t) => t.status === TASK_STATUS.OPEN);
  const overdue = open.filter((t) => t.due_on !== null && t.due_on < today);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-500">
          {open.length} open
          {overdue.length > 0 && <span className="font-semibold text-red-600"> · {overdue.length} overdue</span>}
        </p>
        <div className="flex items-center gap-2">
          <Link
            href={showingDone ? "/tasks" : "/tasks?done=1"}
            className="rounded-lg border border-line-strong bg-surface px-3 py-2 text-sm font-medium text-ink-700 transition hover:bg-ink-50"
          >
            {showingDone ? "Hide completed" : "Show completed"}
          </Link>
          <button
            type="button"
            onClick={() => addRef.current?.showModal()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700"
          >
            <Icon name="plus" className="h-4 w-4" />
            New task
          </button>
        </div>
      </div>

      {tasks.length === 0 ? (
        <EmptyState
          title={showingDone ? "Nothing here yet" : "No open tasks"}
          description="A task is a piece of work with a name and, usually, a date. Add one to keep it out of your head."
          action={
            <button
              type="button"
              onClick={() => addRef.current?.showModal()}
              className="rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700"
            >
              Add the first task
            </button>
          }
        />
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface shadow-card">
          {tasks.map((task) => {
            const done = task.status === TASK_STATUS.DONE;
            const late = !done && task.due_on !== null && task.due_on < today;
            const dueToday = !done && task.due_on === today;
            return (
              <li key={task.id} className={`flex items-start gap-3 px-4 py-3 ${done ? "opacity-55" : ""}`}>
                <form action={toggleTaskAction} className="pt-0.5">
                  <input type="hidden" name="id" value={task.id} />
                  <input type="hidden" name="done" value={done ? "0" : "1"} />
                  <button
                    type="submit"
                    aria-label={done ? `Reopen ${task.title}` : `Complete ${task.title}`}
                    className={`flex h-5 w-5 items-center justify-center rounded border transition ${
                      done
                        ? "border-emerald-300 bg-emerald-100 text-emerald-700"
                        : "border-line-strong bg-surface text-transparent hover:border-brand-400 hover:text-brand-300"
                    }`}
                  >
                    <Icon name="check" className="h-3.5 w-3.5" />
                  </button>
                </form>

                <div className="min-w-0 flex-1">
                  <p className={`text-sm font-medium text-ink-900 ${done ? "line-through" : ""}`}>
                    {task.title}
                  </p>
                  {task.details && <p className="mt-0.5 text-xs text-ink-500">{task.details}</p>}
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-500">
                    {task.due_on && (
                      <span className={late ? "font-semibold text-red-600" : dueToday ? "font-semibold text-amber-600" : ""}>
                        {late ? "Overdue " : dueToday ? "Due today" : "Due "}
                        {dueToday ? "" : task.due_on}
                      </span>
                    )}
                    <span>
                      {task.assigned_to === currentUserId
                        ? "You"
                        : (task.assignee_name ?? "Unassigned")}
                    </span>
                    {task.carrier_id && task.carrier_name && (
                      <Link href={`/carriers/${task.carrier_id}`} className="text-brand-600 hover:underline">
                        {task.carrier_name}
                      </Link>
                    )}
                    {task.created_by !== task.assigned_to && task.creator_name && (
                      <span>Raised by {task.creator_name}</span>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={TASK_PRIORITY_TONE[task.priority]}>
                    {TASK_PRIORITY_LABELS[task.priority]}
                  </Badge>
                  <button
                    type="button"
                    onClick={() => { setEditing(task); editRef.current?.showModal(); }}
                    className="rounded p-1.5 text-ink-500 transition hover:bg-ink-100 hover:text-ink-900"
                    title={`Edit ${task.title}`}
                  >
                    <Icon name="edit" className="h-4 w-4" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog ref={addRef} title="New task">
        <TaskForm people={people} carriers={carriers} canAssign={canAssign} dialogRef={addRef} />
      </Dialog>

      <Dialog ref={editRef} title={editing ? `Edit “${editing.title}”` : "Edit task"}>
        {editing && (
          <TaskForm
            task={editing}
            people={people}
            carriers={carriers}
            canAssign={canAssign}
            dialogRef={editRef}
          />
        )}
      </Dialog>
    </div>
  );
}

function TaskForm({
  task,
  people,
  carriers,
  canAssign,
  dialogRef,
}: {
  task?: TaskRow;
  people: FormOption[];
  carriers: FormOption[];
  canAssign: boolean;
  dialogRef: React.RefObject<HTMLDialogElement | null>;
}) {
  const [state, action, pending] = useActionState<TaskState, FormData>(saveTaskAction, {});
  return (
    <form action={action} className="space-y-4">
      {task && <input type="hidden" name="id" value={task.id} />}
      <Banner state={state} />
      <Text name="title" label="Task" required defaultValue={task?.title} />
      <TextArea name="details" label="Details" defaultValue={task?.details ?? ""} rows={2} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Text name="due_on" label="Due" type="date" defaultValue={task?.due_on ?? ""} />
        <div>
          <label htmlFor="priority" className="mb-1 block text-xs font-medium text-ink-600">
            Priority
          </label>
          <select
            id="priority"
            name="priority"
            defaultValue={task?.priority ?? TASK_PRIORITY.NORMAL}
            className="field"
          >
            {TASK_PRIORITY_ORDER.map((p) => (
              <option key={p} value={p}>{TASK_PRIORITY_LABELS[p]}</option>
            ))}
          </select>
        </div>
        {canAssign && (
          <Select
            name="assigned_to"
            label="Assign to"
            options={people}
            defaultValue={task?.assigned_to != null ? String(task.assigned_to) : undefined}
            placeholder="Unassigned"
          />
        )}
        {carriers.length > 0 && (
          <Select
            name="carrier_id"
            label="About carrier"
            options={carriers}
            defaultValue={task?.carrier_id != null ? String(task.carrier_id) : undefined}
            placeholder="None"
          />
        )}
      </div>
      <DialogActions dialogRef={dialogRef} pending={pending} label={task ? "Save changes" : "Add task"} />
    </form>
  );
}
