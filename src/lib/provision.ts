import "server-only";
import { get, run, transaction } from "./db.ts";
import { LOOKUPS, DEFAULT_SETTINGS, ROLES } from "./constants.ts";
import { slugify } from "./migrations.ts";

/**
 * Everything that must exist for a brand-new organisation: its own copy of the 80
 * controlled-vocabulary values and its own settings. Vocabularies are per-tenant so one
 * company retiring "Royal" or renaming a status never touches another company's dropdowns.
 *
 * This is the ONLY place an organisation is created, so tenant setup can never be
 * half-done: signup, the CLI, and the first-run seed all route through here.
 */
export function seedOrganizationData(orgId: number): void {
  const insertLookup = run;
  LOOKUPS.forEach((l, i) =>
    insertLookup(
      `INSERT INTO lookups (organization_id, kind, value, label, tone, sort)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (organization_id, kind, value)
       DO UPDATE SET label = excluded.label, tone = excluded.tone`,
      [orgId, l.kind, l.value, l.label, l.tone ?? null, i],
    ),
  );

  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    run(
      "INSERT OR IGNORE INTO app_settings (organization_id, key, value) VALUES (?, ?, ?)",
      [orgId, key, value],
    );
  }
}

export type NewOrg = { orgId: number; ownerId: number };

/**
 * Creates an organisation, its owner, and its seeded vocabularies in one transaction.
 * The owner's password is already hashed by the caller — this function never sees a
 * plaintext password and never logs one.
 */
export function createOrganization(input: {
  orgName: string;
  ownerName: string;
  ownerEmail: string;
  passwordHash: string;
}): NewOrg {
  return transaction(() => {
    const now = new Date().toISOString();
    const base = slugify(input.orgName);
    let slug = base;
    let n = 2;
    while (get("SELECT 1 FROM organizations WHERE slug = ?", [slug])) slug = `${base}-${n++}`;

    run(
      "INSERT INTO organizations (name, slug, status, created_at) VALUES (?, ?, 'active', ?)",
      [input.orgName, slug, now],
    );
    const orgId = get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;

    seedOrganizationData(orgId);

    run(
      `INSERT INTO users (organization_id, name, email, password_hash, role, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      [orgId, input.ownerName, input.ownerEmail.toLowerCase(), input.passwordHash, ROLES.OWNER, now, now],
    );
    const ownerId = get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;

    return { orgId, ownerId };
  });
}
