import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword } from "../src/lib/password.ts";
import { can, type SessionUser } from "../src/lib/permissions.ts";

test("password hashes round-trip and reject wrong input", () => {
  const stored = hashPassword("Dispatch!2024");
  assert.ok(stored.startsWith("scrypt$"));
  assert.equal(verifyPassword("Dispatch!2024", stored), true);
  assert.equal(verifyPassword("dispatch!2024", stored), false);
  assert.equal(verifyPassword("", stored), false);
  assert.equal(verifyPassword("x", "garbage"), false);
});

test("password hashes are salted per user", () => {
  assert.notEqual(hashPassword("same"), hashPassword("same"));
});

const user = (id: number, role: SessionUser["role"]): SessionUser => ({
  id, role, name: "T", email: "t@x.com", active: 1,
});

const admin = user(1, "admin");
const dispatcher = user(2, "dispatcher");
const manager = user(3, "account_manager");
const viewer = user(4, "viewer");

const mine = { dispatcher_id: 2, account_manager_id: 3 };
const theirs = { dispatcher_id: 9, account_manager_id: 9 };

test("admin can do everything", () => {
  for (const a of ["carrier:delete", "import:run", "team:manage", "settings:manage"] as const) {
    assert.equal(can(admin, a), true, a);
  }
  assert.equal(can(admin, "carrier:edit", theirs), true);
});

test("everyone signed in can view and export", () => {
  for (const u of [dispatcher, manager, viewer]) {
    assert.equal(can(u, "carrier:view"), true);
    assert.equal(can(u, "export:run"), true);
  }
});

test("edit rights are scoped to assigned carriers", () => {
  assert.equal(can(dispatcher, "carrier:edit", mine), true);
  assert.equal(can(dispatcher, "carrier:edit", theirs), false);
  assert.equal(can(manager, "carrier:edit", mine), true);
  assert.equal(can(manager, "carrier:edit", theirs), false);
  assert.equal(can(manager, "carrier:offboard", theirs), false);
});

test("viewers never write", () => {
  for (const a of ["carrier:create", "carrier:edit", "note:create", "carrier:delete"] as const) {
    assert.equal(can(viewer, a, mine), false, a);
  }
});

test("non-admins never manage the team, settings, imports or deletes", () => {
  for (const u of [dispatcher, manager, viewer]) {
    for (const a of ["team:manage", "settings:manage", "import:run", "carrier:delete"] as const) {
      assert.equal(can(u, a, mine), false, `${u.role}/${a}`);
    }
  }
});

test("deactivated and anonymous users can do nothing", () => {
  assert.equal(can({ ...admin, active: 0 }, "carrier:view"), false);
  assert.equal(can(null, "carrier:view"), false);
});
