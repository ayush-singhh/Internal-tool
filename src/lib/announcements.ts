import "server-only";
import { all, get, run } from "./db.ts";
import type { Org } from "./tenant-db.ts";

/**
 * Announcements — the organisation's noticeboard.
 *
 * Unread is "published since you last opened the page", held as one timestamp on the
 * user rather than a read-receipt table. That answers the only question anything asks —
 * the sidebar badge and the alerts feed — with no per-row writes.
 */

export type AnnouncementRow = {
  id: number;
  title: string;
  body: string;
  published_at: string;
  created_by: number | null;
  author_name: string | null;
};

export type Result = { ok: true; id: number } | { ok: false; error: string };

export function listAnnouncements(org: Org, limit = 50): AnnouncementRow[] {
  return all<AnnouncementRow>(
    `SELECT a.id, a.title, a.body, a.published_at, a.created_by, u.name AS author_name
       FROM announcements a
       LEFT JOIN users u ON u.organization_id = a.organization_id AND u.id = a.created_by
      WHERE a.organization_id = ?
      ORDER BY a.published_at DESC, a.id DESC
      LIMIT ?`,
    [org.id, limit],
  );
}

export function getAnnouncement(org: Org, id: number): AnnouncementRow | undefined {
  return get<AnnouncementRow>(
    "SELECT * FROM announcements WHERE organization_id = ? AND id = ?",
    [org.id, id],
  );
}

/** How many were published since this person last looked. */
export function unreadCount(org: Org, userId: number): number {
  const seen = get<{ announcements_seen_at: string | null }>(
    "SELECT announcements_seen_at FROM users WHERE organization_id = ? AND id = ?",
    [org.id, userId],
  )?.announcements_seen_at;
  // A user who has never opened the page has everything unread, which is the right
  // welcome: the noticeboard is worth nothing if a new joiner starts at zero.
  return get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM announcements
      WHERE organization_id = ?${seen ? " AND published_at > ?" : ""}`,
    seen ? [org.id, seen] : [org.id],
  )!.n;
}

/** Called when the page is opened. Everything published up to now is read. */
export function markAnnouncementsSeen(org: Org, userId: number): void {
  run(
    "UPDATE users SET announcements_seen_at = ? WHERE organization_id = ? AND id = ?",
    [new Date().toISOString(), org.id, userId],
  );
}

export function saveAnnouncement(
  org: Org,
  input: { id?: number | null; title: string; body: string },
  userId: number | null,
): Result {
  const title = input.title.trim().slice(0, 200);
  const body = input.body.trim();
  if (!title) return { ok: false, error: "An announcement needs a title." };
  if (!body) return { ok: false, error: "An announcement needs something to say." };

  const now = new Date().toISOString();
  if (input.id) {
    if (!getAnnouncement(org, input.id)) return { ok: false, error: "Unknown announcement." };
    // `published_at` is deliberately untouched by an edit: fixing a typo must not shove
    // the notice back to the top of everybody's unread list.
    run(
      `UPDATE announcements SET title = ?, body = ?, updated_at = ?, updated_by = ?
        WHERE organization_id = ? AND id = ?`,
      [title, body, now, userId, org.id, input.id],
    );
    return { ok: true, id: input.id };
  }

  run(
    `INSERT INTO announcements (organization_id, title, body, published_at,
                                created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [org.id, title, body, now, now, userId, now, userId],
  );
  return { ok: true, id: get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id };
}

/** Withdrawing one. An announcement is a notice, not a record — once it is wrong or
 *  spent, leaving it up is worse than removing it. */
export function deleteAnnouncement(org: Org, id: number): Result {
  if (!getAnnouncement(org, id)) return { ok: false, error: "Unknown announcement." };
  run("DELETE FROM announcements WHERE organization_id = ? AND id = ?", [org.id, id]);
  return { ok: true, id };
}
