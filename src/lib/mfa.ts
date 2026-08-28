import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { get, run, systemQuery, transaction } from "./db.ts";
import { base32, generateSecret, matchStep, otpauthUri, secretForDisplay } from "./totp.ts";

/**
 * Two-factor authentication: enrolment, the login check, and recovery codes.
 *
 * Every function here is keyed by user id and reads the `users` row through
 * `systemQuery`, for the same reason `reset.ts` does: the second factor is checked
 * *before* a session exists, so there is no organisation to scope by yet. A user id is
 * globally unique, and the caller either holds a session (settings) or has just passed
 * the password step (login) — nothing here is reachable with an id alone.
 *
 * Two rules make a stolen code worthless a second time, and both are enforced by the
 * WHERE clause of an UPDATE rather than by a read followed by a write, so two racing
 * requests cannot both win:
 *
 *   - a time step is accepted once (`mfa_last_step` only ever moves forward)
 *   - a recovery code is consumed once (`used_at IS NULL` is part of the update)
 */
const RECOVERY_CODE_COUNT = 10;
/** 80 bits per code — far past offline brute force, so SHA-256 storage is enough. */
const RECOVERY_CODE_BYTES = 10;
const ISSUER = "Carrier Hub";

type UserMfaRow = {
  email: string;
  mfa_secret: string | null;
  mfa_activated_at: string | null;
  mfa_last_step: number | null;
};

function readUser(userId: number): UserMfaRow | undefined {
  return systemQuery(() =>
    get<UserMfaRow>(
      "SELECT email, mfa_secret, mfa_activated_at, mfa_last_step FROM users WHERE id = ?",
      [userId],
    ),
  );
}

/** Recovery codes are read back with the separators stripped and case ignored — nobody
 *  should fail to get in because they typed the dashes. */
const normalize = (code: string) => code.replace(/[^0-9a-z]/gi, "").toUpperCase();
const digest = (code: string) => createHash("sha256").update(normalize(code)).digest("hex");
const grouped = (code: string) => code.replace(/(.{4})(?=.)/g, "$1-");

export type MfaState = {
  /** A second factor is required at sign-in. */
  active: boolean;
  /** A secret has been issued but not yet confirmed — sign-in is unaffected. */
  enrolling: boolean;
  activatedAt: string | null;
  /** Set only while enrolling: what the user scans and what they can type instead. */
  otpauth: string | null;
  secretText: string | null;
  recoveryRemaining: number;
};

export function mfaState(userId: number): MfaState {
  const row = readUser(userId);
  if (!row) return { active: false, enrolling: false, activatedAt: null, otpauth: null, secretText: null, recoveryRemaining: 0 };

  const active = row.mfa_activated_at !== null;
  const enrolling = !active && row.mfa_secret !== null;
  return {
    active,
    enrolling,
    activatedAt: row.mfa_activated_at,
    otpauth: enrolling ? otpauthUri(row.mfa_secret!, row.email, ISSUER) : null,
    secretText: enrolling ? secretForDisplay(row.mfa_secret!) : null,
    recoveryRemaining: active ? countRecovery(userId) : 0,
  };
}

function countRecovery(userId: number): number {
  return (
    get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL",
      [userId],
    )?.n ?? 0
  );
}

export type MfaResult = { ok: true } | { ok: false; error: string };

/** Issues a fresh secret to scan. Safe to call again — an abandoned enrolment is simply
 *  replaced, and a secret is worth nothing until it has been confirmed by a code. */
export function beginEnrollment(userId: number): MfaResult {
  const row = readUser(userId);
  if (!row) return { ok: false, error: "Account not found." };
  if (row.mfa_activated_at) {
    return { ok: false, error: "Two-factor authentication is already on for this account." };
  }
  systemQuery(() =>
    run("UPDATE users SET mfa_secret = ?, mfa_last_step = NULL WHERE id = ?", [
      generateSecret(),
      userId,
    ]),
  );
  return { ok: true };
}

export function cancelEnrollment(userId: number): MfaResult {
  const row = readUser(userId);
  if (!row) return { ok: false, error: "Account not found." };
  if (row.mfa_activated_at) return { ok: false, error: "Turn it off instead." };
  systemQuery(() => run("UPDATE users SET mfa_secret = NULL WHERE id = ?", [userId]));
  return { ok: true };
}

export type ActivationResult =
  | { ok: true; recoveryCodes: string[] }
  | { ok: false; error: string };

/**
 * Turns the second factor on, but only after a code proves the authenticator app really
 * holds the secret. Confirming before activating is the whole point: activating on the
 * strength of a scan that silently failed locks the account's owner out of it.
 */
export function activate(userId: number, submitted: string): ActivationResult {
  const row = readUser(userId);
  if (!row?.mfa_secret) return { ok: false, error: "Start the setup again." };
  if (row.mfa_activated_at) {
    return { ok: false, error: "Two-factor authentication is already on for this account." };
  }
  const step = matchStep(row.mfa_secret, submitted);
  if (step === null) return { ok: false, error: "That code is not right. Try the current one." };

  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    grouped(base32(randomBytes(RECOVERY_CODE_BYTES))),
  );
  const now = new Date().toISOString();

  systemQuery(() =>
    transaction(() => {
      run("UPDATE users SET mfa_activated_at = ?, mfa_last_step = ? WHERE id = ?", [now, step, userId]);
      run("DELETE FROM mfa_recovery_codes WHERE user_id = ?", [userId]);
      for (const code of codes) {
        run(
          "INSERT INTO mfa_recovery_codes (code_hash, user_id, created_at) VALUES (?, ?, ?)",
          [digest(code), userId, now],
        );
      }
    }),
  );
  return { ok: true, recoveryCodes: codes };
}

/** Turning it off needs a working second factor, so a borrowed session cannot quietly
 *  remove it and leave only the password behind. */
export function disable(userId: number, submitted: string): MfaResult {
  const row = readUser(userId);
  if (!row?.mfa_activated_at) return { ok: false, error: "It is already off." };
  if (!verifySecondFactor(userId, submitted)) {
    return { ok: false, error: "That code is not right." };
  }
  systemQuery(() =>
    transaction(() => {
      run(
        "UPDATE users SET mfa_secret = NULL, mfa_activated_at = NULL, mfa_last_step = NULL WHERE id = ?",
        [userId],
      );
      run("DELETE FROM mfa_recovery_codes WHERE user_id = ?", [userId]);
    }),
  );
  return { ok: true };
}

/**
 * The sign-in check: a current authenticator code, or one recovery code, once.
 * Callers throttle — this is reached only behind the login rate limit.
 */
export function verifySecondFactor(userId: number, submitted: string): boolean {
  const row = readUser(userId);
  if (!row?.mfa_secret || !row.mfa_activated_at) return false;

  const step = matchStep(row.mfa_secret, submitted);
  if (step !== null) {
    // Only accepted if the step is newer than the last one used, so a code observed in
    // flight cannot be replayed inside its own 30-second window.
    const result = systemQuery(() =>
      run(
        `UPDATE users SET mfa_last_step = ?
          WHERE id = ? AND (mfa_last_step IS NULL OR mfa_last_step < ?)`,
        [step, userId, step],
      ),
    );
    if (result.changes === 1) return true;
  }

  const consumed = run(
    "UPDATE mfa_recovery_codes SET used_at = ? WHERE code_hash = ? AND user_id = ? AND used_at IS NULL",
    [new Date().toISOString(), digest(submitted), userId],
  );
  return consumed.changes === 1;
}
