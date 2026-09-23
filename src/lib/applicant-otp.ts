import "server-only";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { get, run, systemQuery, transaction } from "./db.ts";

/**
 * The one-time codes that prove an applicant holds the phone number it typed.
 *
 * This is the only credential in the portal, and it is weak by construction — six digits,
 * which is a one-in-a-million guess per attempt. Three things carry the weight:
 *
 *   1. **Five attempts, then the code is burnt.** Not the request: the code. Guessing
 *      cannot be resumed by getting lucky later.
 *   2. **Ten minutes.** A code read off a lock screen an hour later is already dead.
 *   3. **One live code per number.** Asking for a new one retires the old, so a thread of
 *      old messages is not a set of keys.
 *
 * Rate limiting on *sending* lives at the call site, on `throttle.ts`'s burst limiter —
 * it is the same mechanism the login page uses and there is no reason for a second one.
 *
 * Stored as SHA-256 and compared with `timingSafeEqual`, exactly as `reset.ts` treats its
 * token. The code itself exists only in the SMS.
 *
 * `systemQuery` throughout: these rows are reached from a cookie before any organisation
 * is established, the same position `sessions` is in.
 */

const TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;

const digest = (code: string) => createHash("sha256").update(code).digest("hex");

export type OtpFailure = "no_code" | "incorrect";
export type VerifyResult = { ok: true } | { ok: false; reason: OtpFailure };

/**
 * Issues a code, retiring any outstanding one for this number.
 *
 * Returns the code in the clear — it is never readable again, and the only correct thing
 * to do with it is hand it to `sender()`. Never log it.
 */
export function issueCode(orgId: number, phoneDigits: string, now = new Date()): string {
  // randomInt, not Math.random: this is a credential.
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const iso = now.toISOString();
  const expiresAt = new Date(now.getTime() + TTL_MINUTES * 60_000).toISOString();

  systemQuery(() =>
    transaction(() => {
      // Retiring the previous one is what makes "one live code per number" true, and it
      // has to happen in the same transaction as the insert or a fast double-tap leaves
      // two live codes.
      run(
        `UPDATE applicant_otps SET consumed_at = ?
          WHERE organization_id = ? AND phone_digits = ? AND consumed_at IS NULL`,
        [iso, orgId, phoneDigits],
      );
      run(
        `INSERT INTO applicant_otps
           (organization_id, phone_digits, code_hash, expires_at, attempts, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
        [orgId, phoneDigits, digest(code), expiresAt, iso],
      );
    }),
  );

  return code;
}

/** Constant-time, and length-guarded because `timingSafeEqual` throws on a mismatch. */
function sameDigest(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyCode(
  orgId: number,
  phoneDigits: string,
  code: string,
  now = new Date(),
): VerifyResult {
  const iso = now.toISOString();

  return systemQuery(() =>
    transaction(() => {
      const row = get<{ id: number; code_hash: string; attempts: number }>(
        `SELECT id, code_hash, attempts FROM applicant_otps
          WHERE organization_id = ? AND phone_digits = ?
            AND consumed_at IS NULL AND expires_at > ?
          ORDER BY id DESC LIMIT 1`,
        [orgId, phoneDigits, iso],
      );

      // Expired, already used, burnt, or never issued all arrive here and are told the
      // same thing. Distinguishing them would say whether a number has an application
      // in progress.
      if (!row) return { ok: false, reason: "no_code" } as const;

      if (!sameDigest(row.code_hash, digest(code))) {
        const attempts = row.attempts + 1;
        run(
          // Burning on the last attempt rather than merely counting it: the code has to
          // stop working, not just this request.
          attempts >= MAX_ATTEMPTS
            ? "UPDATE applicant_otps SET attempts = ?, consumed_at = ? WHERE id = ?"
            : "UPDATE applicant_otps SET attempts = ?, consumed_at = NULL WHERE id = ?",
          attempts >= MAX_ATTEMPTS ? [attempts, iso, row.id] : [attempts, row.id],
        );
        return { ok: false, reason: "incorrect" } as const;
      }

      run("UPDATE applicant_otps SET consumed_at = ? WHERE id = ?", [iso, row.id]);
      return { ok: true } as const;
    }),
  );
}
