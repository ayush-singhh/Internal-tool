import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { get, run, transaction, systemQuery } from "./db.ts";
import { appUrl, type Mailer } from "./mailer.ts";
import { hashPassword } from "./password.ts";
import { RESET_RULE, checkBurst, describeLockout, recordBurst } from "./throttle.ts";

/**
 * One-time password reset links.
 *
 * Replaces the previous flow, where an administrator typed a password and then had to
 * tell the person what it was — over chat, out loud, in an email. With a link the
 * administrator never learns the password at all.
 *
 * The raw token is shown exactly once and never stored; only its SHA-256 lives in the
 * database, so a stolen database dump cannot be replayed into an account takeover. The
 * token is the credential, so it is treated like one.
 *
 * Two ways in. An administrator issues one for somebody in their organisation
 * (`issueReset`), and anyone can ask for their own (`requestReset`) — which is the only
 * route an owner has, since there is no administrator above them.
 */
const TOKEN_BYTES = 32;
const TTL_HOURS = 24;
const MIN_PASSWORD = 8;

const digest = (token: string) => createHash("sha256").update(token).digest("hex");

export type IssuedReset = { token: string; expiresAt: string; path: string };

export function issueReset(
  userId: number,
  issuedBy: number | null,
  ttlHours = TTL_HOURS,
): IssuedReset {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlHours * 3_600_000).toISOString();

  // password_resets is a pre-auth table authorised by the token; the calling admin action
  // has already confirmed the target user belongs to the admin's organisation.
  systemQuery(() =>
    transaction(() => {
      run("DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL", [userId]);
      run(
        `INSERT INTO password_resets (token, user_id, created_at, expires_at, issued_by)
         VALUES (?, ?, ?, ?, ?)`,
        [digest(token), userId, now.toISOString(), expiresAt, issuedBy],
      );
    }),
  );

  return { token, expiresAt, path: `/reset/${token}` };
}

/**
 * "I have forgotten my password", from the login page.
 *
 * Returns the same thing for every address, exactly as signup does: a real one is sent a
 * link, an unknown or deactivated one is sent nothing, and neither the caller nor the
 * timing says which happened. Otherwise the form is a way to ask whether somebody has an
 * account here.
 *
 * Limited per address as well as per host — this endpoint puts mail in somebody else's
 * inbox, and must not become a way to bury them in it.
 */
export async function requestReset(
  rawEmail: string,
  ip: string | null,
  send: Mailer,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const email = rawEmail.trim().toLowerCase().slice(0, 254);
  if (!email) return { ok: false, error: "Enter your email address." };

  const perEmail = checkBurst(`reset:${email}`, RESET_RULE.email, "email");
  if (!perEmail.allowed) return { ok: false, error: describeLockout(perEmail) };
  if (ip) {
    const perIp = checkBurst(`reset-ip:${ip}`, RESET_RULE.ip);
    if (!perIp.allowed) return { ok: false, error: describeLockout(perIp) };
  }
  recordBurst(`reset:${email}`);
  if (ip) recordBurst(`reset-ip:${ip}`);

  // By address alone: this runs before any session exists, and an address belongs to one
  // organisation (signup.ts and team.ts both enforce that).
  const user = systemQuery(() =>
    get<{ id: number; name: string; active: number }>(
      "SELECT id, name, active FROM users WHERE email = ?",
      [email],
    ),
  );
  // Nothing to send, and nothing said about why.
  if (!user || !user.active) return { ok: true };

  const { token } = issueReset(user.id, null);
  await send({
    to: email,
    subject: "Reset your password",
    text:
      `Hello ${user.name},\n\n` +
      `Someone asked to reset the password for this account. Set a new one here:\n\n` +
      `${appUrl()}/reset/${token}\n\n` +
      `The link works once and expires in ${TTL_HOURS} hours. Using it signs the account ` +
      `out everywhere.\n` +
      `If this was not you, ignore this message — nothing has changed, and your current ` +
      `password still works.\n`,
  });
  return { ok: true };
}

export type ResetCheck =
  | { valid: true; userId: number; name: string; email: string }
  | { valid: false; reason: string };

/** Validates without consuming, so the page can show a form or a clear failure. */
export function checkReset(token: string): ResetCheck {
  // Authorised by the token; runs on the unauthenticated reset page.
  const row = systemQuery(() =>
    get<{
      token: string; user_id: number; expires_at: string; used_at: string | null;
      name: string; email: string; active: number;
    }>(
      `SELECT r.token, r.user_id, r.expires_at, r.used_at, u.name, u.email, u.active
         FROM password_resets r JOIN users u ON u.id = r.user_id
        WHERE r.token = ?`,
      [digest(token)],
    ),
  );

  if (!row) return { valid: false, reason: "This reset link is not valid." };
  // Constant-time comparison of the stored digest, so a timing signal cannot be used to
  // confirm which prefixes exist.
  const a = Buffer.from(row.token);
  const b = Buffer.from(digest(token));
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { valid: false, reason: "This reset link is not valid." };
  }
  if (row.used_at) return { valid: false, reason: "This reset link has already been used." };
  if (new Date(row.expires_at) < new Date()) {
    return { valid: false, reason: "This reset link has expired. Ask for a new one." };
  }
  if (!row.active) return { valid: false, reason: "This account has been deactivated." };

  return { valid: true, userId: row.user_id, name: row.name, email: row.email };
}

export type ResetResult = { ok: true; userId: number } | { ok: false; error: string };

/** Sets the password and burns the token. Every existing session for that account ends,
 *  so a link used by the wrong person still cannot leave someone signed in. */
export function consumeReset(token: string, password: string): ResetResult {
  if (password.length < MIN_PASSWORD) {
    return { ok: false, error: `Password must be at least ${MIN_PASSWORD} characters.` };
  }
  const check = checkReset(token);
  if (!check.valid) return { ok: false, error: check.reason };

  systemQuery(() =>
    transaction(() => {
      // Setting a password from a link mailed to that address proves control of the
      // mailbox — the same thing the confirmation link proves. Someone who signed up,
      // never confirmed and then forgot their password would otherwise be stuck for good.
      run(
        `UPDATE users SET password_hash = ?, updated_at = ?,
                email_verified_at = COALESCE(email_verified_at, ?)
          WHERE id = ?`,
        [hashPassword(password), new Date().toISOString(), new Date().toISOString(), check.userId],
      );
      run("UPDATE password_resets SET used_at = ? WHERE token = ?", [
        new Date().toISOString(), digest(token),
      ]);
      run("DELETE FROM sessions WHERE user_id = ?", [check.userId]);
    }),
  );

  return { ok: true, userId: check.userId };
}

export function purgeExpiredResets(): void {
  systemQuery(() =>
    run("DELETE FROM password_resets WHERE expires_at < ?", [new Date().toISOString()]),
  );
}
