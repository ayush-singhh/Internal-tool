import "server-only";
import { AUDIT, record } from "./audit.ts";
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
  if (!verdict.allowed) {
    auditFor(email, AUDIT.SIGNIN_BLOCKED, ip);
    return { ok: false, error: describeLockout(verdict) };
  }

  const user = systemQuery(() =>
    get<{
      id: number; organization_id: number; password_hash: string; active: number;
      mfa_activated_at: string | null; email_verified_at: string | null;
    }>(
      `SELECT id, organization_id, password_hash, active, mfa_activated_at, email_verified_at
         FROM users WHERE email = ?`,
      [email.trim().toLowerCase()],
    ),
  );

  // Same message either way — don't reveal which addresses exist.
  if (!user || !verifyPassword(password, user.password_hash)) {
    recordAttempt(email, ip, false);
    // Recorded against the organisation only when the address belongs to one. An address
    // nobody has is nobody's to audit; `login_attempts` still counts it for the lockout.
    if (user) {
      record({ organizationId: user.organization_id, userId: user.id,
        actor: email, action: AUDIT.SIGNIN_FAILED, subject: email, detail: "Wrong password", ip });
    }
    return { ok: false, error: "Incorrect email or password." };
  }
  if (!user.active) {
    recordAttempt(email, ip, false);
    record({ organizationId: user.organization_id, userId: user.id,
      actor: email, action: AUDIT.SIGNIN_FAILED, subject: email, detail: "Account is deactivated", ip });
    return { ok: false, error: "This account has been deactivated." };
  }
  recordAttempt(email, ip, true);

  // Only self-signup leaves this unset. The password was right, so this is counted as a
  // success — waiting for an email must not lock the account that is waiting.
  if (user.email_verified_at === null) {
    return {
      ok: false,
      error: "Confirm your email address first — we sent you a link when you signed up.",
    };
  }

  // Retire a pre-argon2 hash now, while the plaintext is in hand. A sign-in is the only
  // moment an old hash can be upgraded, and it happens exactly once per account.
  if (needsRehash(user.password_hash)) {
    systemQuery(() =>
      run("UPDATE users SET password_hash = ? WHERE id = ?", [hashPassword(password), user.id]),
    );
  }

  // A password on an account with a second factor is not a sign-in yet, so it is not
  // recorded as one — secondFactorStep does that when the code is accepted.
  if (user.mfa_activated_at === null) {
    record({ organizationId: user.organization_id, userId: user.id,
      actor: email, action: AUDIT.SIGNIN_SUCCESS, subject: email, ip });
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
    auditFor(email, AUDIT.SIGNIN_FAILED, ip, "Wrong two-factor code");
    return { ok: false, error: "That code is not right. Check the app and try again." };
  }
  recordAttempt(email, ip, true);
  auditFor(email, AUDIT.SIGNIN_SUCCESS, ip, "With a second factor");
  return { ok: true };
}

/** Records an event against whichever organisation owns this address, if any. Sign-in
 *  runs before a session exists, so the organisation has to be looked up rather than
 *  carried in. */
function auditFor(email: string, action: typeof AUDIT[keyof typeof AUDIT], ip: string | null, detail?: string): void {
  const user = systemQuery(() =>
    get<{ id: number; organization_id: number }>(
      "SELECT id, organization_id FROM users WHERE email = ?",
      [email.trim().toLowerCase()],
    ),
  );
  if (!user) return;
  record({ organizationId: user.organization_id, userId: user.id, actor: email, action, subject: email, detail, ip });
}
