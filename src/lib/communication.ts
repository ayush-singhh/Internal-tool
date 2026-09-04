import "server-only";
import { all, get, run } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import { can, type SessionUser } from "./permissions.ts";
import { CHANNEL_AUDIENCE_ALL, ROLE_LABELS, ROLES, type Role } from "./constants.ts";

/**
 * Communication — the internal channels, one per team plus a general one.
 *
 * A channel's `audience` is `all` or a single role. Whether somebody may read it is
 * `can(user, "message:view", channel)` and nothing else: the SQL below narrows the list
 * with the same rule so another team's channel never reaches the page, and the write path
 * asks `can()` again because a filtered list is presentation, not a boundary.
 *
 * Messages are append-only — the rule `carrier_notes` and `load_documents` already
 * follow. A message somebody has acted on must not be quietly rewritten afterwards; a
 * correction is a second message, which is how people work anyway.
 */

export type ChannelRow = {
  id: number;
  name: string;
  description: string | null;
  audience: string;
  seeded: number;
  archived: number;
  message_count: number;
  unread: number;
  last_message_at: string | null;
};

export type MessageRow = {
  id: number;
  channel_id: number;
  body: string;
  author_id: number | null;
  created_at: string;
  author_name: string | null;
  author_role: string | null;
};

export type Result = { ok: true; id: number } | { ok: false; error: string };

/** A channel's audience as a person reads it. */
export function audienceLabel(audience: string): string {
  if (audience === CHANNEL_AUDIENCE_ALL) return "Everyone";
  return `${ROLE_LABELS[audience as Role] ?? audience} · plus administrators`;
}

/**
 * The audience predicate, built once so the list, the counts and the guard cannot drift.
 * Whoever may manage channels sees all of them; everybody else sees `all` plus their own
 * team's. Returned as a fragment plus its parameters — never interpolated values.
 */
function audienceFilter(user: SessionUser): { sql: string; params: unknown[] } {
  if (can(user, "channel:manage")) return { sql: "", params: [] };
  return {
    sql: " AND (c.audience = ? OR c.audience = ?)",
    params: [CHANNEL_AUDIENCE_ALL, user.role],
  };
}

export function listChannels(org: Org, user: SessionUser, includeArchived = false): ChannelRow[] {
  const audience = audienceFilter(user);
  const archived = includeArchived ? "" : " AND c.archived = 0";
  return all<ChannelRow>(
    `SELECT c.id, c.name, c.description, c.audience, c.seeded, c.archived,
            (SELECT COUNT(*) FROM messages m
              WHERE m.organization_id = c.organization_id AND m.channel_id = c.id) AS message_count,
            (SELECT MAX(m.created_at) FROM messages m
              WHERE m.organization_id = c.organization_id AND m.channel_id = c.id) AS last_message_at,
            (SELECT COUNT(*) FROM messages m
               LEFT JOIN channel_reads r
                 ON r.organization_id = m.organization_id
                AND r.channel_id = m.channel_id AND r.user_id = ?
              WHERE m.organization_id = c.organization_id AND m.channel_id = c.id
                AND (m.author_id IS NULL OR m.author_id != ?)
                AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)) AS unread
       FROM channels c
      WHERE c.organization_id = ?${archived}${audience.sql}
      ORDER BY c.archived, c.seeded DESC, c.name`,
    [user.id, user.id, org.id, ...audience.params],
  );
}

/** One channel, or nothing. Callers must still ask `can()` — this does not decide access. */
export function getChannel(org: Org, id: number): { id: number; name: string; audience: string; archived: number } | undefined {
  return get("SELECT id, name, audience, archived FROM channels WHERE organization_id = ? AND id = ?", [org.id, id]);
}

export function listMessages(org: Org, channelId: number, limit = 200): MessageRow[] {
  // Oldest last in SQL so LIMIT keeps the *newest* messages, then reversed for display:
  // a conversation reads downward, but the window you want is the recent end of it.
  return all<MessageRow>(
    `SELECT m.*, u.name AS author_name, u.role AS author_role
       FROM messages m
       LEFT JOIN users u ON u.organization_id = m.organization_id AND u.id = m.author_id
      WHERE m.organization_id = ? AND m.channel_id = ?
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ?`,
    [org.id, channelId, limit],
  ).reverse();
}

export function postMessage(org: Org, channelId: number, body: string, userId: number): Result {
  const clean = body.trim().slice(0, 4000);
  if (!clean) return { ok: false, error: "There is nothing to send." };

  const channel = getChannel(org, channelId);
  if (!channel) return { ok: false, error: "Unknown channel." };
  if (channel.archived) return { ok: false, error: "This channel is archived." };

  run(
    "INSERT INTO messages (organization_id, channel_id, body, author_id, created_at) VALUES (?, ?, ?, ?, ?)",
    [org.id, channelId, clean, userId, new Date().toISOString()],
  );
  return { ok: true, id: get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id };
}

/** Called when a channel is opened. Everything up to now has been seen. */
export function markChannelRead(org: Org, channelId: number, userId: number): void {
  run(
    `INSERT INTO channel_reads (organization_id, channel_id, user_id, last_read_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (organization_id, channel_id, user_id) DO UPDATE SET last_read_at = excluded.last_read_at`,
    [org.id, channelId, userId, new Date().toISOString()],
  );
}

/** Unread across every channel this person can see — the sidebar badge and one alert. */
export function unreadMessages(org: Org, user: SessionUser): number {
  const audience = audienceFilter(user);
  return get<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM messages m
       JOIN channels c ON c.organization_id = m.organization_id AND c.id = m.channel_id
       LEFT JOIN channel_reads r
         ON r.organization_id = m.organization_id
        AND r.channel_id = m.channel_id AND r.user_id = ?
      WHERE m.organization_id = ? AND c.archived = 0
        AND (m.author_id IS NULL OR m.author_id != ?)
        AND (r.last_read_at IS NULL OR m.created_at > r.last_read_at)${audience.sql}`,
    [user.id, org.id, user.id, ...audience.params],
  )!.n;
}

const AUDIENCES: string[] = [CHANNEL_AUDIENCE_ALL, ...Object.values(ROLES).filter((r) => r !== ROLES.SUPPORT)];

export function createChannel(
  org: Org,
  input: { name: string; description?: string | null; audience?: string | null },
  userId: number | null,
): Result {
  const name = input.name.trim().slice(0, 80);
  if (!name) return { ok: false, error: "A channel needs a name." };

  const audience = input.audience ?? CHANNEL_AUDIENCE_ALL;
  // Platform support is not a role inside an organisation, so a channel cannot be
  // addressed to it — that would be a room nobody in the company could enter.
  if (!AUDIENCES.includes(audience)) return { ok: false, error: "Unknown audience." };

  const clash = get<{ name: string }>(
    "SELECT name FROM channels WHERE organization_id = ? AND lower(name) = lower(?)",
    [org.id, name],
  );
  if (clash) return { ok: false, error: `${clash.name} already exists.` };

  run(
    `INSERT INTO channels (organization_id, name, description, audience, seeded, archived, created_at, created_by)
     VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
    [org.id, name, input.description?.trim() || null, audience, new Date().toISOString(), userId],
  );
  return { ok: true, id: get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id };
}

/** Archiving keeps every message. Nothing here deletes a conversation. */
export function setChannelArchived(org: Org, id: number, archived: boolean): Result {
  if (!getChannel(org, id)) return { ok: false, error: "Unknown channel." };
  run("UPDATE channels SET archived = ? WHERE organization_id = ? AND id = ?", [archived ? 1 : 0, org.id, id]);
  return { ok: true, id };
}
