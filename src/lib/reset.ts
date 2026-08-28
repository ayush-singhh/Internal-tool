import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { get, run, transaction, systemQuery } from "./db.ts";
import { hashPassword } from "./password.ts";

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
 */
const TOKEN_BYTES = 32;
const TTL_HOURS = 24;
const MIN_PASSWORD = 8;

const digest = (token: string) => createHash("sha256").update(token).digest("hex");

export type IssuedReset = { token: string; expiresAt: string; path: string };

export function issueReset(userId: number, issuedBy: number | null): IssuedReset {
  const token = randomBytes(TOKEN_BYTES).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + TTL_HOURS * 3_600_000).toISOString();

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
      run("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", [
        hashPassword(password), new Date().toISOString(), check.userId,
      ]);
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
