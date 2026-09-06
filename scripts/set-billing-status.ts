/**
 * Sets an organisation's billing standing by hand.
 *
 *   node --conditions=react-server scripts/set-billing-status.ts <org-slug-or-id> <status>
 *   status is one of: trial, active, past_due, suspended
 *   or a billing mode: comped (never charged) | stripe (billed through Stripe)
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
// `comped` and `stripe` are not statuses — they are the billing *mode*, the column that
// decides whether an organisation is billed at all. Both are billing standing, which is
// this script's stated job, so they live here rather than in a second script.
const MODES = new Set(["comped", "stripe"]);
if (!allowed.has(newStatus) && !MODES.has(newStatus)) {
  console.error(
    `Unknown value "${newStatus}". Use a status (${[...allowed].join(", ")}) ` +
      `or a billing mode (${[...MODES].join(", ")}).`,
  );
  process.exit(1);
}

const org = systemQuery(() =>
  get<{ id: number; name: string; status: string; billing_mode: string }>(
    /^\d+$/.test(orgRef)
      ? "SELECT id, name, status, billing_mode FROM organizations WHERE id = ?"
      : "SELECT id, name, status, billing_mode FROM organizations WHERE slug = ?",
    [/^\d+$/.test(orgRef) ? Number(orgRef) : orgRef],
  ),
);
if (!org) {
  console.error(`No organisation matches "${orgRef}".`);
  process.exit(1);
}

if (MODES.has(newStatus)) {
  systemQuery(() =>
    run("UPDATE organizations SET billing_mode = ? WHERE id = ?", [newStatus, org.id]));
  console.log(`${org.name}: billing mode ${org.billing_mode} -> ${newStatus}`);
} else {
  systemQuery(() => run("UPDATE organizations SET status = ? WHERE id = ?", [newStatus, org.id]));
  console.log(`${org.name}: ${org.status} -> ${newStatus}`);
}
