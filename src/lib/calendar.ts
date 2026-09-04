import "server-only";
import { all, get, run } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import { can, type SessionUser } from "./permissions.ts";
import { idsOf } from "./lookups.ts";
import { STATUS, TASK_STATUS, type Tone } from "./constants.ts";

/**
 * The planning calendar — both halves, deliberately.
 *
 * **Derived**: pickup and delivery dates from `load_stops`, open task due dates, insurance
 * expiries. These are read-only *windows* onto their own record. You do not move a pickup
 * by dragging it here; you open the load. That keeps one source of truth and stops the
 * calendar becoming a second write path into dispatch.
 *
 * **Typed in**: `calendar_events`, for the things that exist nowhere else — a meeting, a
 * yard closure, a driver's holiday.
 *
 * Every derived source is gated on the permission that already guards it, so the calendar
 * can never show somebody a date it would refuse them the record behind.
 */

export type EntryKind = "event" | "pickup" | "delivery" | "task" | "insurance";

export type CalendarEntry = {
  /** Stable within a render; `kind` plus the source row's id. */
  key: string;
  kind: EntryKind;
  /** YYYY-MM-DD. */
  date: string;
  /** HH:MM, or null for an all-day entry. Sorts within the day. */
  time: string | null;
  title: string;
  detail: string | null;
  href: string | null;
  tone: Tone;
  /** Present only on the typed-in half — the only entries that can be edited here. */
  eventId?: number;
};

export type EventRow = {
  id: number;
  title: string;
  details: string | null;
  starts_on: string;
  ends_on: string | null;
  starts_at: string | null;
  carrier_id: number | null;
  created_by: number | null;
};

export type Result = { ok: true; id: number } | { ok: false; error: string };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Today in the same shape everything else here uses. */
export const todayIso = (): string => new Date().toISOString().slice(0, 10);

/** The month a page defaults to, and what a bad `?month=` falls back to. */
export function currentMonth(): string {
  return todayIso().slice(0, 7);
}

export function isMonth(value: string | undefined): value is string {
  return value !== undefined && MONTH.test(value);
}

/**
 * The days of one month, plus the leading blanks that put the 1st under its weekday.
 *
 * All arithmetic is UTC on `YYYY-MM-DD` strings. Local-time `Date` maths silently shifts a
 * date by a day either side of midnight depending on the server's zone, and a calendar
 * that is off by one for half the world is worse than no calendar.
 */
export function monthGrid(month: string): {
  days: string[];
  leadingBlanks: number;
  first: string;
  last: string;
  previous: string;
  next: string;
  label: string;
} {
  const [year, mon] = month.split("-").map(Number) as [number, number];
  const firstDate = new Date(Date.UTC(year, mon - 1, 1));
  const dayCount = new Date(Date.UTC(year, mon, 0)).getUTCDate();

  const days: string[] = [];
  for (let d = 1; d <= dayCount; d++) {
    days.push(`${month}-${String(d).padStart(2, "0")}`);
  }

  const step = (delta: number) => {
    const at = new Date(Date.UTC(year, mon - 1 + delta, 1));
    return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
  };

  return {
    days,
    // Monday-first, so a working week reads as one block rather than being split.
    leadingBlanks: (firstDate.getUTCDay() + 6) % 7,
    first: days[0]!,
    last: days[days.length - 1]!,
    previous: step(-1),
    next: step(1),
    label: firstDate.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }),
  };
}

