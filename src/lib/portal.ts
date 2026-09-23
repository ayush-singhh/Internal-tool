import "server-only";
import { get, systemQuery } from "./db.ts";
import { Org } from "./tenant-db.ts";

/**
 * Resolving a public portal URL to the organisation behind it.
 *
 * `/apply/<slug>` is the carrier's front door, and `organizations.slug` is already unique,
 * so it needs no column of its own.
 */
export type Portal = { org: Org; orgName: string; slug: string };

/**
 * The organisation whose portal this is, or null.
 *
 * Null covers three different situations on purpose: there is no such organisation, the
 * organisation is not active, and its owner has not opened the portal. The route turns all
 * three into the same 404, so the URL cannot be used to find out which companies are
 * customers here.
 *
 * The organisation id is derived server-side from the slug and never read from a request
 * body — the same position `/support/[orgId]` is in.
 */
export function portalFor(slug: string): Portal | null {
  const row = systemQuery(() =>
    get<{ id: number; name: string; status: string }>(
      "SELECT id, name, status FROM organizations WHERE slug = ?",
      [slug],
    ),
  );
  if (!row || row.status !== "active") return null;

  const org = new Org(row.id);
  const setting = get<{ value: string }>(
    "SELECT value FROM app_settings WHERE organization_id = ? AND key = 'portal_open'",
    [org.id],
  );
  // A missing row means closed. Every organisation that predates this setting therefore
  // has no public portal until somebody turns one on.
  if (setting?.value !== "1") return null;

  return { org, orgName: row.name, slug };
}
