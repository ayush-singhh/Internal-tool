import "server-only";
import { randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { all, get, run, systemQuery } from "./db.ts";
import { passwordStep, secondFactorStep } from "./login.ts";
import { touchSession } from "./sessions.ts";
import type { SessionUser } from "./permissions.ts";
import { Org } from "./tenant-db.ts";

const COOKIE = "ch_session";
const SESSION_DAYS = 14;
/** How long the half-finished sign-in of an MFA account survives. Long enough to open
 *  an authenticator app and read a code; short enough that walking away ends it. */
const MFA_PENDING_MINUTES = 10;

/** Best-effort client address. Trusts the proxy header, which is correct behind one and
 *  harmless without: throttling is defence in depth, not an authorization decision. */
async function clientIp(): Promise<string | null> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim().slice(0, 64) || null;
  return h.get("x-real-ip")?.slice(0, 64) ?? null;
}

export async function signIn(
  email: string,
  password: string,
): Promise<{ ok: true; mfaRequired: boolean } | { ok: false; error: string }> {
  const step = passwordStep(email, password, await clientIp());
  if (!step.ok) return step;

  // With a second factor on, the password buys only a pending session: getCurrentUser()
  // refuses it, so it opens no page and reads no data until a code confirms it.
  const now = new Date();
  const expires = new Date(
    now.getTime() + (step.mfaRequired ? MFA_PENDING_MINUTES * 60_000 : SESSION_DAYS * 86400_000),
  );
  await issueSession(step.userId, expires, step.mfaRequired);
  run("DELETE FROM sessions WHERE expires_at < ?", [now.toISOString()]);
  return { ok: true, mfaRequired: step.mfaRequired };
}

/** Writes a session row and puts its id in the cookie. The id is fresh every time, so
 *  completing MFA replaces the pending id rather than promoting it. */
async function issueSession(userId: number, expires: Date, pending: boolean): Promise<string> {
  const id = randomBytes(32).toString("hex");
  const now = new Date().toISOString();
  const h = await headers();
  run(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, mfa_pending,
                           user_agent, ip, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, userId, now, expires.toISOString(), pending ? 1 : 0,
      // Kept so the owner of the account can recognise their own sessions in the list —
      // it is a label, never a check.
      h.get("user-agent")?.slice(0, 300) ?? null,
      await clientIp(),
      now,
    ],
  );
  (await cookies()).set(COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  });
  return id;
}

export type PendingLogin = { sessionId: string; userId: number; email: string; name: string };

/** The half-finished sign-in this browser is holding, if any. Drives the code prompt. */
export async function getPendingLogin(): Promise<PendingLogin | null> {
  const id = (await cookies()).get(COOKIE)?.value;
  if (!id) return null;
  const row = systemQuery(() =>
    get<{ user_id: number; email: string; name: string; expires_at: string }>(
      `SELECT s.user_id, s.expires_at, u.email, u.name
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.mfa_pending = 1`,
      [id],
    ),
  );
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    run("DELETE FROM sessions WHERE id = ?", [id]);
    return null;
  }
  return { sessionId: id, userId: row.user_id, email: row.email, name: row.name };
}

/**
 * The second half of an MFA sign-in. Throttled on the same counters as the password
 * step, so guessing six digits is limited by the account lock, not by how fast codes
 * can be posted.
 */
export async function completeSecondFactor(
  code: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const pending = await getPendingLogin();
  if (!pending) return { ok: false, error: "That sign-in expired. Start again." };

  const step = secondFactorStep(pending.userId, pending.email, code, await clientIp());
  if (!step.ok) return step;

  // A fresh id: the one issued before the code was confirmed never becomes a full session.
  await issueSession(pending.userId, new Date(Date.now() + SESSION_DAYS * 86400_000), false);
  run("DELETE FROM sessions WHERE id = ?", [pending.sessionId]);
  return { ok: true };
}

export async function signOut() {
  const store = await cookies();
  const id = store.get(COOKIE)?.value;
  if (id) run("DELETE FROM sessions WHERE id = ?", [id]);
  store.delete(COOKIE);
}

/** Cached per request so a page and its children don't re-query the session. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const id = (await cookies()).get(COOKIE)?.value;
  if (!id) return null;
  // Session→user lookup runs before an org is known, and joins the global sessions
  // table, so it is a system query by definition.
  const row = systemQuery(() =>
    get<SessionUser & { expires_at: string }>(
      `SELECT u.id, u.organization_id, u.name, u.email, u.role, u.active, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.mfa_pending = 0`,
      [id],
    ),
  );
  if (!row) return null;
  if (new Date(row.expires_at) < new Date() || !row.active) {
    run("DELETE FROM sessions WHERE id = ?", [id]);
    return null;
  }
  touchSession(id);
  const { expires_at: _drop, ...user } = row;
  void _drop;
  return user;
});

/** The id in this browser's cookie, for the sessions list. Not a credential on its own —
 *  every query using it is also scoped by user id. */
export async function currentSessionId(): Promise<string | null> {
  return (await cookies()).get(COOKIE)?.value ?? null;
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * The authenticated organisation, as an `Org` to be threaded into tenant queries. This is
 * the ONLY source of tenant identity in the application — it comes from the server-side
 * session, never from a request parameter, header or body.
 */
export async function requireOrg(): Promise<{ user: SessionUser; org: Org }> {
  const user = await requireUser();
  return { user, org: new Org(user.organization_id) };
}

/** True before anyone has changed the seeded admin password — drives the login hint. */
export function isFirstRun(): boolean {
  return systemQuery(() => {
    const { count } = get<{ count: number }>("SELECT COUNT(*) AS count FROM users")!;
    const { sessions } = get<{ sessions: number }>(
      "SELECT COUNT(*) AS sessions FROM sessions",
    )!;
    return count === 1 && sessions === 0;
  });
}

export function listAssignableUsers(org: Org) {
  return all<{ id: number; name: string; role: string }>(
    "SELECT id, name, role FROM users WHERE organization_id = ? AND active = 1 ORDER BY name",
    [org.id],
  );
}
