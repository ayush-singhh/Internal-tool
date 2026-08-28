import "server-only";
import { all, run } from "./db.ts";

export type ActivityType =
  | "created" | "status" | "assignment" | "pricing" | "agreement"
  | "subscription" | "offboarding" | "reactivation" | "note" | "field" | "import";

export type ActivityRow = {
  id: number;
  carrier_id: number;
  user_id: number | null;
  type: ActivityType;
  field: string | null;
  old_value: string | null;
  new_value: string | null;
  summary: string;
  created_at: string;
  user_name: string | null;
};

/** Append-only. Nothing in the application updates or deletes an activity row. */
export function recordActivity(entry: {
  carrierId: number;
  userId: number | null;
  type: ActivityType;
  summary: string;
  field?: string | null;
  oldValue?: string | null;
  newValue?: string | null;
  at?: string;
}) {
  run(
    `INSERT INTO carrier_activity
       (carrier_id, user_id, type, field, old_value, new_value, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.carrierId,
      entry.userId,
      entry.type,
      entry.field ?? null,
      entry.oldValue ?? null,
      entry.newValue ?? null,
      entry.summary,
      entry.at ?? new Date().toISOString(),
    ],
  );
}

export function carrierActivity(carrierId: number, limit = 200): ActivityRow[] {
  return all<ActivityRow>(
    `SELECT a.*, u.name AS user_name
       FROM carrier_activity a
       LEFT JOIN users u ON u.id = a.user_id
      WHERE a.carrier_id = ?
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ?`,
    [carrierId, limit],
  );
}

export function recentActivity(limit = 12): (ActivityRow & { legal_name: string })[] {
  return all<ActivityRow & { legal_name: string }>(
    `SELECT a.*, u.name AS user_name, c.legal_name
       FROM carrier_activity a
       LEFT JOIN users u ON u.id = a.user_id
       JOIN carriers c ON c.id = a.carrier_id
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT ?`,
    [limit],
  );
}

export type NoteRow = {
  id: number;
  carrier_id: number;
  user_id: number | null;
  body: string;
  pinned: number;
  created_at: string;
  user_name: string | null;
};

export function carrierNotes(carrierId: number): NoteRow[] {
  return all<NoteRow>(
    `SELECT n.*, u.name AS user_name
       FROM carrier_notes n
       LEFT JOIN users u ON u.id = n.user_id
      WHERE n.carrier_id = ?
      ORDER BY n.pinned DESC, n.created_at DESC, n.id DESC`,
    [carrierId],
  );
}
