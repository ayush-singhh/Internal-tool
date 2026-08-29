import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { seedOrg, lookupId, type TestOrg } from "./helpers.ts";
import { can, type SessionUser } from "../src/lib/permissions.ts";
import { ROLES } from "../src/lib/constants.ts";

const DB = path.join(tmpdir(), `carrier-hub-support-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let support: typeof import("../src/lib/support.ts");
let team: typeof import("../src/lib/team.ts");
let carriers: typeof import("../src/lib/carriers.ts");
let alpha: TestOrg;
let beta: TestOrg;
let supportId: number;

before(async () => {
  db = await import("../src/lib/db.ts");
  support = await import("../src/lib/support.ts");
  team = await import("../src/lib/team.ts");
  carriers = await import("../src/lib/carriers.ts");

  alpha = seedOrg(db, "Alpha Freight");
  beta = seedOrg(db, "Beta Logistics");
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO users (organization_id, name, email, password_hash, role, active,
                        email_verified_at, created_at, updated_at)
     VALUES (?, 'Sam Support', 'sam@platform.test', 'x', ?, 1, ?, ?, ?)`,
    [alpha.id, ROLES.SUPPORT, now, now, now],
  );
  supportId = db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;

  // One carrier in each organisation, so a leak would be visible.
  for (const [org, name] of [[alpha, "Alpha Carrier LLC"], [beta, "Beta Carrier LLC"]] as const) {
    db.run(
      `INSERT INTO carriers (organization_id, legal_name, status_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [org.id, name, lookupId(db, org.id, "status", "active"), now, now],
    );
  }
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

beforeEach(() => {
  db.systemQuery(() => db.run("DELETE FROM support_access_log"));
});

const user = (role: string, id = supportId): SessionUser => ({
  id, organization_id: alpha.id, role: role as SessionUser["role"],
  name: "Sam", email: "sam@platform.test", active: 1,
});

// ── who it is ────────────────────────────────────────────────────────────────

test("a support account holds nothing inside any organisation", () => {
  const sam = user(ROLES.SUPPORT);
  for (const action of [
    "carrier:view", "carrier:create", "carrier:edit", "carrier:delete", "carrier:offboard",
    "note:create", "import:run", "export:run", "team:manage", "settings:manage",
  ] as const) {
    assert.equal(can(sam, action), false, action);
  }
});

test("an organisation's administrator cannot mint one", () => {
  const org = { id: alpha.id } as import("../src/lib/tenant-db.ts").Org;
  const created = team.createTeamMember(org, {
    name: "Sneaky", email: "sneaky@x.test", role: ROLES.SUPPORT, password: "a real password",
  });
  assert.equal(created.ok, false, "the role is not one an organisation may assign");

  const member = team.createTeamMember(org, {
    name: "Ordinary", email: "ordinary@x.test", role: "dispatcher", password: "a real password",
  });
  assert.ok(member.ok);
  if (!member.ok) return;
  assert.equal(
    team.updateTeamMember(org, member.id, { role: ROLES.SUPPORT }).ok, false,
    "nor promote somebody into it afterwards",
  );
});

// ── what it can see ──────────────────────────────────────────────────────────

test("it lists every organisation, with counts", () => {
  const tenants = support.listTenants();
  const names = tenants.map((t) => t.name);
  assert.ok(names.includes("Alpha Freight") && names.includes("Beta Logistics"));
  assert.equal(tenants.find((t) => t.name === "Beta Logistics")!.carriers, 1);
});

test("reading a tenant goes through the ordinary scoped queries", () => {
  // The handle is an ordinary Org, so every existing query stays scoped and the guard
  // still applies — support borrows authority, it does not switch it off.
  const seenInBeta = carriers.listCarriers(support.tenantHandle(beta.id), {}, { pageSize: 50 });
  assert.equal(seenInBeta.rows.length, 1);
  assert.equal(seenInBeta.rows[0]!.legal_name, "Beta Carrier LLC");

  const seenInAlpha = carriers.listCarriers(support.tenantHandle(alpha.id), {}, { pageSize: 50 });
  assert.equal(seenInAlpha.rows[0]!.legal_name, "Alpha Carrier LLC");

  const betaCarrierId = seenInBeta.rows[0]!.id;
  assert.equal(
    carriers.getCarrier(support.tenantHandle(alpha.id), betaCarrierId), undefined,
    "a tenant handle still cannot reach across into another organisation",
  );
});

// ── what it leaves behind ────────────────────────────────────────────────────

test("every view is recorded, with who, whose data, and what", () => {
  support.recordAccess(supportId, beta.id, "/support/2/carriers/7");
  const log = support.recentAccess();
  assert.equal(log.length, 1);
  assert.equal(log[0]!.user_name, "Sam Support");
  assert.equal(log[0]!.organization_name, "Beta Logistics");
  assert.equal(log[0]!.path, "/support/2/carriers/7");
});

test("the record is not tenant-owned, so no customer can read or lose it", async () => {
  const { TENANT_TABLES } = await import("../src/lib/tenant-db.ts");
  assert.ok(
    !(TENANT_TABLES as readonly string[]).includes("support_access_log"),
    "it belongs to the platform, not to the organisation it describes",
  );
  support.recordAccess(supportId, beta.id, "/support/2");
  // Nothing in the application deletes from it; the only writer is recordAccess.
  assert.equal(support.recentAccess().length, 1);
});

test("entries survive in order, newest first", () => {
  support.recordAccess(supportId, alpha.id, "/support/1");
  support.recordAccess(supportId, beta.id, "/support/2");
  const log = support.recentAccess();
  assert.equal(log.length, 2);
  assert.ok(log[0]!.created_at >= log[1]!.created_at);
});
