import { test } from "node:test";
import assert from "node:assert/strict";
import { scryptSync, randomBytes } from "node:crypto";
import { hashPassword, needsRehash, verifyPassword } from "../src/lib/password.ts";
import { can, type SessionUser } from "../src/lib/permissions.ts";

test("password hashes round-trip and reject wrong input", () => {
  const stored = hashPassword("Dispatch!2024");
  assert.ok(stored.startsWith("$argon2id$"));
  assert.equal(verifyPassword("Dispatch!2024", stored), true);
  assert.equal(verifyPassword("dispatch!2024", stored), false);
  assert.equal(verifyPassword("", stored), false);
  assert.equal(verifyPassword("x", "garbage"), false);
});

test("password hashes are salted per user", () => {
  assert.notEqual(hashPassword("same"), hashPassword("same"));
});

/** A hash in the retired format, as it sits in databases created before the migration. */
function legacyScryptHash(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString("hex")}`;
}

test("scrypt hashes from before the migration still verify, and are flagged for rehash", () => {
  const legacy = legacyScryptHash("Dispatch!2024");
  assert.equal(verifyPassword("Dispatch!2024", legacy), true);
  assert.equal(verifyPassword("wrong", legacy), false);
  assert.equal(needsRehash(legacy), true, "a legacy hash must be upgraded on next login");
  assert.equal(needsRehash(hashPassword("Dispatch!2024")), false, "argon2 hashes are current");
  assert.equal(needsRehash("garbage"), true);
});

const user = (id: number, role: SessionUser["role"]): SessionUser => ({
  id, organization_id: 1, role, name: "T", email: "t@x.com", active: 1,
});

const owner = user(0, "owner");
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

test("an owner holds everything an admin does", () => {
  // Tenancy introduced this role and every new organisation's first user has it, so an
  // owner who cannot reach Settings or Team is an organisation nobody can administer.
  for (const a of ["carrier:delete", "import:run", "team:manage", "settings:manage"] as const) {
    assert.equal(can(owner, a), true, a);
  }
  assert.equal(can(owner, "carrier:edit", theirs), true);
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
