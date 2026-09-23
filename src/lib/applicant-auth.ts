import "server-only";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { get, run, systemQuery } from "./db.ts";
import { Org } from "./tenant-db.ts";
import type { Portal } from "./portal.ts";

/**
 * The applicant session — the portal's half of a two-realm authentication model.
 *
 * An applicant is **not a user**. It has no row in `users`, no role, is assignable to
 * nothing, and may reach exactly one application. That is why this reads a different
 * cookie and a different table from `auth.ts`: `requireUser()` can never return an
 * applicant and nothing here can ever return a staff user, because neither one can see
 * the other's storage.
 *
 * The session is created only by a verified one-time code (see `applicant-otp.ts`), and
 * it authorises editing the single application named on the row.
 */
const COOKIE = "ch_applicant";

/** Long enough to gather insurance certificates and a W-9 without starting over, short
 *  enough that a shared or borrowed machine does not stay open indefinitely. */
const TTL_HOURS = 72;

export type Applicant = { org: Org; applicationId: number };

export async function openApplicantSession(orgId: number, applicationId: number): Promise<void> {
  const id = randomUUID();
  const now = new Date();
  const expires = new Date(now.getTime() + TTL_HOURS * 3_600_000);

  systemQuery(() =>
    run(
      `INSERT INTO applicant_sessions (id, organization_id, application_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [id, orgId, applicationId, now.toISOString(), expires.toISOString()],
    ),
  );

  (await cookies()).set(COOKIE, id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  });
}

/** The application this browser is authorised to edit, if any. */
export async function currentApplicant(): Promise<Applicant | null> {
  const id = (await cookies()).get(COOKIE)?.value;
  if (!id) return null;

  // Reached from a cookie before any organisation is known — the same position the
  // staff session lookup is in, and a system query by definition.
  const row = systemQuery(() =>
    get<{ organization_id: number; application_id: number; expires_at: string }>(
      "SELECT organization_id, application_id, expires_at FROM applicant_sessions WHERE id = ?",
      [id],
    ),
  );
  if (!row) return null;

  if (new Date(row.expires_at) < new Date()) {
    systemQuery(() => run("DELETE FROM applicant_sessions WHERE id = ?", [id]));
    return null;
  }

  return { org: new Org(row.organization_id), applicationId: row.application_id };
}

/**
 * The applicant for *this* portal.
 *
 * A session is scoped to the organisation that issued it. Carrying a session for one
 * dispatcher to another dispatcher's portal is not partial authentication — it is none,
 * so the second portal sees an anonymous visitor.
 */
export async function applicantFor(portal: Portal): Promise<Applicant | null> {
  const applicant = await currentApplicant();
  if (!applicant || applicant.org.id !== portal.org.id) return null;
  return applicant;
}

export async function endApplicantSession(): Promise<void> {
  const store = await cookies();
  const id = store.get(COOKIE)?.value;
  if (id) systemQuery(() => run("DELETE FROM applicant_sessions WHERE id = ?", [id]));
  store.delete(COOKIE);
}
