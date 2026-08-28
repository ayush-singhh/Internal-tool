import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomBytes, scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

const DB = path.join(tmpdir(), `carrier-hub-security-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let throttle: typeof import("../src/lib/throttle.ts");
let reset: typeof import("../src/lib/reset.ts");
let pw: typeof import("../src/lib/password.ts");
let userId: number;
let orgId: number;

before(async () => {
  db = await import("../src/lib/db.ts");
  throttle = await import("../src/lib/throttle.ts");
  reset = await import("../src/lib/reset.ts");
  pw = await import("../src/lib/password.ts");

  const now = new Date().toISOString();
  orgId = db.get<{ id: number }>("SELECT id FROM organizations LIMIT 1")!.id;
  db.run(
    `INSERT INTO users (organization_id, name, email, password_hash, role, active, created_at, updated_at)
     VALUES (?, 'Target User', 'target@x.test', ?, 'dispatcher', 1, ?, ?)`,
    [orgId, pw.hashPassword("original-password"), now, now],
  );
  userId = db.get<{ id: number }>("SELECT id FROM users WHERE organization_id = ? AND email='target@x.test'", [orgId])!.id;
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

beforeEach(() => {
  db.run("DELETE FROM login_attempts");
  db.run("DELETE FROM password_resets");
  db.run("DELETE FROM sessions");
});

// ── Throttling ───────────────────────────────────────────────────────────────

test("an account locks after the configured number of failures", () => {
  const email = "victim@x.test";
  for (let i = 0; i < throttle.RULES.email.max; i++) {
    assert.equal(throttle.checkLogin(email, null).allowed, true, `attempt ${i + 1} allowed`);
    throttle.recordAttempt(email, null, false);
  }
  const verdict = throttle.checkLogin(email, null);
  assert.equal(verdict.allowed, false);
  if (!verdict.allowed) {
    assert.equal(verdict.scope, "email");
    assert.ok(verdict.retryAfterSeconds > 0);
    assert.match(throttle.describeLockout(verdict), /this account/i);
  }
});

test("a lock is scoped to the account it belongs to", () => {
  for (let i = 0; i < throttle.RULES.email.max; i++) {
    throttle.recordAttempt("locked@x.test", null, false);
  }
  assert.equal(throttle.checkLogin("locked@x.test", null).allowed, false);
  assert.equal(throttle.checkLogin("bystander@x.test", null).allowed, true);
});

test("email matching ignores case and padding, so a lock cannot be side-stepped", () => {
  for (let i = 0; i < throttle.RULES.email.max; i++) {
    throttle.recordAttempt("Case@X.test", null, false);
  }
  assert.equal(throttle.checkLogin("  case@x.TEST  ", null).allowed, false);
});

test("signing in successfully clears that account's lock immediately", () => {
  for (let i = 0; i < throttle.RULES.email.max - 1; i++) {
    throttle.recordAttempt("recover@x.test", null, false);
  }
  throttle.recordAttempt("recover@x.test", null, true);
  assert.equal(throttle.checkLogin("recover@x.test", null).allowed, true);
  assert.equal(
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM login_attempts WHERE identifier = 'email:recover@x.test' AND succeeded = 0",
    )!.n,
    0,
    "the failures are cleared, not just outnumbered",
  );
});

test("one host spraying many accounts is caught by the IP limit", () => {
  const ip = "203.0.113.7";
  for (let i = 0; i < throttle.RULES.ip.max; i++) {
    // A different account every time, so the per-email limit never fires.
    throttle.recordAttempt(`spray-${i}@x.test`, ip, false);
  }
  const verdict = throttle.checkLogin("fresh-victim@x.test", ip);
  assert.equal(verdict.allowed, false, "the IP limit catches what the email limit cannot");
  if (!verdict.allowed) {
    assert.equal(verdict.scope, "ip");
    assert.match(throttle.describeLockout(verdict), /this network/i);
  }
  assert.equal(
    throttle.checkLogin("fresh-victim@x.test", "198.51.100.9").allowed, true,
    "a different network is unaffected",
  );
});

test("one valid login does not clear a spray from the same host", () => {
  const ip = "203.0.113.8";
  for (let i = 0; i < throttle.RULES.ip.max; i++) {
    throttle.recordAttempt(`spray2-${i}@x.test`, ip, false);
  }
  throttle.recordAttempt("legit@x.test", ip, true);
  assert.equal(throttle.checkLogin("another@x.test", ip).allowed, false);
});

test("failures outside the window no longer count", () => {
  const old = new Date(Date.now() - (throttle.RULES.email.windowMinutes + 5) * 60_000).toISOString();
  for (let i = 0; i < throttle.RULES.email.max + 2; i++) {
    db.run(
      "INSERT INTO login_attempts (identifier, succeeded, attempted_at) VALUES ('email:stale@x.test', 0, ?)",
      [old],
    );
  }
  assert.equal(throttle.checkLogin("stale@x.test", null).allowed, true);
});

// ── Password reset ───────────────────────────────────────────────────────────

test("a legacy scrypt hash is upgraded in place, exactly as signIn does it", () => {
  // signIn cannot be imported here (it pulls in next/headers), so this runs the same
  // statement it runs. What it proves is that the tenant guard accepts the write: the
  // users table is tenant-owned and login happens before any organisation is known.
  const salt = randomBytes(16).toString("hex");
  const legacy = `scrypt$${salt}$${scryptSync("original-password", salt, 64).toString("hex")}`;
  db.systemQuery(() => db.run("UPDATE users SET password_hash = ? WHERE id = ?", [legacy, userId]));
  assert.equal(pw.needsRehash(legacy), true);

  db.systemQuery(() =>
    db.run("UPDATE users SET password_hash = ? WHERE id = ?", [pw.hashPassword("original-password"), userId]),
  );

  const hash = db.get<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE organization_id = ? AND id = ?", [orgId, userId],
  )!.password_hash;
  assert.equal(pw.needsRehash(hash), false, "the stored hash is now argon2id");
  assert.equal(pw.verifyPassword("original-password", hash), true, "the password still works");
});

test("a reset link sets the password and the raw token is never stored", () => {
  const issued = reset.issueReset(userId, null);
  assert.ok(issued.token.length > 20);

  const stored = db.get<{ token: string }>(
    "SELECT token FROM password_resets WHERE user_id = ?", [userId],
  )!;
  assert.notEqual(stored.token, issued.token, "the database holds a hash, not the token");
  assert.equal(stored.token.length, 64, "sha-256 hex");

  const result = reset.consumeReset(issued.token, "a-brand-new-password");
  assert.deepEqual(result, { ok: true, userId });

  const hash = db.get<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE organization_id = ? AND id = ?", [orgId, userId],
  )!.password_hash;
  assert.equal(pw.verifyPassword("a-brand-new-password", hash), true);
  assert.equal(pw.verifyPassword("original-password", hash), false);
});

test("a link works exactly once", () => {
  const issued = reset.issueReset(userId, null);
  assert.equal(reset.consumeReset(issued.token, "first-password-set").ok, true);

  const second = reset.consumeReset(issued.token, "second-attempt-pw");
  assert.equal(second.ok, false);
  if (!second.ok) assert.match(second.error, /already been used/);
});

test("issuing a new link invalidates the previous one", () => {
  const first = reset.issueReset(userId, null);
  const second = reset.issueReset(userId, null);

  assert.equal(reset.checkReset(first.token).valid, false, "the old link is dead");
  assert.equal(reset.checkReset(second.token).valid, true);
  assert.equal(reset.consumeReset(second.token, "latest-link-password").ok, true);
});

test("an expired link is refused", () => {
  const issued = reset.issueReset(userId, null);
  db.run("UPDATE password_resets SET expires_at = ? WHERE user_id = ?", [
    new Date(Date.now() - 60_000).toISOString(), userId,
  ]);
  const check = reset.checkReset(issued.token);
  assert.equal(check.valid, false);
  if (!check.valid) assert.match(check.reason, /expired/);
});

test("a made-up token is refused and reveals nothing", () => {
  const check = reset.checkReset("not-a-real-token-at-all");
  assert.equal(check.valid, false);
  if (!check.valid) assert.equal(check.reason, "This reset link is not valid.");
});

test("a deactivated account cannot be reset into", () => {
  const issued = reset.issueReset(userId, null);
  db.run("UPDATE users SET active = 0 WHERE organization_id = ? AND id = ?", [orgId, userId]);
  assert.equal(reset.checkReset(issued.token).valid, false);
  assert.equal(reset.consumeReset(issued.token, "should-not-work").ok, false);
  db.run("UPDATE users SET active = 1 WHERE organization_id = ? AND id = ?", [orgId, userId]);
});

test("completing a reset signs the account out everywhere", () => {
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 86_400_000).toISOString();
  for (const sid of ["s1", "s2"]) {
    db.run("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      [sid, userId, now, later]);
  }
  const issued = reset.issueReset(userId, null);
  reset.consumeReset(issued.token, "signed-out-everywhere");
  assert.equal(
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", [userId])!.n,
    0,
  );
});

test("a short password is refused and the link survives for another try", () => {
  const issued = reset.issueReset(userId, null);
  const bad = reset.consumeReset(issued.token, "short");
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /at least 8/);
  assert.equal(reset.checkReset(issued.token).valid, true, "not burned by a failed attempt");
  assert.equal(reset.consumeReset(issued.token, "long-enough-now").ok, true);
});
