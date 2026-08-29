import "server-only";
import { all, get, run, systemQuery } from "./db.ts";
import { ROLES } from "./constants.ts";
import type { SessionUser } from "./permissions.ts";
import { Org } from "./tenant-db.ts";

/**
 * Platform support: standing, read-only access to any organisation.
 *
 * The shape of this was a decision, not an accident. Standing access with no customer
 * approval gate, because support that has to wait for permission is not support. Read
 * only, because nobody outside a company should be able to change that company's records.
 * And **every view recorded**, server-side, because access nobody can review is not
 * access anyone can trust — including the person exercising it, who is better off with a
 * record of what they did than with an accusation they cannot answer.
 *
 * Read-only is a property of this surface, not a flag someone remembered to check: the
 * pages under `/support` render markup with no forms and import no Server Action, so
 * there is no write path to guard. A shared "read-only" flag would not have worked
 * anyway — one process serves many requests at once, and the flag would leak between
 * them. `can()` also denies a support account everything inside a tenant, so a session
 * that somehow reached an ordinary page still sees nothing.
 *
 * The audit log is deliberately not surfaced in the customer UI. It exists so this
 * access can be reviewed internally, which is what was agreed.
 */
export type SupportUser = SessionUser & { role: "support" };

export function isSupport(user: SessionUser | null | undefined): user is SupportUser {
  return user?.role === ROLES.SUPPORT && user.active === 1;
}

export type TenantSummary = {
  id: number;
  name: string;
  slug: string;
  status: string;
  created_at: string;
  users: number;
  carriers: number;
  last_activity: string | null;
};

/** Every organisation on this deployment. The only genuinely global list in the product. */
export function listTenants(): TenantSummary[] {
  return systemQuery(() =>
    all<TenantSummary>(
      `SELECT o.id, o.name, o.slug, o.status, o.created_at,
              (SELECT COUNT(*) FROM users u    WHERE u.organization_id = o.id AND u.active = 1) AS users,
              (SELECT COUNT(*) FROM carriers c WHERE c.organization_id = o.id)                  AS carriers,
              (SELECT MAX(a.created_at) FROM carrier_activity a WHERE a.organization_id = o.id) AS last_activity
         FROM organizations o
        ORDER BY o.name`,
    ),
  );
}

export function tenant(orgId: number): TenantSummary | undefined {
  return listTenants().find((t) => t.id === orgId);
}

/**
 * Records one view, before the data is shown. Called by every page under `/support`, so
 * the log is written whether or not the render that follows succeeds — a failed page is
 * still a look at somebody's data.
 */
export function recordAccess(userId: number, orgId: number, path: string): void {
  systemQuery(() =>
    run(
      "INSERT INTO support_access_log (user_id, organization_id, path, created_at) VALUES (?, ?, ?, ?)",
      [userId, orgId, path.slice(0, 400), new Date().toISOString()],
    ),
  );
}

export type AccessEntry = {
  id: number;
  created_at: string;
  path: string;
  user_name: string;
  organization_name: string;
};

/** The internal record. Shown to platform staff under `/support`, never to a customer. */
export function recentAccess(limit = 100): AccessEntry[] {
  return systemQuery(() =>
    all<AccessEntry>(
      `SELECT l.id, l.created_at, l.path, u.name AS user_name, o.name AS organization_name
         FROM support_access_log l
         JOIN users u         ON u.id = l.user_id
         JOIN organizations o ON o.id = l.organization_id
        ORDER BY l.created_at DESC
        LIMIT ?`,
      [limit],
    ),
  );
}

/** An `Org` for a tenant the support user is looking at. Named for what it is, so a
 *  reader of any query site can tell borrowed authority from the session's own. */
export function tenantHandle(orgId: number): Org {
  return new Org(orgId);
}

/** Whether this organisation exists at all — checked before anything is logged or read. */
export function tenantExists(orgId: number): boolean {
  return Boolean(
    systemQuery(() => get("SELECT 1 FROM organizations WHERE id = ?", [orgId])),
  );
}
