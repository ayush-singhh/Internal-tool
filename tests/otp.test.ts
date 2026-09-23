import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A throwaway database per run — tests never touch data/carrier-hub.db. Set before the
// first import of anything, because db.ts binds CARRIER_DB_PATH when it is first loaded.
const DB = path.join(tmpdir(), `carrier-hub-otp-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;

type Db = typeof import("../src/lib/db.ts");
type Otp = typeof import("../src/lib/applicant-otp.ts");

let db: Db;
let otp: Otp;
let orgId: number;

const PHONE = "5551234567";

before(async () => {
  db = await import("../src/lib/db.ts");
  otp = await import("../src/lib/applicant-otp.ts");
  orgId = db.get<{ id: number }>("SELECT id FROM organizations LIMIT 1")!.id;
});

beforeEach(() => {
  db.systemQuery(() => db.run("DELETE FROM applicant_otps", []));
});

after(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB}${suffix}`, { force: true });
});

const rows = () =>
  db.systemQuery(() =>
    db.all<{ code_hash: string; attempts: number; consumed_at: string | null }>(
      "SELECT code_hash, attempts, consumed_at FROM applicant_otps ORDER BY id",
      [],
    ),
  );

test("a code is six digits and verifies exactly once", () => {
  const code = otp.issueCode(orgId, PHONE);
  assert.match(code, /^\d{6}$/);
  assert.deepEqual(otp.verifyCode(orgId, PHONE, code), { ok: true });
  // Replay is the whole point of consuming it: a code read off a shoulder, or left in a
  // message thread, must not open a second session.
  assert.deepEqual(otp.verifyCode(orgId, PHONE, code), { ok: false, reason: "no_code" });
});

test("the plain code is never stored", () => {
  const code = otp.issueCode(orgId, PHONE);
  const stored = rows();
  assert.equal(stored.length, 1);
  assert.doesNotMatch(stored[0]!.code_hash, new RegExp(code));
  assert.match(stored[0]!.code_hash, /^[0-9a-f]{64}$/, "SHA-256 hex, as password_resets does");
});

test("a wrong code is counted, and five wrong codes burn it", () => {
  const code = otp.issueCode(orgId, PHONE);
  for (let i = 0; i < 4; i++) {
    assert.deepEqual(otp.verifyCode(orgId, PHONE, "000000"), { ok: false, reason: "incorrect" });
  }
  assert.equal(rows()[0]!.attempts, 4);
  assert.deepEqual(otp.verifyCode(orgId, PHONE, "000000"), { ok: false, reason: "incorrect" });
  // Burnt: the real code no longer works either, so guessing cannot be resumed by
  // getting lucky on attempt six.
  assert.deepEqual(otp.verifyCode(orgId, PHONE, code), { ok: false, reason: "no_code" });
});

test("an expired code fails", () => {
  const issued = new Date("2026-09-23T10:00:00.000Z");
  const code = otp.issueCode(orgId, PHONE, issued);
  const justInside = new Date("2026-09-23T10:09:00.000Z");
  const justOutside = new Date("2026-09-23T10:11:00.000Z");
  assert.deepEqual(otp.verifyCode(orgId, PHONE, code, justOutside), { ok: false, reason: "no_code" });
  // And the boundary the other way, so the ten minutes is real rather than incidental.
  const second = otp.issueCode(orgId, PHONE, issued);
  assert.deepEqual(otp.verifyCode(orgId, PHONE, second, justInside), { ok: true });
});

test("asking for a new code invalidates the one before it", () => {
  const first = otp.issueCode(orgId, PHONE);
  const second = otp.issueCode(orgId, PHONE);
  assert.notEqual(first, second);
  assert.deepEqual(otp.verifyCode(orgId, PHONE, first), { ok: false, reason: "incorrect" });
  assert.deepEqual(otp.verifyCode(orgId, PHONE, second), { ok: true });
});

test("verifying with no code outstanding says so", () => {
  assert.deepEqual(otp.verifyCode(orgId, PHONE, "123456"), { ok: false, reason: "no_code" });
});

test("a code is scoped to its organisation and its phone number", () => {
  db.systemQuery(() =>
    db.run("INSERT INTO organizations (name, slug, status, created_at) VALUES ('Other', 'other-otp', 'active', ?)",
      [new Date().toISOString()]));
  const otherOrg = db.systemQuery(() =>
    db.get<{ id: number }>("SELECT id FROM organizations WHERE slug = 'other-otp'")!.id);

  const code = otp.issueCode(orgId, PHONE);
  assert.deepEqual(otp.verifyCode(otherOrg, PHONE, code), { ok: false, reason: "no_code" });
  assert.deepEqual(otp.verifyCode(orgId, "5559999999", code), { ok: false, reason: "no_code" });
  assert.deepEqual(otp.verifyCode(orgId, PHONE, code), { ok: true });
});
