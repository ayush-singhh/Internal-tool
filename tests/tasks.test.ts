/**
 * Tasks, announcements, and the alerts feed composed from both.
 *
 * The rules worth pinning:
 *   1. A task is yours if you are doing it *or* you raised it — one rule, used by the
 *      list query and by `can()`, so a page and a permission cannot disagree.
 *   2. Assigning work to somebody else is the only gated half. Everyone keeps a list.
 *   3. Alerts are derived. Resolve the thing and the alert is gone on the next read —
 *      there is no row to expire, and nothing that can outlive what it describes.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { seedOrg, lookupId, type TestOrg } from "./helpers.ts";

const DB = path.join(tmpdir(), `carrier-hub-tasks-${process.pid}.db`);
for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let tasks: typeof import("../src/lib/tasks.ts");
let announcements: typeof import("../src/lib/announcements.ts");
let alerts: typeof import("../src/lib/alerts.ts");
let permissions: typeof import("../src/lib/permissions.ts");
let C: typeof import("../src/lib/constants.ts");
let alpha: TestOrg;
let beta: TestOrg;
let org: import("../src/lib/tenant-db.ts").Org;
let betaOrg: import("../src/lib/tenant-db.ts").Org;
let dee: number;
let sal: number;
let carrier: number;

const now = () => new Date().toISOString();
const iso = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10);

before(async () => {
  db = await import("../src/lib/db.ts");
  tasks = await import("../src/lib/tasks.ts");
  announcements = await import("../src/lib/announcements.ts");
  alerts = await import("../src/lib/alerts.ts");
  permissions = await import("../src/lib/permissions.ts");
  C = await import("../src/lib/constants.ts");
  const { Org } = await import("../src/lib/tenant-db.ts");

  alpha = seedOrg(db, "Alpha Tasks");
  beta = seedOrg(db, "Beta Tasks");
  org = new Org(alpha.id);
  betaOrg = new Org(beta.id);

  const addUser = (orgId: number, name: string, email: string, role: string) => {
    db.run(
      `INSERT INTO users (organization_id, name, email, password_hash, role, active, created_at, updated_at)
       VALUES (?, ?, ?, 'x', ?, 1, ?, ?)`,
      [orgId, name, email, role, now(), now()],
    );
    return db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
  };
  dee = addUser(alpha.id, "Dee Dispatcher", "dee@alpha.test", C.ROLES.DISPATCHER);
  sal = addUser(alpha.id, "Sal Sales", "sal@alpha.test", C.ROLES.SALES);

  db.run(
    `INSERT INTO carriers (organization_id, legal_name, status_id, created_at, updated_at)
     VALUES (?, 'Task Carrier LLC', ?, ?, ?)`,
    [alpha.id, lookupId(db, alpha.id, "status", "active"), now(), now()],
  );
  carrier = db.get<{ id: number }>("SELECT id FROM carriers WHERE organization_id = ?", [alpha.id])!.id;
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

beforeEach(() => {
  for (const o of [alpha, beta]) {
    db.run("DELETE FROM tasks WHERE organization_id = ?", [o.id]);
    db.run("DELETE FROM announcements WHERE organization_id = ?", [o.id]);
    db.run("UPDATE users SET announcements_seen_at = NULL WHERE organization_id = ?", [o.id]);
  }
});

const add = (over: Partial<Parameters<typeof tasks.saveTask>[1]> = {}, by = dee) =>
  tasks.saveTask(org, { title: "Call the broker", assignedTo: by, ...over }, by);

// ── tasks ────────────────────────────────────────────────────────────────────

test("a task needs a title", () => {
  assert.equal(add({ title: "  " }).ok, false);
});

test("a task rejects a priority that is not one of the three", () => {
  const result = add({ priority: "urgent" });
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /priority/i);
});

test("a due date has to be a real calendar date", () => {
  assert.equal(add({ dueOn: "next tuesday" }).ok, false);
  assert.equal(add({ dueOn: "2026-10-01" }).ok, true);
});

test("a task is yours whether you are doing it or you raised it", () => {
  tasks.saveTask(org, { title: "Assigned to Sal by Dee", assignedTo: sal }, dee);
  tasks.saveTask(org, { title: "Sal's own", assignedTo: sal }, sal);
  tasks.saveTask(org, { title: "Nothing to do with Sal", assignedTo: dee }, dee);

  const sals = tasks.listTasks(org, sal).map((t) => t.title).sort();
  assert.deepEqual(sals, ["Assigned to Sal by Dee", "Sal's own"]);

  // Dee raised the first one, so it is on Dee's list too — that is the point of the rule.
  const dees = tasks.listTasks(org, dee).map((t) => t.title).sort();
  assert.deepEqual(dees, ["Assigned to Sal by Dee", "Nothing to do with Sal"]);
});

test("completed tasks leave the list unless they are asked for", () => {
  add({ title: "Finish me" });
  const [task] = tasks.listTasks(org, dee);
  tasks.setTaskDone(org, task!.id, true, dee);

  assert.equal(tasks.listTasks(org, dee).length, 0);
  assert.equal(tasks.listTasks(org, dee, true).length, 1);
  assert.equal(tasks.listTasks(org, dee, true)[0]!.status, C.TASK_STATUS.DONE);
});

test("completing records who and when, and reopening clears both", () => {
  add({ title: "Round trip" });
  const [task] = tasks.listTasks(org, dee);

  tasks.setTaskDone(org, task!.id, true, sal);
  const done = db.get<{ completed_at: string | null; completed_by: number | null; status: string }>(
    "SELECT status, completed_at, completed_by FROM tasks WHERE organization_id = ? AND id = ?",
    [alpha.id, task!.id],
  )!;
  assert.equal(done.status, C.TASK_STATUS.DONE);
  assert.equal(done.completed_by, sal);
  assert.ok(done.completed_at);

  tasks.setTaskDone(org, task!.id, false, sal);
  const reopened = db.get<{ completed_at: string | null; completed_by: number | null; status: string }>(
    "SELECT status, completed_at, completed_by FROM tasks WHERE organization_id = ? AND id = ?",
    [alpha.id, task!.id],
  )!;
  assert.equal(reopened.status, C.TASK_STATUS.OPEN);
  assert.equal(reopened.completed_at, null, "a reopened task is not still carrying a completion date");
  assert.equal(reopened.completed_by, null);
});

test("counts separate overdue from due-today, and ignore what is done", () => {
  add({ title: "Late", dueOn: iso(-3) });
  add({ title: "Also late", dueOn: iso(-1) });
  add({ title: "Today", dueOn: iso(0) });
  add({ title: "Later", dueOn: iso(7) });
  add({ title: "No date" });

  const counts = tasks.taskCounts(org, dee);
  assert.equal(counts.open, 5);
  assert.equal(counts.overdue, 2);
  assert.equal(counts.dueToday, 1);

  const [first] = tasks.listTasks(org, dee);
  tasks.setTaskDone(org, first!.id, true, dee);
  assert.equal(tasks.taskCounts(org, dee).open, 4, "a completed task stops being counted");
});

test("the list sorts overdue first, then by date, then by the priority order", () => {
  add({ title: "Undated low", priority: "low" });
  add({ title: "Next week", dueOn: iso(7) });
  add({ title: "Overdue", dueOn: iso(-2) });
  add({ title: "Today normal", dueOn: iso(0), priority: "normal" });
  add({ title: "Today high", dueOn: iso(0), priority: "high" });

  assert.deepEqual(tasks.listTasks(org, dee).map((t) => t.title), [
    "Overdue",
    "Today high",
    "Today normal",
    "Next week",
    "Undated low",
  ]);
});

/**
 * `ORDER` in tasks.ts spells the priority ranking out as literal SQL, because AI Rules.md
 * allows no interpolation into a query — including ORDER BY. That leaves it able to drift
 * from the constant, so this is the thing that fails if somebody adds a priority.
 */
