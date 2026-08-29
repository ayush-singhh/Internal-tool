/**
 * Creates a platform support account, or turns an existing one into one.
 *
 *   node --conditions=react-server scripts/support-user.ts you@yourcompany.com "Your Name"
 *
 * Out of band on purpose. The Team page cannot grant this role and neither can any
 * customer's administrator — it reaches across every organisation, so it is granted by
 * whoever has the server, not by anyone using the product.
 *
 * The account still has to enrol a second factor before /support opens, and every view it
 * makes of a customer's data is recorded in support_access_log.
 */
import { randomBytes } from "node:crypto";

const [email, name] = process.argv.slice(2);
if (!email || !name) {
  console.error('Usage: node --conditions=react-server scripts/support-user.ts <email> "<name>"');
  process.exit(1);
}

const { get, run, systemQuery, transaction } = await import("../src/lib/db.ts");
const { hashPassword } = await import("../src/lib/password.ts");
const { issueReset } = await import("../src/lib/reset.ts");
const { ROLES } = await import("../src/lib/constants.ts");

const address = email.trim().toLowerCase();
const now = new Date().toISOString();

const existing = systemQuery(() =>
  get<{ id: number; role: string }>("SELECT id, role FROM users WHERE email = ?", [address]),
);

let userId: number;
if (existing) {
  systemQuery(() =>
    run("UPDATE users SET role = ?, active = 1, updated_at = ? WHERE id = ?", [
      ROLES.SUPPORT, now, existing.id,
    ]),
  );
  userId = existing.id;
  console.log(`Promoted ${address} (was ${existing.role}) to platform support.`);
} else {
  // Support accounts belong to the first organisation on the deployment — the operator's
  // own. They hold no role inside it: `can()` denies a support account everything in
  // tenant space, so the organisation is only somewhere for the row to live.
  const orgId = systemQuery(() =>
    get<{ id: number }>("SELECT id FROM organizations ORDER BY id LIMIT 1"),
  )?.id;
  if (!orgId) {
    console.error("No organisation exists yet. Run `npm run migrate` first.");
    process.exit(1);
  }
  systemQuery(() =>
    transaction(() => {
      run(
        `INSERT INTO users (organization_id, name, email, password_hash, role, active,
                            email_verified_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        // A password nobody knows: the link below is the only way in, exactly as an
        // invitation works.
        [orgId, name, address, hashPassword(randomBytes(32).toString("base64url")),
         ROLES.SUPPORT, now, now, now],
      );
    }),
  );
  userId = systemQuery(() => get<{ id: number }>("SELECT last_insert_rowid() AS id"))!.id;
  console.log(`Created support account ${address}.`);
}

const { token } = issueReset(userId, null, 48);
console.log(`\nSet a password with this link (48 hours, works once):\n  ${
  (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "")
}/reset/${token}\n`);
console.log("Then enrol a second factor — /support stays shut until it is on.");
