/**
 * Removes an organisation and everything it owns. There is no undo.
 *
 *   npm run delete-org -- <slug-or-id>                  # shows what would go, deletes nothing
 *   npm run delete-org -- <slug-or-id> --confirm <slug> # does it
 *
 * Out of band, like `support-user.ts`: `/support` is read-only by construction and does
 * not get an exception for the most destructive operation in the product.
 *
 * An export is written first, always, and its path is printed. `audit_log` and
 * `support_access_log` rows for this organisation go with it, and that file is where the
 * record survives — so the export is a precondition, not a courtesy.
 */
import { writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const ref = args[0];
const confirm = args.includes("--confirm") ? args[args.indexOf("--confirm") + 1] : undefined;

if (!ref) {
  console.error("Usage: npm run delete-org -- <slug-or-id> [--confirm <slug>]");
  process.exit(1);
}

const { deleteOrganization, deletionPlan, exportOrganization, organizationByRef } = await import(
  "../src/lib/tenant-lifecycle.ts"
);

const org = organizationByRef(ref);
if (!org) {
  console.error(`No organisation matches "${ref}". Try its slug or its numeric id.`);
  process.exit(1);
}

console.log(`\n${org.name}  (slug: ${org.slug}, id: ${org.id})\n`);
const plan = deletionPlan(org.id);
for (const { table, rows } of plan) console.log(`  ${table.padEnd(20)} ${rows}`);
console.log(`  ${"organizations".padEnd(20)} 1`);

if (confirm !== org.slug) {
  console.log(
    `\nNothing was deleted. To go ahead, repeat the slug back:\n` +
      `  npm run delete-org -- ${ref} --confirm ${org.slug}\n`,
  );
  process.exit(0);
}

// Always, and before anything is removed.
const target = `${org.slug}-final-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
writeFileSync(target, JSON.stringify(exportOrganization(org.id), null, 2));
console.log(`\nExported first → ${target}`);

const removed = deleteOrganization(org.id, { exported: true });
console.log(`\nDeleted ${org.name}:`);
for (const [table, n] of Object.entries(removed)) {
  if (n > 0) console.log(`  ${table.padEnd(20)} ${n}`);
}
console.log(
  "\nRows in child tables removed by cascade (carrier notes, activity, offboarding, " +
    "sessions, reset and verification tokens, recovery codes) are not counted above.",
);
