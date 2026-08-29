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
const [orgRef, status] = process.argv.slice(2);
if (!orgRef || !status) {
  console.error(
    "Usage: node --conditions=react-server scripts/set-billing-status.ts <org-slug-or-id> <status>",
  );
  process.exit(1);
}

const { get, run, systemQuery } = await import("../src/lib/db.ts");
const { ORG_STATUS } = await import("../src/lib/constants.ts");

const allowed = new Set<string>(Object.values(ORG_STATUS));
if (!allowed.has(status)) {
  console.error(`Unknown status "${status}". Use one of: ${[...allowed].join(", ")}`);
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

systemQuery(() => run("UPDATE organizations SET status = ? WHERE id = ?", [status, org.id]));
console.log(`${org.name}: ${org.status} -> ${status}`);