test("the SQL priority ranking still matches TASK_PRIORITY_ORDER", () => {
  for (const [i, priority] of C.TASK_PRIORITY_ORDER.entries()) {
    add({ title: `P${i} ${priority}`, dueOn: iso(0), priority });
  }
  assert.deepEqual(
    tasks.listTasks(org, dee).map((t) => t.priority),
    C.TASK_PRIORITY_ORDER,
    "the CASE in tasks.ts has drifted from the constant",
  );
});

test("a task carries its carrier through to the list", () => {
  add({ title: "Chase insurance", carrierId: carrier });
  assert.equal(tasks.listTasks(org, dee)[0]!.carrier_name, "Task Carrier LLC");
});

test("one organisation's tasks are invisible to another", () => {
  add({ title: "Alpha only" });
  assert.equal(tasks.listTasks(betaOrg).length, 0);
  assert.equal(tasks.taskCounts(betaOrg).open, 0);
  assert.equal(tasks.getTask(betaOrg, tasks.listTasks(org)[0]!.id), undefined);
});

// ── announcements ────────────────────────────────────────────────────────────

test("an announcement needs both a title and something to say", () => {
  assert.equal(announcements.saveAnnouncement(org, { title: "", body: "x" }, dee).ok, false);
  assert.equal(announcements.saveAnnouncement(org, { title: "x", body: "  " }, dee).ok, false);
  assert.equal(announcements.saveAnnouncement(org, { title: "Real", body: "Real" }, dee).ok, true);
});

