/**
 * Shared test fixtures for the multi-tenant era.
 *
 * `orgHandle(orgId)` returns an `Org` instance the query functions accept. `seedOrg`
 * creates an organisation with its own vocabularies and an owner, mirroring what
 * provision.ts does in the app, so tests exercise the same tenant setup the product uses.
 */
import { LOOKUPS, DEFAULT_SETTINGS, ROLES } from "../src/lib/constants.ts";

type Db = typeof import("../src/lib/db.ts");

export type TestOrg = { id: number; ownerId: number };

/** Creates an organisation with seeded lookups/settings and one owner. Returns ids. */
export function seedOrg(
  db: Db,
  name: string,
  ownerEmail = `owner-${name.toLowerCase().replace(/\W+/g, "")}@test.local`,
): TestOrg {
  const now = new Date().toISOString();
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Math.random().toString(36).slice(2, 7)}`;
  db.run("INSERT INTO organizations (name, slug, status, created_at) VALUES (?, ?, 'active', ?)", [name, slug, now]);
  const id = db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;

  LOOKUPS.forEach((l, i) =>
    db.run(
      `INSERT INTO lookups (organization_id, kind, value, label, tone, sort)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, l.kind, l.value, l.label, l.tone ?? null, i],
    ),
  );
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    db.run("INSERT INTO app_settings (organization_id, key, value) VALUES (?, ?, ?)", [id, key, value]);
  }
  db.run(
    `INSERT INTO users (organization_id, name, email, password_hash, role, active,
                        email_verified_at, created_at, updated_at)
     VALUES (?, 'Owner', ?, 'x', ?, 1, ?, ?, ?)`,
    // Confirmed, like every owner provision.ts makes: only self-signup leaves this unset.
    [id, ownerEmail, ROLES.OWNER, now, now, now],
  );
  const ownerId = db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
  return { id, ownerId };
}

/** The lookup id for a (kind, value) within one organisation. */
export function lookupId(db: Db, orgId: number, kind: string, value: string): number {
  return db.get<{ id: number }>(
    "SELECT id FROM lookups WHERE organization_id = ? AND kind = ? AND value = ?",
    [orgId, kind, value],
  )!.id;
}
