/**
 * The planning calendar — both halves.
 *
 * The rules worth pinning:
 *   1. Derived entries are windows. They appear because a load, task or carrier says so,
 *      and they disappear when that record changes. Nothing here writes back to them.
 *   2. Each derived source is gated on the permission that already guards its records, so
 *      the calendar can never show a date for something the reader could not open.
 *   3. The date maths is UTC on strings. Local-time `Date` arithmetic shifts a day either
 *      side of midnight depending on the server's zone, which would put the whole grid
 *      out by one for half the world.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { seedOrg, lookupId, type TestOrg } from "./helpers.ts";

const DB = path.join(tmpdir(), `carrier-hub-calendar-${process.pid}.db`);
for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let cal: typeof import("../src/lib/calendar.ts");
let write: typeof import("../src/lib/load-write.ts");
let tasks: typeof import("../src/lib/tasks.ts");
let permissions: typeof import("../src/lib/permissions.ts");
let C: typeof import("../src/lib/constants.ts");
let alpha: TestOrg;
let beta: TestOrg;
let org: import("../src/lib/tenant-db.ts").Org;
let betaOrg: import("../src/lib/tenant-db.ts").Org;
let dee: number;
let carrier: number;

const now = () => new Date().toISOString();
const MONTH = "2026-04";
const day = (n: number) => `${MONTH}-${String(n).padStart(2, "0")}`;

const asUser = (id: number, role: string) => ({
  id,
  organization_id: alpha.id,
  name: "Test",
  email: "t@x.test",
  role: role as never,
  active: 1,
});

before(async () => {
  db = await import("../src/lib/db.ts");
  cal = await import("../src/lib/calendar.ts");
  write = await import("../src/lib/load-write.ts");
  tasks = await import("../src/lib/tasks.ts");
  permissions = await import("../src/lib/permissions.ts");
  C = await import("../src/lib/constants.ts");
  const { Org } = await import("../src/lib/tenant-db.ts");

  alpha = seedOrg(db, "Alpha Calendar");
  beta = seedOrg(db, "Beta Calendar");
  org = new Org(alpha.id);
  betaOrg = new Org(beta.id);

  db.run(
    `INSERT INTO users (organization_id, name, email, password_hash, role, active, created_at, updated_at)
     VALUES (?, 'Dee Dispatcher', 'dee@cal.test', 'x', ?, 1, ?, ?)`,
    [alpha.id, C.ROLES.DISPATCHER, now(), now()],
  );
  dee = db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;

  db.run(
    `INSERT INTO carriers (organization_id, legal_name, status_id, created_at, updated_at)
     VALUES (?, 'Calendar Carrier LLC', ?, ?, ?)`,
    [alpha.id, lookupId(db, alpha.id, "status", "active"), now(), now()],
  );
  carrier = db.get<{ id: number }>("SELECT id FROM carriers WHERE organization_id = ?", [alpha.id])!.id;
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

beforeEach(() => {
  for (const o of [alpha, beta]) {
    db.run("DELETE FROM calendar_events WHERE organization_id = ?", [o.id]);
    db.run("DELETE FROM load_stops WHERE organization_id = ?", [o.id]);
    db.run("DELETE FROM loads WHERE organization_id = ?", [o.id]);
    db.run("DELETE FROM tasks WHERE organization_id = ?", [o.id]);
  }
  db.run("UPDATE carriers SET insurance_expires_on = NULL WHERE organization_id = ?", [alpha.id]);
});

const owner = () => asUser(alpha.ownerId, C.ROLES.OWNER);
const entriesFor = (user: ReturnType<typeof asUser>, month = MONTH) => cal.monthEntries(org, user, month);

// ── the grid ─────────────────────────────────────────────────────────────────

test("a month knows its own length, including February in a leap year", () => {
  assert.equal(cal.monthGrid("2026-04").days.length, 30);
  assert.equal(cal.monthGrid("2026-02").days.length, 28);
  assert.equal(cal.monthGrid("2028-02").days.length, 29, "2028 is a leap year");
  assert.equal(cal.monthGrid("2026-12").days.length, 31);
});

test("the grid is Monday-first, so a working week is one block", () => {
  // 1 April 2026 is a Wednesday: Mon, Tue blank, then the 1st.
  assert.equal(cal.monthGrid("2026-04").leadingBlanks, 2);
  // 1 March 2026 is a Sunday — the last column, so six blanks precede it.
  assert.equal(cal.monthGrid("2026-03").leadingBlanks, 6);
  // 1 June 2026 is a Monday: no blanks at all.
  assert.equal(cal.monthGrid("2026-06").leadingBlanks, 0);
});

test("stepping months rolls the year over in both directions", () => {
  assert.equal(cal.monthGrid("2026-01").previous, "2025-12");
  assert.equal(cal.monthGrid("2026-12").next, "2027-01");
  assert.equal(cal.monthGrid("2026-04").first, "2026-04-01");
  assert.equal(cal.monthGrid("2026-04").last, "2026-04-30");
});

test("only a real month is accepted as a view preference", () => {
  for (const good of ["2026-01", "2026-12"]) assert.equal(cal.isMonth(good), true, good);
  for (const bad of ["2026-13", "2026-00", "26-04", "2026-4", "april", "", undefined]) {
    assert.equal(cal.isMonth(bad as string | undefined), false, String(bad));
  }
});

// ── the typed-in half ────────────────────────────────────────────────────────

test("an event needs a title and a real start date", () => {
  assert.equal(cal.saveEvent(org, { title: " ", startsOn: day(3) }, dee).ok, false);
  assert.equal(cal.saveEvent(org, { title: "Fine", startsOn: "next tuesday" }, dee).ok, false);
  assert.equal(cal.saveEvent(org, { title: "Fine", startsOn: day(3) }, dee).ok, true);
});

test("an event cannot end before it starts, and a time looks like a time", () => {
  const backwards = cal.saveEvent(org, { title: "Backwards", startsOn: day(10), endsOn: day(3) }, dee);
  assert.equal(backwards.ok, false);
  assert.match((backwards as { error: string }).error, /end before it starts/i);

  assert.equal(cal.saveEvent(org, { title: "Bad time", startsOn: day(3), startsAt: "9am" }, dee).ok, false);
  assert.equal(cal.saveEvent(org, { title: "Good time", startsOn: day(3), startsAt: "09:30" }, dee).ok, true);
});

test("a multi-day event appears on every day it covers", () => {
  cal.saveEvent(org, { title: "Yard closed", startsOn: day(6), endsOn: day(8) }, dee);
  const dates = entriesFor(owner()).filter((e) => e.kind === "event").map((e) => e.date);
  assert.deepEqual(dates, [day(6), day(7), day(8)]);
});

test("an event overlapping the month edge is clipped to the month being shown", () => {
  cal.saveEvent(org, { title: "Long haul", startsOn: "2026-03-28", endsOn: "2026-05-02" }, dee);

  const april = entriesFor(owner()).filter((e) => e.kind === "event");
  assert.equal(april.length, 30, "every day of April, and not one day more");
  assert.equal(april[0]!.date, day(1));
  assert.equal(april[april.length - 1]!.date, day(30));
});

test("an event is the only thing on the calendar that can be removed", () => {
  cal.saveEvent(org, { title: "Mistake", startsOn: day(4) }, dee);
  const [event] = entriesFor(owner());
  assert.equal(event!.kind, "event");
  assert.ok(event!.eventId, "and it is the only kind carrying an eventId");

  assert.equal(cal.deleteEvent(org, event!.eventId!).ok, true);
  assert.equal(entriesFor(owner()).length, 0);
});

// ── the derived half ─────────────────────────────────────────────────────────

test("a load's stops appear as pickups and deliveries, linking to the load", () => {
  const load = write.createLoad(org, {
    carrierId: carrier,
    loadNumber: "L-2026-99",
    stops: [
      { kind: "pickup", city: "Dallas", state: "TX", scheduledAt: `${day(7)}T08:00:00Z` },
      { kind: "delivery", city: "Newark", state: "NJ", scheduledAt: `${day(9)}T14:30:00Z` },
    ],
  }, alpha.ownerId);
  assert.equal(load.ok, true);

  const entries = entriesFor(owner());
  const pickup = entries.find((e) => e.kind === "pickup")!;
  const delivery = entries.find((e) => e.kind === "delivery")!;

  assert.equal(pickup.date, day(7));
  assert.equal(pickup.time, "08:00");
  assert.match(pickup.title, /Dallas, TX/);
  assert.equal(pickup.href, `/loads/${(load as { id: number }).id}`);
  assert.equal(pickup.eventId, undefined, "a derived entry is not editable here");

  assert.equal(delivery.date, day(9));
  assert.equal(delivery.time, "14:30");
  assert.match(delivery.title, /Newark, NJ/);
});

test("open task due dates appear; completed ones do not", () => {
  tasks.saveTask(org, { title: "Chase the rate con", assignedTo: dee, dueOn: day(12) }, dee);
  const entries = entriesFor(owner());
  assert.equal(entries.filter((e) => e.kind === "task").length, 1);
  assert.equal(entries.find((e) => e.kind === "task")!.date, day(12));

  const [task] = tasks.listTasks(org, dee);
  tasks.setTaskDone(org, task!.id, true, dee);
  assert.equal(
    entriesFor(owner()).filter((e) => e.kind === "task").length,
    0,
    "resolving the record clears the calendar entry — nothing had to be deleted",
  );
});

test("insurance expiries appear for live carriers", () => {
  db.run("UPDATE carriers SET insurance_expires_on = ? WHERE organization_id = ? AND id = ?",
    [day(20), alpha.id, carrier]);

  const expiry = entriesFor(owner()).find((e) => e.kind === "insurance")!;
  assert.equal(expiry.date, day(20));
  assert.equal(expiry.detail, "Calendar Carrier LLC");
  assert.equal(expiry.href, `/carriers/${carrier}`);
});

test("nothing outside the month is pulled in", () => {
  cal.saveEvent(org, { title: "March thing", startsOn: "2026-03-30" }, dee);
  cal.saveEvent(org, { title: "May thing", startsOn: "2026-05-01" }, dee);
  tasks.saveTask(org, { title: "May task", assignedTo: dee, dueOn: "2026-05-04" }, dee);

  assert.equal(entriesFor(owner()).length, 0);
  assert.equal(entriesFor(owner(), "2026-03").length, 1);
  assert.equal(entriesFor(owner(), "2026-05").length, 2);
});

test("entries sort by date, then timed before all-day, then by title", () => {
  cal.saveEvent(org, { title: "Zulu all-day", startsOn: day(5) }, dee);
  cal.saveEvent(org, { title: "Alpha all-day", startsOn: day(5) }, dee);
  cal.saveEvent(org, { title: "Nine thirty", startsOn: day(5), startsAt: "09:30" }, dee);
  cal.saveEvent(org, { title: "Eight", startsOn: day(5), startsAt: "08:00" }, dee);
  cal.saveEvent(org, { title: "Earlier day", startsOn: day(4) }, dee);

  assert.deepEqual(entriesFor(owner()).map((e) => e.title), [
    "Earlier day",
    "Eight",
    "Nine thirty",
    "Alpha all-day",
    "Zulu all-day",
  ]);
});

// ── what each reader may see ─────────────────────────────────────────────────

test("each derived source is gated on the permission guarding its own records", () => {
  write.createLoad(org, {
    carrierId: carrier,
    stops: [
      { kind: "pickup", city: "Dallas", scheduledAt: `${day(7)}T08:00:00Z` },
      { kind: "delivery", city: "Newark", scheduledAt: `${day(9)}T14:30:00Z` },
    ],
  }, alpha.ownerId);
  db.run("UPDATE carriers SET insurance_expires_on = ? WHERE organization_id = ? AND id = ?",
    [day(20), alpha.id, carrier]);
  tasks.saveTask(org, { title: "Dee's task", assignedTo: dee, dueOn: day(12) }, dee);

  const kinds = (user: ReturnType<typeof asUser>) =>
    [...new Set(entriesFor(user).map((e) => e.kind))].sort();

  // An owner holds everything, so every source is on.
  assert.deepEqual(kinds(owner()), ["delivery", "insurance", "pickup", "task"]);

  // A dispatcher holds load:view and carrier:view, and sees their own tasks.
  assert.deepEqual(kinds(asUser(dee, C.ROLES.DISPATCHER)), ["delivery", "insurance", "pickup", "task"]);

  // Somebody else's task is not on their calendar, though the loads still are.
  const other = asUser(9999, C.ROLES.DISPATCHER);
  assert.deepEqual(kinds(other), ["delivery", "insurance", "pickup"]);
});

test("the calendar is administrators and dispatch, per the supplied spec", () => {
  const { can } = permissions;
  for (const action of ["calendar:view", "calendar:manage"] as const) {
    for (const role of [C.ROLES.OWNER, C.ROLES.ADMIN, C.ROLES.DISPATCHER]) {
      assert.equal(can(asUser(1, role), action), true, `${role} ${action}`);
    }
    for (const role of [C.ROLES.ACCOUNT_MANAGER, C.ROLES.SALES, C.ROLES.VIEWER, C.ROLES.SUPPORT]) {
      assert.equal(can(asUser(1, role), action), false, `${role} must not have ${action}`);
    }
  }
});

test("a dispatcher manages the events they raised, and an administrator manages all", () => {
  const { can } = permissions;
  const mine = { created_by: dee };
  assert.equal(can(asUser(dee, C.ROLES.DISPATCHER), "calendar:manage", mine), true);
  assert.equal(can(asUser(9999, C.ROLES.DISPATCHER), "calendar:manage", mine), false);
  assert.equal(can(asUser(9999, C.ROLES.ADMIN), "calendar:manage", mine), true);
});

test("one organisation's calendar is invisible to another", () => {
  cal.saveEvent(org, { title: "Alpha only", startsOn: day(3) }, dee);
  const betaOwner = {
    id: beta.ownerId,
    organization_id: beta.id,
    name: "Beta",
    email: "b@x.test",
    role: C.ROLES.OWNER as never,
    active: 1,
  };
  assert.equal(cal.monthEntries(betaOrg, betaOwner, MONTH).length, 0);

  const [event] = entriesFor(owner());
  assert.equal(cal.getEvent(betaOrg, event!.eventId!), undefined);
  assert.equal(cal.deleteEvent(betaOrg, event!.eventId!).ok, false, "and cannot be removed by id");
});