test("everything is unread until you have opened the page once", () => {
  announcements.saveAnnouncement(org, { title: "One", body: "First" }, alpha.ownerId);
  announcements.saveAnnouncement(org, { title: "Two", body: "Second" }, alpha.ownerId);

  assert.equal(announcements.unreadCount(org, sal), 2, "a new joiner does not start at zero");

  announcements.markAnnouncementsSeen(org, sal);
  assert.equal(announcements.unreadCount(org, sal), 0);
  assert.equal(announcements.unreadCount(org, dee), 2, "marking is per person");
});

test("a notice posted after you looked is unread again", () => {
  announcements.saveAnnouncement(org, { title: "Old", body: "Old" }, alpha.ownerId);
  announcements.markAnnouncementsSeen(org, sal);

  // The watermark is a timestamp, so a notice published in the same millisecond would be
  // ambiguous; push this one clearly past it, the way a real second post would be.
  db.run(
    `INSERT INTO announcements (organization_id, title, body, published_at, created_at, updated_at)
     VALUES (?, 'New', 'New', ?, ?, ?)`,
    [alpha.id, iso(1) + "T00:00:00.000Z", now(), now()],
  );
  assert.equal(announcements.unreadCount(org, sal), 1);
});

test("editing an announcement does not re-publish it to the top of everyone's unread", () => {
  announcements.saveAnnouncement(org, { title: "Typo", body: "Teh body" }, alpha.ownerId);
  const [posted] = announcements.listAnnouncements(org);
  announcements.markAnnouncementsSeen(org, sal);

  announcements.saveAnnouncement(org, { id: posted!.id, title: "Typo", body: "The body" }, alpha.ownerId);

  const [after_] = announcements.listAnnouncements(org);
  assert.equal(after_!.body, "The body");
  assert.equal(after_!.published_at, posted!.published_at, "the publication date is untouched");
  assert.equal(announcements.unreadCount(org, sal), 0, "a typo fix does not ping the organisation");
});

test("withdrawing an announcement removes it", () => {
  announcements.saveAnnouncement(org, { title: "Spent", body: "Spent" }, alpha.ownerId);
  const [posted] = announcements.listAnnouncements(org);
  assert.equal(announcements.deleteAnnouncement(org, posted!.id).ok, true);
  assert.equal(announcements.listAnnouncements(org).length, 0);
});

