import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// See audit.test.ts for why every test file loads src/lib modules inside before(),
// rather than at the top: db.ts binds CARRIER_DB_PATH at import time.
const DB = path.join(tmpdir(), `carrier-hub-errors-${process.pid}.db`);
for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let errors: typeof import("../src/lib/errors.ts");

before(async () => {
  db = await import("../src/lib/db.ts");
  errors = await import("../src/lib/errors.ts");
  db.get("SELECT 1"); // opens the connection, which runs the migrations
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

beforeEach(() => {
  db.run("DELETE FROM error_log");
});

test("a recorded error can be read back, newest first", () => {
  errors.recordError({ message: "first", path: "/carriers", method: "GET", routeType: "render" });
  errors.recordError({ message: "second", digest: "abc123", path: "/api/export", method: "POST" });

  const recent = errors.recentErrors();
  assert.equal(recent.length, 2);
  assert.equal(recent[0]!.message, "second", "newest first");
  assert.equal(recent[0]!.digest, "abc123");
  assert.equal(recent[1]!.message, "first");
  assert.equal(recent[1]!.route_type, "render");
});

test("a missing path or digest is fine — a request can fail before either exists", () => {
  errors.recordError({ message: "proxy blew up before routing" });
  const [entry] = errors.recentErrors();
  assert.equal(entry!.path, null);
  assert.equal(entry!.digest, null);
});

test("recording never throws, whatever happens", () => {
  assert.doesNotThrow(() => errors.recordError({ message: "x".repeat(10_000) }));
});

test("the limit is respected", () => {
  for (let i = 0; i < 5; i++) errors.recordError({ message: `error ${i}` });
  assert.equal(errors.recentErrors(2).length, 2);
});
