import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DB = path.join(tmpdir(), `carrier-hub-team-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let team: typeof import("../src/lib/team.ts");
let settings: typeof import("../src/lib/settings.ts");
let pw: typeof import("../src/lib/password.ts");
let org: import("../src/lib/tenant-db.ts").Org;
let orgId: number;

before(async () => {
  db = await import("../src/lib/db.ts");
  team = await import("../src/lib/team.ts");
  settings = await import("../src/lib/settings.ts");
  pw = await import("../src/lib/password.ts");
  const { Org } = await import("../src/lib/tenant-db.ts");
  orgId = db.get<{ id: number }>("SELECT id FROM organizations LIMIT 1")!.id;
  org = new Org(orgId);
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

beforeEach(() => {
  db.run("DELETE FROM sessions");
  db.run("DELETE FROM carriers WHERE organization_id = ?", [org.id]);
  // Keep only the seeded owner between tests; give it admin-tier for the team tests.
  db.run("DELETE FROM users WHERE organization_id = ? AND id != ?", [orgId, ownerId()]);
  db.run("UPDATE users SET role = 'admin', active = 1 WHERE organization_id = ? AND id = ?", [orgId, ownerId()]);
  settings.resetSettings(org);
});

const ownerId = () => db.get<{ id: number }>("SELECT id FROM users WHERE organization_id = ? ORDER BY id LIMIT 1", [orgId])!.id;

const add = (over: Partial<Parameters<typeof team.createTeamMember>[1]> = {}) =>
  team.createTeamMember(org, {
    name: "Marcus Reed", email: `m${Math.random().toString(36).slice(2, 8)}@x.test`,
    role: "dispatcher", password: "dispatch2026", ...over,
  });

// ── Team ─────────────────────────────────────────────────────────────────────

test("a new team member can sign in with the password they were given", () => {
  const result = add({ email: "signin@x.test", password: "correct horse" });
  assert.ok(result.ok);
  const row = db.get<{ password_hash: string; active: number; role: string }>(
    "SELECT password_hash, active, role FROM users WHERE organization_id = ? AND email = 'signin@x.test'", [orgId],
  )!;
  assert.equal(pw.verifyPassword("correct horse", row.password_hash), true);
  assert.equal(pw.verifyPassword("wrong horse", row.password_hash), false);
  assert.equal(row.active, 1);
  assert.equal(row.role, "dispatcher");
});

test("email is normalised and cannot be reused", () => {
  assert.ok(add({ email: "  Dupe@Example.COM  " }).ok);
  assert.ok(db.get("SELECT id FROM users WHERE organization_id = ? AND email = 'dupe@example.com'", [orgId]), "lowercased");
  const second = add({ email: "DUPE@example.com" });
  assert.deepEqual(second, { ok: false, error: "Someone already uses that email address." });
});

test("bad input is rejected with a usable message", () => {
  assert.match((add({ name: "  " }) as { error: string }).error, /Name is required/);
  assert.match((add({ email: "nope" }) as { error: string }).error, /valid email/);
  assert.match((add({ role: "superuser" }) as { error: string }).error, /valid role/);
  assert.match((add({ password: "short" }) as { error: string }).error, /at least 8/);
});

test("the last active administrator cannot be deactivated or demoted", () => {
  assert.deepEqual(team.setTeamMemberActive(org, ownerId(), false), {
    ok: false, error: "You cannot deactivate the last active administrator.",
  });
  assert.equal(team.wouldRemoveLastAdmin(org, ownerId(), "viewer"), true);
  assert.equal(team.wouldRemoveLastAdmin(org, ownerId(), "admin"), false);

  const second = add({ email: "admin2@x.test", role: "admin" });
  assert.ok(second.ok);
  assert.equal(team.wouldRemoveLastAdmin(org, ownerId(), "viewer"), false, "safe once a second admin exists");
  assert.equal(team.setTeamMemberActive(org, ownerId(), false).ok, true);
});

test("deactivating revokes sessions but keeps the person's history", () => {
  const created = add({ email: "leaver@x.test" });
  assert.ok(created.ok);
  const id = created.id;

  db.run(
    "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('sess-leaver', ?, ?, ?)",
    [id, new Date().toISOString(), new Date(Date.now() + 86400000).toISOString()],
  );
  db.run(
    `INSERT INTO carriers (organization_id, legal_name, dispatcher_id, created_at, updated_at)
     VALUES (?, 'Assigned Carrier', ?, ?, ?)`,
    [orgId, id, new Date().toISOString(), new Date().toISOString()],
  );

  assert.equal(team.setTeamMemberActive(org, id, false).ok, true);
  assert.equal(
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", [id])!.n, 0,
    "signed out everywhere",
  );
  assert.ok(db.get("SELECT id FROM users WHERE organization_id = ? AND id = ?", [orgId, id]), "the account is kept, not deleted");
  assert.equal(
    db.get<{ dispatcher_id: number }>("SELECT dispatcher_id FROM carriers WHERE organization_id = ? AND legal_name='Assigned Carrier'", [orgId])!.dispatcher_id,
    id,
    "their carriers stay assigned until reassigned",
  );
});

test("a reactivated member can sign in again", () => {
  const created = add({ email: "returner@x.test" });
  assert.ok(created.ok);
  team.setTeamMemberActive(org, created.id, false);
  assert.equal(db.get<{ active: number }>("SELECT active FROM users WHERE organization_id = ? AND id=?", [orgId, created.id])!.active, 0);
  assert.equal(team.setTeamMemberActive(org, created.id, true).ok, true);
  assert.equal(db.get<{ active: number }>("SELECT active FROM users WHERE organization_id = ? AND id=?", [orgId, created.id])!.active, 1);
});

test("editing changes only the fields given", () => {
  const created = add({ email: "editme@x.test", name: "Original Name" });
  assert.ok(created.ok);
  team.updateTeamMember(org, created.id, { role: "account_manager" });

  const row = db.get<{ name: string; email: string; role: string }>(
    "SELECT name, email, role FROM users WHERE organization_id = ? AND id = ?", [orgId, created.id],
  )!;
  assert.equal(row.role, "account_manager");
  assert.equal(row.name, "Original Name", "name untouched");
  assert.equal(row.email, "editme@x.test", "email untouched");
});

test("an edit cannot steal another member's email", () => {
  const a = add({ email: "taken@x.test" });
  const b = add({ email: "other@x.test" });
  assert.ok(a.ok && b.ok);
  assert.deepEqual(team.updateTeamMember(org, b.id, { email: "taken@x.test" }), {
    ok: false, error: "Someone already uses that email address.",
  });
  assert.equal(team.updateTeamMember(org, b.id, { email: "other@x.test" }).ok, true, "own email is fine");
});

test("changing a password ends other sessions but can keep the current one", () => {
  const created = add({ email: "pwuser@x.test" });
  assert.ok(created.ok);
  const now = new Date().toISOString();
  const later = new Date(Date.now() + 86400000).toISOString();
  for (const sid of ["keep-me", "kill-me-1", "kill-me-2"]) {
    db.run("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)",
      [sid, created.id, now, later]);
  }

  assert.equal(team.setPassword(org, created.id, "brand new password", "keep-me").ok, true);
  const left = db.all<{ id: string }>("SELECT id FROM sessions WHERE user_id = ?", [created.id]);
  assert.deepEqual(left.map((s) => s.id), ["keep-me"]);

  const hash = db.get<{ password_hash: string }>(
    "SELECT password_hash FROM users WHERE organization_id = ? AND id = ?", [orgId, created.id],
  )!.password_hash;
  assert.equal(pw.verifyPassword("brand new password", hash), true);
  assert.equal(pw.verifyPassword("dispatch2026", hash), false, "the old password stops working");
});

test("a short password is refused and changes nothing", () => {
  const created = add({ email: "shortpw@x.test" });
  assert.ok(created.ok);
  const before_ = db.get<{ password_hash: string }>("SELECT password_hash FROM users WHERE organization_id = ? AND id=?", [orgId, created.id])!.password_hash;
  assert.match((team.setPassword(org, created.id, "1234567") as { error: string }).error, /at least 8/);
  assert.equal(
    db.get<{ password_hash: string }>("SELECT password_hash FROM users WHERE organization_id = ? AND id=?", [orgId, created.id])!.password_hash,
    before_,
  );
});

test("the team list reports assigned carrier counts", () => {
  const d = add({ email: "disp@x.test", role: "dispatcher" });
  const m = add({ email: "mgr@x.test", role: "account_manager" });
  assert.ok(d.ok && m.ok);
  const now = new Date().toISOString();
  for (let i = 0; i < 3; i++) {
    db.run(
      `INSERT INTO carriers (organization_id, legal_name, dispatcher_id, account_manager_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`, [orgId, `Counted ${i}`, d.id, i < 2 ? m.id : null, now, now],
    );
  }
  const list = team.listTeam(org);
  assert.equal(list.find((t) => t.id === d.id)!.dispatching, 3);
  assert.equal(list.find((t) => t.id === m.id)!.managing, 2);
});

// ── Settings ─────────────────────────────────────────────────────────────────

test("valid thresholds save and are read back", () => {
  assert.deepEqual(
    settings.saveSettings(org, { about_to_be_active_days: "30", investigation_stale_days: "3" }),
    { ok: true },
  );
  assert.equal(db.getSetting(orgId, "about_to_be_active_days"), "30");
  assert.equal(db.getSetting(orgId, "investigation_stale_days"), "3");
});

test("invalid thresholds are rejected and nothing is written", () => {
  settings.saveSettings(org, { about_to_be_active_days: "21" });
  const result = settings.saveSettings(org, {
    about_to_be_active_days: "0",
    missing_first_load_days: "abc",
    investigation_stale_days: "9999",
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.errors.about_to_be_active_days!, /at least 1/);
    assert.match(result.errors.missing_first_load_days!, /whole number/);
    assert.match(result.errors.investigation_stale_days!, /at most 365/);
  }
  assert.equal(db.getSetting(orgId, "about_to_be_active_days"), "21", "the earlier good value survived");
});

test("company name cannot be blanked", () => {
  const result = settings.saveSettings(org, { company_name: "   " });
  assert.equal(result.ok, false);
});

test("restoring defaults puts every threshold back", () => {
  settings.saveSettings(org, { about_to_be_active_days: "99" });
  settings.resetSettings(org);
  assert.equal(db.getSetting(orgId, "about_to_be_active_days"), "14");
  assert.equal(db.getSetting(orgId, "missing_first_load_days"), "21");
  assert.equal(db.getSetting(orgId, "investigation_stale_days"), "7");
});

test("retiring a vocabulary value hides it without touching existing carriers", async () => {
  const lookups = await import("../src/lib/lookups.ts");
  const statusId = db.get<{ id: number }>(
    "SELECT id FROM lookups WHERE organization_id = ? AND kind='status' AND value='suspended'", [orgId],
  )!.id;
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO carriers (organization_id, legal_name, status_id, created_at, updated_at) VALUES (?, 'Still Suspended', ?, ?, ?)",
    [orgId, statusId, now, now],
  );

  const usageBefore = settings.lookupUsage(org).find((l) => l.id === statusId)!;
  assert.equal(usageBefore.usage, 1, "usage is reported before retiring");

  settings.setLookupActive(org, statusId, false);
  assert.equal(
    db.get<{ status_id: number }>("SELECT status_id FROM carriers WHERE organization_id = ? AND legal_name='Still Suspended'", [orgId])!.status_id,
    statusId,
    "the carrier keeps its status",
  );
  assert.equal(db.get<{ active: number }>("SELECT active FROM lookups WHERE organization_id = ? AND id=?", [orgId, statusId])!.active, 0);

  // A retired value stays selectable on a record that already uses it.
  assert.ok(!lookups.options(org, "status").some((o) => o.id === statusId), "hidden from new records");
  assert.ok(lookups.options(org, "status", statusId).some((o) => o.id === statusId), "kept for this record");

  settings.setLookupActive(org, statusId, true);
});
