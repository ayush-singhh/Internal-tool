import "server-only";
import { randomBytes } from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { all, get, run, systemQuery } from "./db.ts";
import { verifyPassword } from "./password.ts";
import type { SessionUser } from "./permissions.ts";
import { Org } from "./tenant-db.ts";
import { checkLogin, describeLockout, recordAttempt } from "./throttle.ts";

const COOKIE = "ch_session";
const SESSION_DAYS = 14;

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
): Promise<{ ok: true } | { ok: false; error: string }> {
  const ip = await clientIp();

  // Checked before any password work, so a locked account costs no scrypt time either.
  const verdict = checkLogin(email, ip);
  if (!verdict.allowed) return { ok: false, error: describeLockout(verdict) };

  const user = systemQuery(() =>
    get<{ id: number; password_hash: string; active: number }>(
      "SELECT id, password_hash, active FROM users WHERE email = ?",
      [email.trim().toLowerCase()],
    ),
  );

  // Same message either way — don't reveal which addresses exist.
  const invalid = { ok: false as const, error: "Incorrect email or password." };
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordAttempt(email, ip, false);
    return invalid;
  }
  if (!user.active) {
    recordAttempt(email, ip, false);
    return { ok: false, error: "This account has been deactivated." };
  }
  recordAttempt(email, ip, true);

  const id = randomBytes(32).toString("hex");
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86400_000);
  run("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)", [
    id,
    user.id,
    now.toISOString(),
    expires.toISOString(),
  ]);
  run("DELETE FROM sessions WHERE expires_at < ?", [now.toISOString()]);

  (await cookies()).set(COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  });
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
        WHERE s.id = ?`,
      [id],
    ),
  );
  if (!row) return null;
  if (new Date(row.expires_at) < new Date() || !row.active) {
    run("DELETE FROM sessions WHERE id = ?", [id]);
    return null;
  }
  const { expires_at: _drop, ...user } = row;
  void _drop;
  return user;
});

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
