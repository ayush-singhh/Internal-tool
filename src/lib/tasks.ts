import "server-only";
import { all, get, run } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import { TASK_PRIORITY, TASK_PRIORITY_ORDER, TASK_STATUS, type TaskPriority, type TaskStatus } from "./constants.ts";

/**
 * Tasks — assigned work with a due date, on all three panels.
 *
 * A task is "yours" if you are doing it or you raised it. That is one rule, applied in
 * the query here and in `can(user, "task:manage", task)` on the write side, so a list and
 * a permission can never disagree about whose task it is.
 */

export type TaskRow = {
  id: number;
  title: string;
  details: string | null;
  assigned_to: number | null;
  carrier_id: number | null;
  due_on: string | null;
  priority: TaskPriority;
  status: TaskStatus;
  completed_at: string | null;
  created_by: number | null;
  created_at: string;
  assignee_name: string | null;
  creator_name: string | null;
  carrier_name: string | null;
};

export type Result = { ok: true; id: number } | { ok: false; error: string };

const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * Overdue first, then by due date, then by priority. Undated tasks sort last.
 *
 * Written out as literal SQL rather than built from `TASK_PRIORITY_ORDER`, because this
 * string is concatenated into queries and AI Rules.md allows no interpolation into SQL —
 * including ORDER BY, which is exactly where that rule came from. The cost is that the
 * two can drift; `tests/tasks.test.ts` asserts the ordering matches the constant, so a
 * new priority fails a test instead of quietly sorting last.
 */
const ORDER = `
  ORDER BY t.status = 'done',
           t.due_on IS NULL,
           t.due_on,
           CASE t.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 WHEN 'low' THEN 2 ELSE 99 END,
           t.id DESC`;

/**
 * `userId` narrows to one person's tasks — assigned to them or raised by them. Whoever
 * may assign sees the whole board, and passes nothing.
 */
export function listTasks(org: Org, userId?: number, includeDone = false): TaskRow[] {
  const mine = userId === undefined ? "" : " AND (t.assigned_to = ? OR t.created_by = ?)";
  const open = includeDone ? "" : " AND t.status = ?";
  return all<TaskRow>(
    `SELECT t.*, a.name AS assignee_name, c2.name AS creator_name, ca.legal_name AS carrier_name
       FROM tasks t
       LEFT JOIN users    a  ON a.organization_id  = t.organization_id AND a.id  = t.assigned_to
       LEFT JOIN users    c2 ON c2.organization_id = t.organization_id AND c2.id = t.created_by
       LEFT JOIN carriers ca ON ca.organization_id = t.organization_id AND ca.id = t.carrier_id
      WHERE t.organization_id = ?${mine}${open}${ORDER}`,
    [
      org.id,
      ...(userId === undefined ? [] : [userId, userId]),
      ...(includeDone ? [] : [TASK_STATUS.OPEN]),
    ],
  );
}

export function getTask(org: Org, id: number): TaskRow | undefined {
  return get<TaskRow>("SELECT * FROM tasks WHERE organization_id = ? AND id = ?", [org.id, id]);
}

export type TaskCounts = { open: number; overdue: number; dueToday: number };

/** What the sidebar badge and the alerts feed both need, in one query. */
export function taskCounts(org: Org, userId?: number): TaskCounts {
  const mine = userId === undefined ? "" : " AND (assigned_to = ? OR created_by = ?)";
  const row = get<TaskCounts>(
    `SELECT COUNT(*) AS open,
            COALESCE(SUM(due_on IS NOT NULL AND due_on < ?), 0) AS overdue,
            COALESCE(SUM(due_on = ?), 0) AS dueToday
       FROM tasks
      WHERE organization_id = ? AND status = ?${mine}`,
    [
      todayIso(), todayIso(), org.id, TASK_STATUS.OPEN,
      ...(userId === undefined ? [] : [userId, userId]),
    ],
  );
  return row ?? { open: 0, overdue: 0, dueToday: 0 };
}

/** Open tasks that have run out of road — what an alert is actually about. */
export function pressingTasks(org: Org, userId?: number, limit = 10): TaskRow[] {
  const mine = userId === undefined ? "" : " AND (t.assigned_to = ? OR t.created_by = ?)";
  return all<TaskRow>(
    `SELECT t.*, a.name AS assignee_name, c2.name AS creator_name, ca.legal_name AS carrier_name
       FROM tasks t
       LEFT JOIN users    a  ON a.organization_id  = t.organization_id AND a.id  = t.assigned_to
       LEFT JOIN users    c2 ON c2.organization_id = t.organization_id AND c2.id = t.created_by
       LEFT JOIN carriers ca ON ca.organization_id = t.organization_id AND ca.id = t.carrier_id
      WHERE t.organization_id = ? AND t.status = ?
        AND t.due_on IS NOT NULL AND t.due_on <= ?${mine}${ORDER}
      LIMIT ?`,
    [
      org.id, TASK_STATUS.OPEN, todayIso(),
      ...(userId === undefined ? [] : [userId, userId]),
      limit,
    ],
  );
}

export type TaskInput = {
  id?: number | null;
  title: string;
  details?: string | null;
  assignedTo?: number | null;
  carrierId?: number | null;
  dueOn?: string | null;
  priority?: string | null;
};

export function saveTask(org: Org, input: TaskInput, userId: number | null): Result {
  const title = input.title.trim().slice(0, 200);
  if (!title) return { ok: false, error: "A task needs a title." };

  const priority = (input.priority ?? TASK_PRIORITY.NORMAL) as TaskPriority;
  if (!TASK_PRIORITY_ORDER.includes(priority)) {
    return { ok: false, error: "Unknown priority." };
  }
  // A due date is optional, but a due date in the wrong century is a typo, not a plan.
  const dueOn = input.dueOn?.trim() || null;
  if (dueOn && !/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) {
    return { ok: false, error: "A due date must be a real calendar date." };
  }

  const now = new Date().toISOString();
  const fields = [
    title,
    input.details?.trim() || null,
    input.assignedTo ?? null,
    input.carrierId ?? null,
    dueOn,
    priority,
  ];

  if (input.id) {
    if (!getTask(org, input.id)) return { ok: false, error: "Unknown task." };
    run(
      `UPDATE tasks SET title = ?, details = ?, assigned_to = ?, carrier_id = ?,
              due_on = ?, priority = ?, updated_at = ?, updated_by = ?
        WHERE organization_id = ? AND id = ?`,
      [...fields, now, userId, org.id, input.id],
    );
    return { ok: true, id: input.id };
  }

  run(
    `INSERT INTO tasks (organization_id, title, details, assigned_to, carrier_id, due_on,
                        priority, status, created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [org.id, ...fields, TASK_STATUS.OPEN, now, userId, now, userId],
  );
  return { ok: true, id: get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id };
}

/** Done and back again. Reopening exists because the alternative is a second task that
 *  says the same thing, and then two histories of one piece of work. */
export function setTaskDone(org: Org, id: number, done: boolean, userId: number | null): Result {
  if (!getTask(org, id)) return { ok: false, error: "Unknown task." };
  const now = new Date().toISOString();
  run(
    `UPDATE tasks SET status = ?, completed_at = ?, completed_by = ?, updated_at = ?, updated_by = ?
      WHERE organization_id = ? AND id = ?`,
    [
      done ? TASK_STATUS.DONE : TASK_STATUS.OPEN,
      done ? now : null,
      done ? userId : null,
      now, userId, org.id, id,
    ],
  );
  return { ok: true, id };
}
