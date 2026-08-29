import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { get, run, systemQuery, transaction } from "./db.ts";
import { appUrl, type Mailer } from "./mailer.ts";
import { hashPassword } from "./password.ts";
import { createOrganization } from "./provision.ts";
import { SIGNUP_RULE, checkBurst, describeLockout, recordBurst } from "./throttle.ts";
import { email as validEmail, str, type FieldErrors } from "./validate.ts";

/**
 * Self-serve signup: an organisation, its owner, and a link that proves the owner reads
 * the address they typed.
 *
 * The single rule shaping this file is that **the answer is the same whatever the address
 * turns out to be**. A new address creates an organisation; an unconfirmed one gets its
 * link sent again; a confirmed one gets nothing at all — and all three return the same
 * result, so the form cannot be used to ask whether a company is a customer. That also
 * makes "resend my link" free: signing up again is the resend.
 *
 * Sending is passed in rather than imported, so a test can read the mail that was built.
 */
const MIN_PASSWORD = 8;
const TOKEN_BYTES = 32;
const TTL_HOURS = 24;

const digest = (token: string) => createHash("sha256").update(token).digest("hex");

/** Off unless a deployment turns it on: a self-hosted install must not let strangers
 *  create organisations on someone else's server. */
export function signupOpen(): boolean {
  return process.env.SIGNUP_OPEN === "1";
}

export type SignupFields = {
  orgName: FormDataEntryValue | null;
  ownerName: FormDataEntryValue | null;
  email: FormDataEntryValue | null;
  password: FormDataEntryValue | null;
  confirm: FormDataEntryValue | null;
};

export type SignupResult = { ok: true } | { ok: false; errors: FieldErrors };

export async function startSignup(
  fields: SignupFields,
  ip: string | null,
  send: Mailer,
): Promise<SignupResult> {
  if (!signupOpen()) return { ok: false, errors: { form: "Signup is not open on this server." } };

  const errors: FieldErrors = {};
  const orgName = str(fields.orgName, 120);
  const ownerName = str(fields.ownerName, 120);
  const address = validEmail(fields.email, "email", errors);
  const password = fields.password == null ? "" : String(fields.password);

  if (!orgName) errors.orgName = "Enter your company name.";
  if (!ownerName) errors.ownerName = "Enter your name.";
  if (!address && !errors.email) errors.email = "Enter your work email address.";
  if (password.length < MIN_PASSWORD) {
    errors.password = `Password must be at least ${MIN_PASSWORD} characters.`;
  }
  if (password !== String(fields.confirm ?? "")) errors.confirm = "The passwords do not match.";
  if (Object.keys(errors).length > 0) return { ok: false, errors };

  const verdict = ip ? checkBurst(`signup:${ip}`, SIGNUP_RULE) : { allowed: true as const };
  if (!verdict.allowed) return { ok: false, errors: { form: describeLockout(verdict) } };
  if (ip) recordBurst(`signup:${ip}`);

  // Looked up across every organisation: signing in finds an account by email alone, so
  // the same address in two tenants would leave one of them unable to sign in at all.
  const existing = systemQuery(() =>
    get<{ id: number; name: string; email_verified_at: string | null }>(
      "SELECT id, name, email_verified_at FROM users WHERE email = ?",
      [address!],
    ),
  );

  if (existing?.email_verified_at) return { ok: true }; // already a customer: say nothing

  const user = existing
    ? existing
    : {
        id: createOrganization({
          orgName: orgName!,
          ownerName: ownerName!,
          ownerEmail: address!,
          passwordHash: hashPassword(password),
          emailVerified: false,
        }).ownerId,
        name: ownerName!,
      };

  const token = issueVerification(user.id);
  await send({
    to: address!,
    subject: "Confirm your email address",
    text:
      `Hello ${user.name},\n\n` +
      `Confirm this address to finish setting up Carrier Hub:\n\n` +
      `${appUrl()}/verify/${token}\n\n` +
      `The link works once and expires in ${TTL_HOURS} hours.\n` +
      `If you did not sign up, ignore this message — nothing has been created in your name.\n`,
  });
  return { ok: true };
}

/** A fresh link replaces any earlier unused one, so only the newest mail works. */
function issueVerification(userId: number): string {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const now = new Date();
  systemQuery(() =>
    transaction(() => {
      run("DELETE FROM email_verifications WHERE user_id = ? AND used_at IS NULL", [userId]);
      run(
        "INSERT INTO email_verifications (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
        [
          digest(token),
          userId,
          now.toISOString(),
          new Date(now.getTime() + TTL_HOURS * 3_600_000).toISOString(),
        ],
      );
    }),
  );
  return token;
}

export type VerifyResult = { ok: true; email: string } | { ok: false; reason: string };

/** Consumes the link. Runs unauthenticated — the token is the only credential. */
export function verifyEmail(token: string): VerifyResult {
  const row = systemQuery(() =>
    get<{
      token: string; user_id: number; expires_at: string; used_at: string | null;
      email: string; email_verified_at: string | null;
    }>(
      `SELECT v.token, v.user_id, v.expires_at, v.used_at, u.email, u.email_verified_at
         FROM email_verifications v JOIN users u ON u.id = v.user_id
        WHERE v.token = ?`,
      [digest(token)],
    ),
  );
  if (!row) return { ok: false, reason: "This confirmation link is not valid." };

  // Constant-time, so a timing signal cannot be used to confirm which prefixes exist.
  const a = Buffer.from(row.token);
  const b = Buffer.from(digest(token));
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "This confirmation link is not valid." };
  }
  if (row.email_verified_at) return { ok: true, email: row.email }; // a second click is fine
  if (row.used_at) return { ok: false, reason: "This confirmation link has already been used." };
  if (new Date(row.expires_at) < new Date()) {
    return { ok: false, reason: "This confirmation link has expired. Sign up again to get a new one." };
  }

  const now = new Date().toISOString();
  systemQuery(() =>
    transaction(() => {
      run("UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?", [now, now, row.user_id]);
      run("UPDATE email_verifications SET used_at = ? WHERE token = ?", [now, digest(token)]);
    }),
  );
  return { ok: true, email: row.email };
}
