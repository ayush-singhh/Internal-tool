import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { base32, codeAt, currentStep, matchStep } from "../src/lib/totp.ts";
import { seedOrg, type TestOrg } from "./helpers.ts";

const DB = path.join(tmpdir(), `carrier-hub-mfa-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let mfa: typeof import("../src/lib/mfa.ts");
let org: TestOrg;

before(async () => {
  db = await import("../src/lib/db.ts");
  mfa = await import("../src/lib/mfa.ts");
  org = seedOrg(db, "Mfa Co");
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

beforeEach(() => {
  db.run(
    "UPDATE users SET mfa_secret = NULL, mfa_activated_at = NULL, mfa_last_step = NULL WHERE organization_id = ?",
    [org.id],
  );
  db.run("DELETE FROM mfa_recovery_codes");
});

/** The secret the app issued, read back the way an authenticator app would hold it. */
function secretOf(userId: number): string {
  return db.get<{ mfa_secret: string }>(
    "SELECT mfa_secret FROM users WHERE organization_id = ? AND id = ?",
    [org.id, userId],
  )!.mfa_secret;
}

// ── the algorithm ────────────────────────────────────────────────────────────
// RFC 6238 appendix B, SHA-1 rows, truncated to the six digits this app uses.

test("TOTP matches the RFC 6238 test vectors", () => {
  const secret = Buffer.from("12345678901234567890", "ascii").toString("hex");
  const at = (unix: number) => codeAt(secret, Math.floor(unix / 30));
  assert.equal(at(59), "287082");
  assert.equal(at(1111111109), "081804");
  assert.equal(at(1234567890), "005924");
  assert.equal(at(2000000000), "279037");
});

test("base32 encodes the way authenticator apps read it", () => {
  assert.equal(base32(Buffer.from("Hello!\xde\xad\xbe\xef", "binary")), "JBSWY3DPEHPK3PXP");
  assert.equal(base32(Buffer.from([0])), "AA", "partial groups are padded with bits, not '='");
});

test("a code is accepted one step either side, and no further", () => {
  const secret = Buffer.from("12345678901234567890", "ascii").toString("hex");
  const now = Date.now();
  const step = currentStep(now);
  assert.equal(matchStep(secret, codeAt(secret, step), now), step);
  assert.equal(matchStep(secret, codeAt(secret, step - 1), now), step - 1, "a clock a little behind");
  assert.equal(matchStep(secret, codeAt(secret, step + 1), now), step + 1, "a clock a little ahead");
  assert.equal(matchStep(secret, codeAt(secret, step - 2), now), null, "too far behind");
  assert.equal(matchStep(secret, codeAt(secret, step + 2), now), null, "too far ahead");
  assert.equal(matchStep(secret, "12345", now), null, "wrong length");
  assert.equal(matchStep(secret, "", now), null);
});

// ── enrolment ────────────────────────────────────────────────────────────────

test("enrolling issues a secret but does not switch the second factor on", () => {
  assert.equal(mfa.beginEnrollment(org.ownerId).ok, true);
  const state = mfa.mfaState(org.ownerId);
  assert.equal(state.enrolling, true);
  assert.equal(state.active, false, "an unconfirmed scan must not gate sign-in");
  assert.ok(state.otpauth?.startsWith("otpauth://totp/"));
  assert.ok(state.secretText, "the key is offered for manual entry");
});

test("activation refuses a wrong code and leaves the account unprotected", () => {
  mfa.beginEnrollment(org.ownerId);
  const result = mfa.activate(org.ownerId, "000000");
  assert.equal(result.ok, false);
  assert.equal(mfa.mfaState(org.ownerId).active, false);
});

test("activation needs a working code, and hands back recovery codes once", () => {
  mfa.beginEnrollment(org.ownerId);
  const result = mfa.activate(org.ownerId, codeAt(secretOf(org.ownerId), currentStep()));
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.recoveryCodes.length, 10);
  assert.equal(new Set(result.recoveryCodes).size, 10, "no duplicates");
  const state = mfa.mfaState(org.ownerId);
  assert.equal(state.active, true);
  assert.equal(state.recoveryRemaining, 10);
  assert.equal(state.secretText, null, "the secret is not shown again once it is live");

  const stored = db.get<{ code_hash: string }>(
    "SELECT code_hash FROM mfa_recovery_codes WHERE user_id = ?", [org.ownerId],
  )!;
  assert.equal(stored.code_hash.length, 64, "stored as a sha-256 digest, not the code");
  assert.ok(
    !result.recoveryCodes.some((c) => c === stored.code_hash),
    "the plaintext code is never in the table",
  );
});

// ── the sign-in check ────────────────────────────────────────────────────────

function activated(): string {
  mfa.beginEnrollment(org.ownerId);
  const secret = secretOf(org.ownerId);
  const result = mfa.activate(org.ownerId, codeAt(secret, currentStep()));
  assert.equal(result.ok, true);
  return secret;
}

test("a code is accepted once — the same one cannot be replayed", () => {
  const secret = activated();
  const step = currentStep();

  // The code that switched it on is already spent, which is the same rule.
  assert.equal(mfa.verifySecondFactor(org.ownerId, codeAt(secret, step)), false);

  assert.equal(mfa.verifySecondFactor(org.ownerId, codeAt(secret, step + 1)), true);
  assert.equal(
    mfa.verifySecondFactor(org.ownerId, codeAt(secret, step + 1)), false,
    "replaying inside the same 30-second window is refused",
  );
});

test("a code from before the last one used is refused", () => {
  const secret = activated();
  const step = currentStep();
  assert.equal(mfa.verifySecondFactor(org.ownerId, codeAt(secret, step + 1)), true);
  assert.equal(mfa.verifySecondFactor(org.ownerId, codeAt(secret, step)), false);
});

test("a wrong code is refused and does not move the clock forward", () => {
  const secret = activated();
  assert.equal(mfa.verifySecondFactor(org.ownerId, "000000"), false);
  assert.equal(mfa.verifySecondFactor(org.ownerId, codeAt(secret, currentStep() + 1)), true);
});

test("a recovery code works exactly once, dashes and case ignored", () => {
  mfa.beginEnrollment(org.ownerId);
  const result = mfa.activate(org.ownerId, codeAt(secretOf(org.ownerId), currentStep()));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const [code] = result.recoveryCodes;

  assert.equal(mfa.verifySecondFactor(org.ownerId, code!.toLowerCase()), true);
  assert.equal(mfa.verifySecondFactor(org.ownerId, code!), false, "a used code is spent");
  assert.equal(mfa.mfaState(org.ownerId).recoveryRemaining, 9);

  const other = result.recoveryCodes[1]!.replace(/-/g, " ");
  assert.equal(mfa.verifySecondFactor(org.ownerId, other), true, "typed without the dashes");
  assert.equal(mfa.mfaState(org.ownerId).recoveryRemaining, 8);
});

test("one user's recovery code does nothing for another", () => {
  const other = seedOrg(db, "Other Co");
  mfa.beginEnrollment(org.ownerId);
  const mine = mfa.activate(org.ownerId, codeAt(secretOf(org.ownerId), currentStep()));
  assert.equal(mine.ok, true);
  if (!mine.ok) return;

  mfa.beginEnrollment(other.ownerId);
  db.run("UPDATE users SET mfa_activated_at = ? WHERE organization_id = ? AND id = ?",
    [new Date().toISOString(), other.id, other.ownerId]);
  assert.equal(mfa.verifySecondFactor(other.ownerId, mine.recoveryCodes[0]!), false);
  assert.equal(mfa.mfaState(org.ownerId).recoveryRemaining, 10, "and it is still unused");
});

test("an account without the second factor on never passes the check", () => {
  mfa.beginEnrollment(org.ownerId);
  const secret = secretOf(org.ownerId);
  assert.equal(
    mfa.verifySecondFactor(org.ownerId, codeAt(secret, currentStep())), false,
    "a scanned but unconfirmed secret is not a credential",
  );
});

// ── turning it off ───────────────────────────────────────────────────────────

test("turning it off needs a working code, and clears everything behind it", () => {
  const secret = activated();
  assert.equal(mfa.disable(org.ownerId, "000000").ok, false, "a guess does not remove it");
  assert.equal(mfa.mfaState(org.ownerId).active, true);

  assert.equal(mfa.disable(org.ownerId, codeAt(secret, currentStep() + 1)).ok, true);
  const state = mfa.mfaState(org.ownerId);
  assert.equal(state.active, false);
  assert.equal(state.enrolling, false, "the secret is gone, not left lying around");
  assert.equal(
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM mfa_recovery_codes WHERE user_id = ?",
      [org.ownerId])!.n,
    0,
    "and so are the recovery codes",
  );
});

test("a recovery code can also turn it off — the lost-phone path", () => {
  mfa.beginEnrollment(org.ownerId);
  const result = mfa.activate(org.ownerId, codeAt(secretOf(org.ownerId), currentStep()));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(mfa.disable(org.ownerId, result.recoveryCodes[0]!).ok, true);
  assert.equal(mfa.mfaState(org.ownerId).active, false);
});
