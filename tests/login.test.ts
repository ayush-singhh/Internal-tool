import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomBytes, scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { codeAt, currentStep } from "../src/lib/totp.ts";
import { seedOrg, type TestOrg } from "./helpers.ts";

const DB = path.join(tmpdir(), `carrier-hub-login-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let login: typeof import("../src/lib/login.ts");
let mfa: typeof import("../src/lib/mfa.ts");
let pw: typeof import("../src/lib/password.ts");
let org: TestOrg;

const EMAIL = "signin@test.local";
const PASSWORD = "a-real-password";
const IP = "203.0.113.9";

before(async () => {
  db = await import("../src/lib/db.ts");
  login = await import("../src/lib/login.ts");
  mfa = await import("../src/lib/mfa.ts");
  pw = await import("../src/lib/password.ts");
  org = seedOrg(db, "Login Co", EMAIL);
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

beforeEach(() => {
  db.run("DELETE FROM login_attempts");
  db.run("DELETE FROM mfa_recovery_codes");
  db.run(
    `UPDATE users SET password_hash = ?, active = 1,
            mfa_secret = NULL, mfa_activated_at = NULL, mfa_last_step = NULL
      WHERE organization_id = ? AND id = ?`,
    [pw.hashPassword(PASSWORD), org.id, org.ownerId],
  );
});

const hashOf = () =>
  db.get<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE organization_id = ? AND id = ?", [org.id, org.ownerId],
  )!.password_hash;

/** Switches the second factor on the way the settings page does. Returns the secret. */
function enable(): string {
  mfa.beginEnrollment(org.ownerId);
  const secret = db.get<{ mfa_secret: string }>(
    "SELECT mfa_secret FROM users WHERE organization_id = ? AND id = ?", [org.id, org.ownerId],
  )!.mfa_secret;
  assert.equal(mfa.activate(org.ownerId, codeAt(secret, currentStep())).ok, true);
  return secret;
}

// ── the password step ────────────────────────────────────────────────────────

test("a correct password without a second factor signs straight in", () => {
  const result = login.passwordStep(EMAIL, PASSWORD, IP);
  assert.deepEqual(result, { ok: true, userId: org.ownerId, mfaRequired: false });
});

test("a wrong password is refused, and says nothing about which addresses exist", () => {
  const wrong = login.passwordStep(EMAIL, "not-the-password", IP);
  const missing = login.passwordStep("nobody@test.local", "anything", IP);
  assert.equal(wrong.ok, false);
  assert.equal(missing.ok, false);
  assert.deepEqual(wrong, missing, "the two failures are indistinguishable");
});

test("a deactivated account cannot sign in even with the right password", () => {
  db.run("UPDATE users SET active = 0 WHERE organization_id = ? AND id = ?", [org.id, org.ownerId]);
  const result = login.passwordStep(EMAIL, PASSWORD, IP);
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /deactivated/);
});

test("the account lock still applies before any password is checked", () => {
  for (let i = 0; i < 5; i++) login.passwordStep(EMAIL, "wrong", IP);
  const result = login.passwordStep(EMAIL, PASSWORD, IP);
  assert.equal(result.ok, false, "even the correct password is refused while locked");
  if (!result.ok) assert.match(result.error, /Too many failed sign-in attempts/);
});

test("a legacy scrypt hash is replaced with argon2id on the way through", () => {
  const salt = randomBytes(16).toString("hex");
  db.run("UPDATE users SET password_hash = ? WHERE organization_id = ? AND id = ?", [
    `scrypt$${salt}$${scryptSync(PASSWORD, salt, 64).toString("hex")}`, org.id, org.ownerId,
  ]);
  assert.equal(pw.needsRehash(hashOf()), true);

  assert.equal(login.passwordStep(EMAIL, PASSWORD, IP).ok, true, "the old hash still opens the door");
  assert.equal(pw.needsRehash(hashOf()), false, "and is upgraded in place");
  assert.equal(pw.verifyPassword(PASSWORD, hashOf()), true, "to a hash of the same password");
});

test("a failed sign-in leaves the stored hash alone", () => {
  const before = hashOf();
  login.passwordStep(EMAIL, "wrong", IP);
  assert.equal(hashOf(), before);
});

// ── the second factor ────────────────────────────────────────────────────────

test("with the second factor on, the password alone is not a sign-in", () => {
  enable();
  const result = login.passwordStep(EMAIL, PASSWORD, IP);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.mfaRequired, true, "the caller must hold the session back for a code");
});

test("the code step accepts a current code and refuses a wrong one", () => {
  const secret = enable();
  const bad = login.secondFactorStep(org.ownerId, EMAIL, "000000", IP);
  assert.equal(bad.ok, false);

  const good = login.secondFactorStep(org.ownerId, EMAIL, codeAt(secret, currentStep() + 1), IP);
  assert.equal(good.ok, true);
});

test("guessing codes trips the same account lock as guessing passwords", () => {
  const secret = enable();
  for (let i = 0; i < 5; i++) {
    assert.equal(login.secondFactorStep(org.ownerId, EMAIL, "000000", IP).ok, false);
  }
  const result = login.secondFactorStep(org.ownerId, EMAIL, codeAt(secret, currentStep() + 1), IP);
  assert.equal(result.ok, false, "a real code is refused while the account is locked");
  if (!result.ok) assert.match(result.error, /Too many failed sign-in attempts/);
});

test("a code cannot be used twice, even inside its own window", () => {
  const secret = enable();
  const code = codeAt(secret, currentStep() + 1);
  assert.equal(login.secondFactorStep(org.ownerId, EMAIL, code, IP).ok, true);
  assert.equal(login.secondFactorStep(org.ownerId, EMAIL, code, IP).ok, false);
});

test("turning the second factor off puts sign-in back to one step", () => {
  const secret = enable();
  assert.equal(mfa.disable(org.ownerId, codeAt(secret, currentStep() + 1)).ok, true);
  const result = login.passwordStep(EMAIL, PASSWORD, IP);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.mfaRequired, false);
});
