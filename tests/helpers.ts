/**
 * Shared test fixtures for the multi-tenant era.
 *
 * `orgHandle(orgId)` returns an `Org` instance the query functions accept. `seedOrg`
 * creates an organisation with its own vocabularies and an owner by calling the very
 * same `seedOrganizationData()` the product uses, so a fixture and a real tenant can
 * never be set up differently.
 */
import { tmpdir } from "node:os";
import { ROLES } from "../src/lib/constants.ts";
import { seedOrganizationData } from "../src/lib/provision.ts";

/**
 * Refuses to seed anything into a database that is not a throwaway.
 *
 * `db.ts` binds CARRIER_DB_PATH when it is first imported, so a test file that imports a
 * module from `src/lib` at the top — before setting the variable — silently writes to
 * `data/carrier-hub.db` instead. That has happened, and it is invisible: the tests still
 * pass, and the developer's database quietly fills with fixtures. Failing loudly here is
 * the difference between a mistake and a mess.
 */
function assertThrowawayDatabase(): void {
  const configured = process.env.CARRIER_DB_PATH;
  if (!configured || !configured.startsWith(tmpdir())) {
    throw new Error(
      `Tests must run against a database in ${tmpdir()}, not "${configured ?? "the default"}". ` +
        "Set CARRIER_DB_PATH and import src/lib modules inside before(), not at the top of the file.",
    );
  }
}

type Db = typeof import("../src/lib/db.ts");

export type TestOrg = { id: number; ownerId: number };

/** Creates an organisation with seeded lookups/settings and one owner. Returns ids. */
export function seedOrg(
  db: Db,
  name: string,
  ownerEmail = `owner-${name.toLowerCase().replace(/\W+/g, "")}@test.local`,
): TestOrg {
  assertThrowawayDatabase();
  const now = new Date().toISOString();
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Math.random().toString(36).slice(2, 7)}`;
  db.run("INSERT INTO organizations (name, slug, status, created_at) VALUES (?, ?, 'active', ?)", [name, slug, now]);
  const id = db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;

  // Calls the real thing rather than repeating it. This helper used to insert lookups and
  // settings itself, which meant every addition to provisioning silently failed to reach
  // the tests — brokers were seeded in the product and absent in every fixture. One
  // implementation, so it cannot drift again.
  seedOrganizationData(id);
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
