/**
 * Shared test fixtures for the multi-tenant era.
 *
 * `orgHandle(orgId)` returns an `Org` instance the query functions accept. `seedOrg`
 * creates an organisation with its own vocabularies and an owner by calling the very
 * same `seedOrganizationData()` the product uses, so a fixture and a real tenant can
 * never be set up differently.
 */
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { LOOKUPS, DEFAULT_SETTINGS, ROLES, SEED_BROKERS, SEED_CHANNELS } from "../src/lib/constants.ts";

/**
 * Refuses to seed anything into a database that is not a throwaway.
 *
 * `db.ts` binds CARRIER_DB_PATH when it is first imported, so a test file that imports a
 * module from `src/lib` at the top — before setting the variable — silently writes to
 * `data/carrier-hub.db` instead. That has happened, and it is invisible: the tests still
 * pass, and the developer's database quietly fills with fixtures. Failing loudly here is
 * the difference between a mistake and a mess.
 */
function assertThrowawayDatabase(db: Db): void {
  // The **open file**, not the environment variable. Checking the variable is what let
  // this happen twice: a static import that reaches db.ts binds CARRIER_DB_PATH at import
  // time, so the variable can be set correctly to a temp path while the connection is
  // already pinned to data/carrier-hub.db. The variable said the right thing; the database
  // being written to was the developer's. Only the connection knows the truth.
  const open = (db.all("PRAGMA database_list") as { name: string; file: string }[])
    .find((d) => d.name === "main")?.file ?? "";
  // Resolved on both sides: on macOS /var is a symlink to /private/var, so SQLite reports
  // the real path while os.tmpdir() reports the link, and a plain prefix test fails on a
  // database that is in fact exactly where it should be.
  const temp = realpathSync(tmpdir());
  if (!open || !realpathSync.native(open).startsWith(temp)) {
    throw new Error(
      `Tests are connected to "${open}", not a throwaway database in ${tmpdir()}.\n` +
        "Something imported src/lib (directly, or through another module) before " +
        "CARRIER_DB_PATH was set. Import src/lib modules inside before(), never at the " +
        "top of a test file or of tests/helpers.ts.",
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
  assertThrowawayDatabase(db);
  const now = new Date().toISOString();
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Math.random().toString(36).slice(2, 7)}`;
  db.run("INSERT INTO organizations (name, slug, status, created_at) VALUES (?, ?, 'active', ?)", [name, slug, now]);
  const id = db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;

  // Seeded from the same constants provision.ts uses, rather than by calling it: importing
  // provision.ts here reaches db.ts at module load and pins the connection before a test
  // can set CARRIER_DB_PATH. `tests/dispatch-schema.test.ts` asserts the broker count, so
  // drift between this and provisioning fails a test rather than passing silently.
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
  for (const broker of SEED_BROKERS) {
    db.run(
      "INSERT INTO brokers (organization_id, name, seeded, active, created_at) VALUES (?, ?, 1, 1, ?)",
      [id, broker, now],
    );
  }
  for (const channel of SEED_CHANNELS) {
    db.run(
      `INSERT INTO channels (organization_id, name, description, audience, seeded, archived, created_at)
       VALUES (?, ?, ?, ?, 1, 0, ?)`,
      [id, channel.name, channel.description, channel.audience, now],
    );
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
