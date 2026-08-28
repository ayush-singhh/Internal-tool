import "server-only";
import { get, run, systemQuery } from "./db.ts";
import { verifySecondFactor } from "./mfa.ts";
import { hashPassword, needsRehash, verifyPassword } from "./password.ts";
import { checkLogin, describeLockout, recordAttempt } from "./throttle.ts";

/**
 * What signing in decides, with no request context attached.
 *
 * `auth.ts` owns cookies and session rows and needs `next/headers`, which puts it out of
 * reach of `node --test`. The rules that actually gate an account — the lock, the hash
 * check, the argon2 upgrade, and whether a second factor is still owed — live here so
 * they can be tested directly. This is the same split as `notes.ts` / `note-actions.ts`.
 *
 * Every query is a `systemQuery`: sign-in happens before any organisation is known.
 */
export type PasswordStep =
  | { ok: true; userId: number; mfaRequired: boolean }
  | { ok: false; error: string };

export function passwordStep(email: string, password: string, ip: string | null): PasswordStep {
  // Checked before any password work, so a locked account costs no hashing time either.
  const verdict = checkLogin(email, ip);
  if (!verdict.allowed) return { ok: false, error: describeLockout(verdict) };

  const user = systemQuery(() =>
    get<{ id: number; password_hash: string; active: number; mfa_activated_at: string | null }>(
      "SELECT id, password_hash, active, mfa_activated_at FROM users WHERE email = ?",
      [email.trim().toLowerCase()],
    ),
  );

  // Same message either way — don't reveal which addresses exist.
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordAttempt(email, ip, false);
    return { ok: false, error: "Incorrect email or password." };
  }
  if (!user.active) {
    recordAttempt(email, ip, false);
    return { ok: false, error: "This account has been deactivated." };
  }
  recordAttempt(email, ip, true);

  // Retire a pre-argon2 hash now, while the plaintext is in hand. A sign-in is the only
  // moment an old hash can be upgraded, and it happens exactly once per account.
  if (needsRehash(user.password_hash)) {
    systemQuery(() =>
      run("UPDATE users SET password_hash = ? WHERE id = ?", [hashPassword(password), user.id]),
    );
  }

  return { ok: true, userId: user.id, mfaRequired: user.mfa_activated_at !== null };
}

/**
 * The code step, on the same counters as the password step: guessing six digits is
 * bounded by the account lock, not by how fast codes can be posted.
 */
export function secondFactorStep(
  userId: number,
  email: string,
  code: string,
  ip: string | null,
): { ok: true } | { ok: false; error: string } {
  const verdict = checkLogin(email, ip);
  if (!verdict.allowed) return { ok: false, error: describeLockout(verdict) };

  if (!verifySecondFactor(userId, code)) {
    recordAttempt(email, ip, false);
    return { ok: false, error: "That code is not right. Check the app and try again." };
  }
  recordAttempt(email, ip, true);
  return { ok: true };
}
