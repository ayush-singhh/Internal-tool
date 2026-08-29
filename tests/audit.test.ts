import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { seedOrg, type TestOrg } from "./helpers.ts";

// Nothing under src/lib is imported at the top of this file. `db.ts` reads
// CARRIER_DB_PATH when it is first loaded, so a static import here would bind the path
// before the line below sets it — and every query would land in data/carrier-hub.db.
// That is why every test file loads the modules it needs inside `before()`.
const DB = path.join(tmpdir(), `carrier-hub-audit-${process.pid}.db`);
for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let audit: typeof import("../src/lib/audit.ts");
let AUDIT: typeof import("../src/lib/audit.ts")["AUDIT"];
let AUDIT_LABELS: typeof import("../src/lib/audit.ts")["AUDIT_LABELS"];
let Org: typeof import("../src/lib/tenant-db.ts")["Org"];
let TENANT_TABLES: typeof import("../src/lib/tenant-db.ts")["TENANT_TABLES"];
let login: typeof import("../src/lib/login.ts");
let pw: typeof import("../src/lib/password.ts");
let alpha: TestOrg;
let beta: TestOrg;

before(async () => {
  db = await import("../src/lib/db.ts");
  audit = await import("../src/lib/audit.ts");
  ({ AUDIT, AUDIT_LABELS } = audit);
  ({ Org, TENANT_TABLES } = await import("../src/lib/tenant-db.ts"));
  login = await import("../src/lib/login.ts");
  pw = await import("../src/lib/password.ts");
  alpha = seedOrg(db, "Alpha Audit", "alpha@audit.test");
  beta = seedOrg(db, "Beta Audit", "beta@audit.test");
  db.run("UPDATE users SET password_hash = ? WHERE organization_id = ? AND id = ?",
    [pw.hashPassword("a real password"), alpha.id, alpha.ownerId]);
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

beforeEach(() => {
  db.run("DELETE FROM login_attempts");
  db.systemQuery(() => db.run("DELETE FROM audit_log"));
});

test("the log is tenant-owned, so the guard scopes every read of it", () => {
  assert.ok((TENANT_TABLES as readonly string[]).includes("audit_log"));
  // Proof rather than assertion: an unscoped read is refused by the guard itself.
  assert.throws(() => db.all("SELECT * FROM audit_log"), /Tenant isolation guard/);
});

test("one organisation never sees another's entries", () => {
  audit.record({ organizationId: alpha.id, userId: alpha.ownerId, actor: "alpha@audit.test",
    action: AUDIT.SIGNIN_SUCCESS });
  audit.record({ organizationId: beta.id, userId: beta.ownerId, actor: "beta@audit.test",
    action: AUDIT.SIGNIN_SUCCESS });

  const mine = audit.recentAudit(new Org(alpha.id));
  assert.equal(mine.length, 1);
  assert.equal(mine[0]!.user_name, "Owner");
  assert.equal(audit.recentAudit(new Org(beta.id)).length, 1);
});

test("a sign-in is recorded, and so is a refused one", () => {
  assert.equal(login.passwordStep("alpha@audit.test", "a real password", "203.0.113.1").ok, true);
  assert.equal(login.passwordStep("alpha@audit.test", "wrong", "203.0.113.2").ok, false);

  const entries = audit.recentAudit(new Org(alpha.id));
  const actions = entries.map((e) => e.action);
  assert.ok(actions.includes(AUDIT.SIGNIN_SUCCESS));
  assert.ok(actions.includes(AUDIT.SIGNIN_FAILED), "a refused sign-in is the one worth having");
  assert.equal(entries.find((e) => e.action === AUDIT.SIGNIN_FAILED)!.ip, "203.0.113.2");
});

test("an address belonging to nobody is not recorded against anybody", () => {
  assert.equal(login.passwordStep("ghost@nowhere.test", "whatever", "203.0.113.3").ok, false);
  assert.equal(audit.recentAudit(new Org(alpha.id)).length, 0);
  assert.equal(audit.recentAudit(new Org(beta.id)).length, 0);
});

test("the lockout itself is recorded, so a locked account is visible", () => {
  for (let i = 0; i < 5; i++) login.passwordStep("alpha@audit.test", "wrong", "203.0.113.4");
  login.passwordStep("alpha@audit.test", "a real password", "203.0.113.4");

  const blocked = audit.recentAudit(new Org(alpha.id)).filter((e) => e.action === AUDIT.SIGNIN_BLOCKED);
  assert.equal(blocked.length, 1, "the attempt that hit the lock is its own event");
});

test("the record outlives the account it names", () => {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO users (organization_id, name, email, password_hash, role, active,
                        email_verified_at, created_at, updated_at)
     VALUES (?, 'Temp Person', 'temp@audit.test', 'x', 'dispatcher', 1, ?, ?, ?)`,
    [alpha.id, now, now, now],
  );
  const tempId = db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
  audit.record({ organizationId: alpha.id, userId: tempId, actor: "temp@audit.test",
    action: AUDIT.EXPORT_RUN, detail: "46 carriers" });

  // Removing the account must be possible, and must not take the record with it.
  db.run("DELETE FROM users WHERE organization_id = ? AND id = ?", [alpha.id, tempId]);

  const entry = audit.recentAudit(new Org(alpha.id))[0]!;
  assert.equal(entry.action, AUDIT.EXPORT_RUN);
  assert.equal(entry.user_name, "temp@audit.test", "the actor is text, not a join that just broke");
  assert.equal(entry.detail, "46 carriers");
});

test("recording never throws, whatever happens", () => {
  // An audit write that took down the sign-in it was describing would be a worse failure
  // than the one it set out to document.
  assert.doesNotThrow(() =>
    audit.record({ organizationId: 999_999, userId: null, action: AUDIT.SIGNIN_SUCCESS }),
  );
});

test("every action has a plain-English label", () => {
  for (const action of Object.values(AUDIT)) {
    assert.ok(AUDIT_LABELS[action], `${action} needs a label somebody can read`);
  }
});