test("one organisation's noticeboard is invisible to another", () => {
  announcements.saveAnnouncement(org, { title: "Alpha only", body: "Alpha only" }, alpha.ownerId);
  assert.equal(announcements.listAnnouncements(betaOrg).length, 0);
  assert.equal(announcements.unreadCount(betaOrg, beta.ownerId), 0);
});

// ── alerts, which store nothing ──────────────────────────────────────────────

const asUser = (id: number, role: string) => ({
  id,
  organization_id: alpha.id,
  name: "Test",
  email: "t@x.test",
  role: role as never,
  active: 1,
});

test("an alert clears the moment the thing behind it is resolved", () => {
  add({ title: "Overdue thing", dueOn: iso(-1) }, dee);
  const user = asUser(dee, C.ROLES.DISPATCHER);

  const before_ = alerts.alertsFor(org, user);
  assert.equal(before_.tasks.overdue, 1);
  assert.ok(before_.groups.some((g) => g.key === "tasks_overdue"));

  const [task] = tasks.listTasks(org, dee);
  tasks.setTaskDone(org, task!.id, true, dee);

  const after_ = alerts.alertsFor(org, user);
  assert.equal(after_.tasks.overdue, 0);
  assert.ok(
    !after_.groups.some((g) => g.key === "tasks_overdue"),
    "nothing had to expire the alert — there was never a row",
  );
});

test("alerts show a person only what they may already see", () => {
  add({ title: "Dee's overdue", dueOn: iso(-1) }, dee);
  announcements.saveAnnouncement(org, { title: "Notice", body: "Notice" }, alpha.ownerId);

  // Sales cannot see carriers, so the carrier queue is not merely hidden — it is not run.
  const forSales = alerts.alertsFor(org, asUser(sal, C.ROLES.SALES));
  assert.deepEqual(forSales.attention, []);
  assert.equal(forSales.tasks.overdue, 0, "another person's overdue task is not sales' alert");
  assert.equal(forSales.unreadAnnouncements, 1, "the noticeboard is everybody's");

  const forDee = alerts.alertsFor(org, asUser(dee, C.ROLES.DISPATCHER));
  assert.equal(forDee.tasks.overdue, 1);
});

test("an administrator's alerts cover the whole board, not just their own list", () => {
  add({ title: "Dee's overdue", dueOn: iso(-1) }, dee);
  const forOwner = alerts.alertsFor(org, asUser(alpha.ownerId, C.ROLES.OWNER));
  assert.equal(forOwner.tasks.overdue, 1, "whoever may assign work is watching all of it");
  assert.equal(forOwner.overdueTasks[0]!.assignee_name, "Dee Dispatcher");
});

test("with nothing pending there are no alerts, and the total is only what is real", () => {
  // Sales sees no carriers, so with no tasks and nothing on the noticeboard there is
  // genuinely nothing — the page renders "all clear" rather than an empty scaffold.
  const forSales = alerts.alertsFor(org, asUser(sal, C.ROLES.SALES));
  assert.equal(forSales.total, 0);
  assert.deepEqual(forSales.groups, []);

  // A dispatcher's total with no tasks is exactly the carrier queue — nothing is added
  // twice, and nothing is counted that no rule produced.
  const forDee = alerts.alertsFor(org, asUser(dee, C.ROLES.DISPATCHER));
  assert.equal(forDee.tasks.overdue, 0);
  assert.equal(forDee.unreadAnnouncements, 0);
  assert.equal(
    forDee.total,
    forDee.attention.reduce((sum, rule) => sum + rule.count, 0),
    "the total is the sum of its parts and nothing else",
  );
  assert.equal(forDee.groups.length, forDee.attention.length);
});

// ── who may do what ──────────────────────────────────────────────────────────

