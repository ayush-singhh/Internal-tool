import "server-only";
import { all, run, systemQuery } from "./db.ts";

/**
 * The list of places an account is signed in, and the ability to end one.
 *
 * Sessions are rows, so revocation is a DELETE and takes effect on the next request —
 * there is no token to wait out. Everything here is keyed by user id and takes the
 * current session id explicitly, so it can be tested: `auth.ts` reads the cookie and
 * passes both in.
 *
 * Every function scopes by `user_id`. A session id is unguessable, but "unguessable" is
 * not an authorisation check, and this is the one place where the ids of other people's
 * sessions are being handled at all.
 */
export type ActiveSession = {
  id: string;
  created_at: string;
  last_seen_at: string | null;
  expires_at: string;
  user_agent: string | null;
  ip: string | null;
  current: boolean;
  device: string;
};

/** Best-effort, and honest about it: the raw string is kept so nobody has to trust this.
 *  ponytail: a dozen lines rather than a UA-parsing dependency that ships a database of
 *  every browser ever made, for a label next to a "sign out" button. */
export function describeDevice(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  const browser =
    /\bEdg\//.test(userAgent) ? "Edge"
    : /\bOPR\/|\bOpera\b/.test(userAgent) ? "Opera"
    : /\bChrome\/|\bCriOS\//.test(userAgent) ? "Chrome"
    : /\bFirefox\/|\bFxiOS\//.test(userAgent) ? "Firefox"
    : /\bSafari\//.test(userAgent) ? "Safari"
    : "Unknown browser";
  const os =
    /\biPhone\b|\biPad\b/.test(userAgent) ? "iOS"
    : /\bAndroid\b/.test(userAgent) ? "Android"
    : /\bMac OS X\b|\bMacintosh\b/.test(userAgent) ? "macOS"
    : /\bWindows\b/.test(userAgent) ? "Windows"
    : /\bLinux\b/.test(userAgent) ? "Linux"
    : null;
  return os ? `${browser} on ${os}` : browser;
}

export function listSessions(userId: number, currentId: string | null): ActiveSession[] {
  const rows = systemQuery(() =>
    all<Omit<ActiveSession, "current" | "device">>(
      `SELECT id, created_at, last_seen_at, expires_at, user_agent, ip
         FROM sessions
        WHERE user_id = ? AND expires_at > ? AND mfa_pending = 0
        ORDER BY COALESCE(last_seen_at, created_at) DESC`,
      [userId, new Date().toISOString()],
    ),
  );
  return rows.map((row) => ({
    ...row,
    current: row.id === currentId,
    device: describeDevice(row.user_agent),
  }));
}

/** Ends one session belonging to this account. Refuses the current one — signing yourself
 *  out belongs on the sign-out button, where it does not look like a mistake. */
export function revokeSession(userId: number, currentId: string | null, targetId: string): boolean {
  if (!targetId || targetId === currentId) return false;
  const result = systemQuery(() =>
    run("DELETE FROM sessions WHERE id = ? AND user_id = ?", [targetId, userId]),
  );
  return result.changes === 1;
}

/** The "I have lost a laptop" button: everything except the browser asking. */
export function revokeOtherSessions(userId: number, currentId: string | null): number {
  const result = systemQuery(() =>
    run("DELETE FROM sessions WHERE user_id = ? AND id != ?", [userId, currentId ?? ""]),
  );
  return Number(result.changes);
}

/** Written on each request, at most once every few minutes — a session's usefulness is in
 *  when it was last used, and a write per page view is a write per page view. */
const SEEN_EVERY_MS = 5 * 60_000;

export function touchSession(sessionId: string): void {
  const cutoff = new Date(Date.now() - SEEN_EVERY_MS).toISOString();
  systemQuery(() =>
    run(
      `UPDATE sessions SET last_seen_at = ?
        WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < ?)`,
      [new Date().toISOString(), sessionId, cutoff],
    ),
  );
}