/** Every day an event covers. A three-day event belongs on three days. */
function span(event: { starts_on: string; ends_on: string | null }, first: string, last: string): string[] {
  const start = event.starts_on;
  const end = event.ends_on && event.ends_on > start ? event.ends_on : start;
  const days: string[] = [];
  // Bounded by the month being rendered, so a year-long event cannot spin here.
  for (let at = start > first ? start : first; at <= (end < last ? end : last); ) {
    days.push(at);
    const next = new Date(`${at}T00:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    at = next.toISOString().slice(0, 10);
  }
  return days;
}

/**
 * Everything on one month, from both halves, ordered by date then time.
 *
 * Each derived block asks the permission that guards its own records first — so this
 * cannot leak a load date to somebody who may not open the load.
 */
export function monthEntries(org: Org, user: SessionUser, month: string): CalendarEntry[] {
  const { first, last } = monthGrid(month);
  const entries: CalendarEntry[] = [];

  // ── typed in ───────────────────────────────────────────────────────────────
  const events = all<EventRow & { carrier_name: string | null }>(
    `SELECT e.*, c.legal_name AS carrier_name
       FROM calendar_events e
       LEFT JOIN carriers c ON c.organization_id = e.organization_id AND c.id = e.carrier_id
      WHERE e.organization_id = ?
        AND e.starts_on <= ? AND COALESCE(e.ends_on, e.starts_on) >= ?
      ORDER BY e.starts_on, e.starts_at`,
    [org.id, last, first],
  );
  for (const event of events) {
    for (const date of span(event, first, last)) {
      entries.push({
        key: `event:${event.id}:${date}`,
        kind: "event",
        date,
        time: event.starts_at,
        title: event.title,
        detail: event.carrier_name ?? event.details,
        href: null,
        tone: "blue",
        eventId: event.id,
      });
    }
  }

  // ── derived: loads ─────────────────────────────────────────────────────────
  if (can(user, "load:view")) {
    const stops = all<{
      kind: string; scheduled_at: string; city: string | null; state: string | null;
      load_id: number; load_number: string | null; legal_name: string | null;
    }>(
      `SELECT s.kind, s.scheduled_at, s.city, s.state,
              l.id AS load_id, l.load_number, c.legal_name
         FROM load_stops s
         JOIN loads l    ON l.organization_id = s.organization_id AND l.id = s.load_id
         LEFT JOIN carriers c ON c.organization_id = l.organization_id AND c.id = l.carrier_id
        WHERE s.organization_id = ? AND s.scheduled_at IS NOT NULL
          AND substr(s.scheduled_at, 1, 10) BETWEEN ? AND ?
        ORDER BY s.scheduled_at`,
      [org.id, first, last],
    );
    for (const stop of stops) {
      const where = [stop.city, stop.state].filter(Boolean).join(", ");
      entries.push({
        key: `stop:${stop.load_id}:${stop.kind}:${stop.scheduled_at}`,
        kind: stop.kind === "pickup" ? "pickup" : "delivery",
        date: stop.scheduled_at.slice(0, 10),
        time: stop.scheduled_at.length >= 16 ? stop.scheduled_at.slice(11, 16) : null,
        title: `${stop.kind === "pickup" ? "Pick up" : "Deliver"}${where ? ` · ${where}` : ""}`,
        detail: stop.load_number ?? stop.legal_name,
        href: `/loads/${stop.load_id}`,
        tone: stop.kind === "pickup" ? "amber" : "green",
      });
    }
  }

  // ── derived: tasks ─────────────────────────────────────────────────────────
  // Same scope rule as /tasks, navCounts and alerts.ts — whoever may assign sees the whole
  // board, everyone else their own. A fourth place that has to agree with the other three.
  const taskScope = can(user, "task:assign") ? undefined : user.id;
  const mine = taskScope === undefined ? "" : " AND (t.assigned_to = ? OR t.created_by = ?)";
  const tasks = all<{ id: number; title: string; due_on: string; assignee: string | null }>(
    `SELECT t.id, t.title, t.due_on, u.name AS assignee
       FROM tasks t
       LEFT JOIN users u ON u.organization_id = t.organization_id AND u.id = t.assigned_to
      WHERE t.organization_id = ? AND t.status = ?
        AND t.due_on IS NOT NULL AND t.due_on BETWEEN ? AND ?${mine}
      ORDER BY t.due_on`,
    [org.id, TASK_STATUS.OPEN, first, last, ...(taskScope === undefined ? [] : [taskScope, taskScope])],
  );
  for (const task of tasks) {
    entries.push({
      key: `task:${task.id}`,
      kind: "task",
      date: task.due_on,
      time: null,
      title: task.title,
      detail: task.assignee,
      href: "/tasks",
      tone: "purple",
    });
  }

  // ── derived: insurance ─────────────────────────────────────────────────────
  if (can(user, "carrier:view")) {
    const live = idsOf(org, "status", [STATUS.ACTIVE, STATUS.ABOUT_TO_BE_ACTIVE]);
    if (live.length > 0) {
      const expiring = all<{ id: number; legal_name: string; insurance_expires_on: string }>(
        `SELECT id, legal_name, insurance_expires_on
           FROM carriers
          WHERE organization_id = ? AND status_id IN (${live.map(() => "?").join(",")})
            AND insurance_expires_on IS NOT NULL
            AND insurance_expires_on BETWEEN ? AND ?
          ORDER BY insurance_expires_on`,
        [org.id, ...live, first, last],
      );
      for (const carrier of expiring) {
        entries.push({
          key: `insurance:${carrier.id}`,
          kind: "insurance",
          date: carrier.insurance_expires_on,
          time: null,
          title: "Insurance expires",
          detail: carrier.legal_name,
          href: `/carriers/${carrier.id}`,
          tone: "red",
        });
      }
    }
  }

  // Timed entries first within a day, then all-day ones, then alphabetically — stable,
  // so two renders of the same month never disagree about the order.
  return entries.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.time ?? "99:99").localeCompare(b.time ?? "99:99") ||
      a.title.localeCompare(b.title),
  );
}

export function getEvent(org: Org, id: number): EventRow | undefined {
  return get<EventRow>("SELECT * FROM calendar_events WHERE organization_id = ? AND id = ?", [org.id, id]);
}

export type EventInput = {
  id?: number | null;
  title: string;
  details?: string | null;
  startsOn: string;
  endsOn?: string | null;
  startsAt?: string | null;
  carrierId?: number | null;
};

export function saveEvent(org: Org, input: EventInput, userId: number | null): Result {
  const title = input.title.trim().slice(0, 200);
  if (!title) return { ok: false, error: "An event needs a title." };

  const startsOn = input.startsOn?.trim() ?? "";
  if (!DATE.test(startsOn)) return { ok: false, error: "An event needs a real start date." };

  const endsOn = input.endsOn?.trim() || null;
  if (endsOn !== null && !DATE.test(endsOn)) return { ok: false, error: "That end date is not a date." };
  if (endsOn !== null && endsOn < startsOn) {
    return { ok: false, error: "An event cannot end before it starts." };
  }

  const startsAt = input.startsAt?.trim() || null;
  if (startsAt !== null && !TIME.test(startsAt)) return { ok: false, error: "A time looks like 09:30." };

  const now = new Date().toISOString();
  const fields = [title, input.details?.trim() || null, startsOn, endsOn, startsAt, input.carrierId ?? null];

  if (input.id) {
    if (!getEvent(org, input.id)) return { ok: false, error: "Unknown event." };
    run(
      `UPDATE calendar_events SET title = ?, details = ?, starts_on = ?, ends_on = ?,
              starts_at = ?, carrier_id = ?, updated_at = ?, updated_by = ?
        WHERE organization_id = ? AND id = ?`,
      [...fields, now, userId, org.id, input.id],
    );
    return { ok: true, id: input.id };
  }

  run(
    `INSERT INTO calendar_events (organization_id, title, details, starts_on, ends_on,
                                  starts_at, carrier_id, created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [org.id, ...fields, now, userId, now, userId],
  );
  return { ok: true, id: get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id };
}

/** Removing an event. Only the typed-in half can be removed at all — everything else on
 *  the calendar is a window onto a record that lives somewhere else. */
export function deleteEvent(org: Org, id: number): Result {
  if (!getEvent(org, id)) return { ok: false, error: "Unknown event." };
  run("DELETE FROM calendar_events WHERE organization_id = ? AND id = ?", [org.id, id]);
  return { ok: true, id };
}
