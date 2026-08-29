/**
 * Sets an organisation's billing standing by hand.
 *
 *   node --conditions=react-server scripts/set-billing-status.ts <org-slug-or-id> <status>
 *   status is one of: trial, active, past_due, suspended
 *
 * Out of band on purpose, same as scripts/support-user.ts: nothing in this application
 * charges anybody, invoicing is manual, and no code path a customer or a support account
 * can reach should be able to mark itself paid up. Whoever sends the invoice runs this.
 */
// No static import in this file (everything below is a dynamic await import()), so
// without this TS treats it as a script rather than a module: top-level await is
// refused, and a top-level `const status` collides with the ambient DOM global
// window.status — hence `export {}` here and `newStatus` below rather than `status`.
export {};

const [orgRef, newStatus] = process.argv.slice(2);
if (!orgRef || !newStatus) {
  console.error(
    "Usage: node --conditions=react-server scripts/set-billing-status.ts <org-slug-or-id> <status>",
  );
  process.exit(1);
}

const { get, run, systemQuery } = await import("../src/lib/db.ts");
const { ORG_STATUS } = await import("../src/lib/constants.ts");

const allowed = new Set<string>(Object.values(ORG_STATUS));
if (!allowed.has(newStatus)) {
  console.error(`Unknown status "${newStatus}". Use one of: ${[...allowed].join(", ")}`);
  process.exit(1);
}

const org = systemQuery(() =>
  get<{ id: number; name: string; status: string }>(
    /^\d+$/.test(orgRef)
      ? "SELECT id, name, status FROM organizations WHERE id = ?"
      : "SELECT id, name, status FROM organizations WHERE slug = ?",
    [/^\d+$/.test(orgRef) ? Number(orgRef) : orgRef],
  ),
);
if (!org) {
  console.error(`No organisation matches "${orgRef}".`);
  process.exit(1);
}

systemQuery(() => run("UPDATE organizations SET status = ? WHERE id = ?", [newStatus, org.id]));
console.log(`${org.name}: ${org.status} -> ${newStatus}`);
