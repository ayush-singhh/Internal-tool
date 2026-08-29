import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { seedOrg, type TestOrg } from "./helpers.ts";

const DB = path.join(tmpdir(), `carrier-hub-sessions-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let sessions: typeof import("../src/lib/sessions.ts");
let org: TestOrg;
let other: TestOrg;

before(async () => {
  db = await import("../src/lib/db.ts");
  sessions = await import("../src/lib/sessions.ts");
  org = seedOrg(db, "Session Co");
  other = seedOrg(db, "Somebody Else");
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

beforeEach(() => db.run("DELETE FROM sessions"));

const hour = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();

function open(userId: number, id: string, over: Partial<{
  userAgent: string; ip: string; expiresAt: string; lastSeen: string; pending: number;
}> = {}) {
  db.run(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, mfa_pending, user_agent, ip, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, userId, new Date().toISOString(), over.expiresAt ?? hour(24), over.pending ?? 0,
      over.userAgent ?? null, over.ip ?? null, over.lastSeen ?? new Date().toISOString(),
    ],
  );
}

test("the list shows this account's live sessions, and marks the one asking", () => {
  open(org.ownerId, "here");
  open(org.ownerId, "phone");
  open(other.ownerId, "somebody-else");

  const list = sessions.listSessions(org.ownerId, "here");
  assert.equal(list.length, 2, "another person's session is not in my list");
  assert.equal(list.filter((s) => s.current).length, 1);
  assert.equal(list.find((s) => s.current)!.id, "here");
});

test("expired and half-finished sessions are not offered as live", () => {
  open(org.ownerId, "expired", { expiresAt: hour(-1) });
  open(org.ownerId, "awaiting-code", { pending: 1 });
  open(org.ownerId, "real");

  const list = sessions.listSessions(org.ownerId, "real");
  assert.deepEqual(list.map((s) => s.id), ["real"]);
});

test("signing out one device ends exactly that one", () => {
  open(org.ownerId, "here");
  open(org.ownerId, "lost-laptop");

  assert.equal(sessions.revokeSession(org.ownerId, "here", "lost-laptop"), true);
  assert.deepEqual(sessions.listSessions(org.ownerId, "here").map((s) => s.id), ["here"]);
});

test("a session id belonging to somebody else cannot be ended", () => {
  open(org.ownerId, "mine");
  open(other.ownerId, "theirs");

  assert.equal(
    sessions.revokeSession(org.ownerId, "mine", "theirs"), false,
    "knowing an id is not the same as owning it",
  );
  assert.equal(sessions.listSessions(other.ownerId, null).length, 1, "and it is still live");
});

test("the current session cannot be revoked from the list", () => {
  open(org.ownerId, "here");
  assert.equal(
    sessions.revokeSession(org.ownerId, "here", "here"), false,
    "signing yourself out belongs on the sign-out button",
  );
  assert.equal(sessions.listSessions(org.ownerId, "here").length, 1);
});

test("signing out everywhere else keeps only this browser", () => {
  open(org.ownerId, "here");
  open(org.ownerId, "phone");
  open(org.ownerId, "old-desktop");
  open(other.ownerId, "untouched");

  assert.equal(sessions.revokeOtherSessions(org.ownerId, "here"), 2);
  assert.deepEqual(sessions.listSessions(org.ownerId, "here").map((s) => s.id), ["here"]);
  assert.equal(sessions.listSessions(other.ownerId, null).length, 1, "and nobody else's");
});

test("last-seen moves, but not on every single request", () => {
  const old = new Date(Date.now() - 60 * 60_000).toISOString();
  open(org.ownerId, "here", { lastSeen: old });

  sessions.touchSession("here");
  const moved = sessions.listSessions(org.ownerId, "here")[0]!.last_seen_at!;
  assert.ok(moved > old, "an hour-old session is refreshed");

  sessions.touchSession("here");
  assert.equal(
    sessions.listSessions(org.ownerId, "here")[0]!.last_seen_at, moved,
    "and a second request a moment later writes nothing",
  );
});

test("a device is named from the browser, and never trusted for anything", () => {
  const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
  assert.equal(sessions.describeDevice(chrome), "Chrome on macOS");
  assert.equal(sessions.describeDevice(iphone), "Safari on iOS");
  assert.equal(sessions.describeDevice(null), "Unknown device");
  assert.equal(sessions.describeDevice("nonsense"), "Unknown browser");
});