test("every role keeps a list and reads the noticeboard; support gets neither", () => {
  const { can } = permissions;
  for (const role of [C.ROLES.OWNER, C.ROLES.ADMIN, C.ROLES.DISPATCHER,
                      C.ROLES.ACCOUNT_MANAGER, C.ROLES.SALES, C.ROLES.VIEWER]) {
    assert.equal(can(asUser(1, role), "task:view"), true, `${role} task:view`);
    assert.equal(can(asUser(1, role), "announcement:view"), true, `${role} announcement:view`);
  }
  assert.equal(can(asUser(1, C.ROLES.SUPPORT), "task:view"), false);
  assert.equal(can(asUser(1, C.ROLES.SUPPORT), "announcement:view"), false);
});

test("assigning work and posting to everyone are administrators only", () => {
  const { can } = permissions;
  for (const action of ["task:assign", "announcement:manage"] as const) {
    assert.equal(can(asUser(1, C.ROLES.ADMIN), action), true);
    assert.equal(can(asUser(1, C.ROLES.OWNER), action), true);
    for (const role of [C.ROLES.DISPATCHER, C.ROLES.ACCOUNT_MANAGER,
                        C.ROLES.SALES, C.ROLES.VIEWER, C.ROLES.SUPPORT]) {
      assert.equal(can(asUser(1, role), action), false, `${role} must not have ${action}`);
    }
  }
});

/**
 * `taskScope` is one line that decides the scope of five separate queries — /tasks, the
 * dashboard strip, the sidebar badge, the alerts feed and the calendar's due dates. It
 * used to be written out at each of them, and the failure mode of a disagreement is not a
 * crash: the badge would simply count a different set of tasks than the page it links to,
 * and every per-screen test would still pass. This is the case that makes them agree.
 */
test("taskScope: the whole board for whoever may assign, your own id for everyone else", () => {
  const { taskScope } = permissions;
  for (const role of [C.ROLES.ADMIN, C.ROLES.OWNER]) {
    assert.equal(taskScope(asUser(dee, role)), undefined, `${role} watches the whole board`);
  }
  for (const role of [C.ROLES.DISPATCHER, C.ROLES.ACCOUNT_MANAGER, C.ROLES.SALES, C.ROLES.VIEWER]) {
    assert.equal(taskScope(asUser(dee, role)), dee, `${role} watches their own`);
  }
  // It tracks `task:assign` rather than restating it — the two cannot come apart.
  for (const role of [C.ROLES.ADMIN, C.ROLES.DISPATCHER, C.ROLES.SALES]) {
    const user = asUser(dee, role);
    assert.equal(
      taskScope(user) === undefined,
      permissions.can(user, "task:assign"),
      `${role}: scope and permission must agree`,
    );
  }
  // A deactivated administrator loses the board with everything else, rather than keeping
  // the widest scope in the product.
  assert.equal(taskScope({ ...asUser(dee, C.ROLES.ADMIN), active: 0 }), dee);
});

test("a task is manageable by its assignee and by whoever raised it, and nobody else", () => {
  const { can } = permissions;
  const task = { owner_id: sal, created_by: dee };
  assert.equal(can(asUser(sal, C.ROLES.SALES), "task:manage", task), true, "the assignee");
  assert.equal(can(asUser(dee, C.ROLES.DISPATCHER), "task:manage", task), true, "who raised it");
  assert.equal(can(asUser(9999, C.ROLES.DISPATCHER), "task:manage", task), false, "a bystander");
  // Administrators hold everything, which is what makes the board manageable at all.
  assert.equal(can(asUser(9999, C.ROLES.ADMIN), "task:manage", task), true);
});

test("a deactivated user reaches none of it", () => {
  const dead = { ...asUser(dee, C.ROLES.DISPATCHER), active: 0 };
  assert.equal(permissions.can(dead, "task:view"), false);
  assert.equal(permissions.can(dead, "announcement:view"), false);
  assert.equal(permissions.can(dead, "task:manage", { owner_id: dee }), false);
});
