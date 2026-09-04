import "server-only";
import { get, run } from "./db.ts";
import type { Org } from "./tenant-db.ts";

/**
 * Working Notes — one private page of free text per person.
 *
 * There is no permission here on purpose. A scratchpad on your own user row is not
 * somebody else's data, so there is no question for `can()` to answer; the reader and the
 * subject are the same person, and every query below is keyed on both their id and their
 * organisation. That is also why it is on every panel rather than only the Sales one the
 * client's menu shows it on: gating a private note by role would mean a dispatcher who
 * wants to jot a phone number reaches for a sticky note instead.
 *
 * Nothing is derived from this and nothing reads it but its owner. It is deliberately the
 * least clever thing in the codebase.
 */

/** How much one person may keep. Generous for notes, small enough that a paste of a
 *  spreadsheet does not quietly become a database problem. */
export const WORKING_NOTES_MAX = 20_000;

export type WorkingNotes = { body: string; savedAt: string | null };

export function workingNotes(org: Org, userId: number): WorkingNotes {
  const row = get<{ working_notes: string | null; working_notes_at: string | null }>(
    "SELECT working_notes, working_notes_at FROM users WHERE organization_id = ? AND id = ?",
    [org.id, userId],
  );
  return { body: row?.working_notes ?? "", savedAt: row?.working_notes_at ?? null };
}

export function saveWorkingNotes(
  org: Org,
  userId: number,
  body: string,
): { ok: true } | { ok: false; error: string } {
  if (body.length > WORKING_NOTES_MAX) {
    return { ok: false, error: `Notes are limited to ${WORKING_NOTES_MAX.toLocaleString()} characters.` };
  }
  // Emptied on purpose is stored as NULL rather than as "", so "never written" and
  // "cleared" read the same way — there is nothing to tell apart.
  const trimmed = body.trim();
  run(
    "UPDATE users SET working_notes = ?, working_notes_at = ? WHERE organization_id = ? AND id = ?",
    [trimmed === "" ? null : trimmed, new Date().toISOString(), org.id, userId],
  );
  return { ok: true };
}
