/**
 * Writes everything one organisation owns to a JSON file.
 *
 *   npm run export-org -- <slug-or-id> [outfile]
 *
 * For "send us our data", for keeping a record before a deletion, and for reading what a
 * tenant actually contains without opening the database by hand.
 *
 * Password hashes and two-factor secrets are excluded — this is an archive and a
 * data-subject deliverable, not a restore image.
 */
import { writeFileSync } from "node:fs";

const [ref, outfile] = process.argv.slice(2);
if (!ref) {
  console.error("Usage: npm run export-org -- <slug-or-id> [outfile]");
  process.exit(1);
}

const { exportOrganization, organizationByRef } = await import("../src/lib/tenant-lifecycle.ts");

const org = organizationByRef(ref);
if (!org) {
  console.error(`No organisation matches "${ref}". Try its slug or its numeric id.`);
  process.exit(1);
}

const bundle = exportOrganization(org.id);
const target = outfile ?? `${org.slug}-${new Date().toISOString().slice(0, 10)}.json`;
writeFileSync(target, JSON.stringify(bundle, null, 2));

console.log(`Exported ${org.name} (${org.slug}, id ${org.id}) → ${target}`);
for (const [table, n] of Object.entries(bundle.counts)) {
  if (n > 0) console.log(`  ${table.padEnd(20)} ${n}`);
}
console.log(`\n${bundle.note}`);
