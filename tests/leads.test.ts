/**
 * Leads — the sales pipeline, and the one-way door into `carriers`.
 *
 * Three rules are worth pinning here, because getting any of them wrong is silent:
 *   1. `won` is not a value anybody may type. It is what conversion writes.
 *   2. Conversion happens once, and both halves of it land together or neither does.
 *   3. A sales rep sees their own leads. Not the pipeline, and not anybody else's.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { seedOrg, lookupId, type TestOrg } from "./helpers.ts";

const DB = path.join(tmpdir(), `carrier-hub-leads-${process.pid}.db`);
for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let leads: typeof import("../src/lib/leads.ts");
let permissions: typeof import("../src/lib/permissions.ts");
let ROLES: typeof import("../src/lib/constants.ts")["ROLES"];
let LEAD_STATUS: typeof import("../src/lib/constants.ts")["LEAD_STATUS"];
let STATUS: typeof import("../src/lib/constants.ts")["STATUS"];
let alpha: TestOrg;
let beta: TestOrg;
let org: import("../src/lib/tenant-db.ts").Org;
let betaOrg: import("../src/lib/tenant-db.ts").Org;
let rep: number;
let otherRep: number;

const now = () => new Date().toISOString();

before(async () => {
  db = await import("../src/lib/db.ts");
  leads = await import("../src/lib/leads.ts");
  permissions = await import("../src/lib/permissions.ts");
  ({ ROLES, LEAD_STATUS, STATUS } = await import("../src/lib/constants.ts"));
  const { Org } = await import("../src/lib/tenant-db.ts");

  alpha = seedOrg(db, "Alpha Leads");
  beta = seedOrg(db, "Beta Leads");
  org = new Org(alpha.id);
  betaOrg = new Org(beta.id);

  const addUser = (orgId: number, name: string, email: string, role: string) => {
    db.run(
      `INSERT INTO users (organization_id, name, email, password_hash, role, active, created_at, updated_at)
       VALUES (?, ?, ?, 'x', ?, 1, ?, ?)`,
      [orgId, name, email, role, now(), now()],
    );
    return db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
  };
  rep = addUser(alpha.id, "Rep One", "rep1@alpha.test", ROLES.SALES);
  otherRep = addUser(alpha.id, "Rep Two", "rep2@alpha.test", ROLES.SALES);
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

beforeEach(() => {
  for (const o of [alpha, beta]) {
    db.run("DELETE FROM leads WHERE organization_id = ?", [o.id]);
    db.run("DELETE FROM carrier_activity WHERE organization_id = ?", [o.id]);
    db.run("DELETE FROM carriers WHERE organization_id = ?", [o.id]);
  }
});

const submit = (over: Partial<Parameters<typeof leads.saveLead>[1]> = {}, who = rep) =>
  leads.saveLead(org, { companyName: "Prospect Freight", ownerId: who, ...over }, who);

// ── writing ──────────────────────────────────────────────────────────────────

test("a lead needs a company name", () => {
  const result = submit({ companyName: "   " });
  assert.equal(result.ok, false);
});

test("a submitted lead starts at New and belongs to whoever submitted it", () => {
  const created = submit();
  assert.equal(created.ok, true);

  const [lead] = leads.listLeads(org);
  assert.equal(lead!.company_name, "Prospect Freight");
  assert.equal(lead!.status, LEAD_STATUS.NEW);
  assert.equal(lead!.owner_id, rep);
  assert.equal(lead!.owner_name, "Rep One");
});

test("phone and regulatory numbers are normalised the way the carrier form does", () => {
  submit({ phone: "(555) abc 867-5309x", mcNumber: "MC-123456", usdot: "DOT 99887" });
  const [lead] = leads.listLeads(org);
  assert.equal(lead!.phone_digits, "5558675309");
  assert.equal(lead!.mc_number, "123456");
  assert.equal(lead!.usdot, "99887");
});

test("nobody can type their way to Won — it is what conversion writes", () => {
  const result = submit({ status: "won" });
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /converted/i);
  assert.equal(leads.listLeads(org).length, 0);
});

test("the settable stages are accepted", () => {
  for (const status of ["new", "contacted", "qualified", "lost"]) {
    assert.equal(submit({ companyName: `Lead ${status}`, status }).ok, true, status);
  }
  assert.equal(leads.listLeads(org).length, 4);
});

// ── scoping ──────────────────────────────────────────────────────────────────

test("a rep's own view is the query, not a filter applied to everybody's rows", () => {
  submit({ companyName: "Mine" }, rep);
  submit({ companyName: "Theirs" }, otherRep);

  assert.deepEqual(leads.listLeads(org, rep).map((l) => l.company_name), ["Mine"]);
  assert.deepEqual(
    leads.listLeads(org).map((l) => l.company_name).sort(),
    ["Mine", "Theirs"],
  );
});

test("metrics count by stage, and narrow to one rep the same way the list does", () => {
  submit({ companyName: "A", status: "new" }, rep);
  submit({ companyName: "B", status: "qualified" }, rep);
  submit({ companyName: "C", status: "lost" }, otherRep);

  const all = leads.leadMetrics(org);
  assert.equal(all.total, 3);
  assert.equal(all.new, 1);
  assert.equal(all.qualified, 1);
  assert.equal(all.lost, 1);
  assert.equal(all.open, 2, "lost has left the pipeline");

  const mine = leads.leadMetrics(org, rep);
  assert.equal(mine.total, 2);
  assert.equal(mine.lost, 0);
});

test("one organisation's leads are invisible to another", () => {
  submit({ companyName: "Alpha Only" });
  assert.equal(leads.listLeads(betaOrg).length, 0);
  assert.equal(leads.leadMetrics(betaOrg).total, 0);

  const [lead] = leads.listLeads(org);
  assert.equal(leads.getLead(betaOrg, lead!.id), undefined);
});

// ── conversion ───────────────────────────────────────────────────────────────

test("converting creates a carrier at About to Be Active carrying the lead's facts", () => {
  const trailer = lookupId(db, alpha.id, "trailer_type", "reefer");
  const source = lookupId(db, alpha.id, "lead_source", "referral");
  submit({
    companyName: "Northbound Carriers",
    contactName: "Dana Reyes",
    phone: "5551234567",
    email: "Dana@Northbound.test",
    mcNumber: "778899",
    usdot: "112233",
    truckCount: 6,
    trailerTypeId: trailer,
    leadSourceId: source,
    status: "qualified",
  });
  const [lead] = leads.listLeads(org);

  const result = leads.convertLead(org, lead!.id, alpha.ownerId);
  assert.equal(result.ok, true);

  const carrier = db.get<{
    legal_name: string; owner_name: string; phone: string; email: string;
    mc_number: string; usdot: string; truck_count: number;
    trailer_type_id: number; lead_source_id: number; status_id: number;
  }>("SELECT * FROM carriers WHERE organization_id = ? AND id = ?", [alpha.id, (result as { id: number }).id])!;

  assert.equal(carrier.legal_name, "Northbound Carriers");
  assert.equal(carrier.owner_name, "Dana Reyes");
  assert.equal(carrier.email, "dana@northbound.test");
  assert.equal(carrier.mc_number, "778899");
  assert.equal(carrier.usdot, "112233");
  assert.equal(carrier.truck_count, 6);
  assert.equal(carrier.trailer_type_id, trailer);
  assert.equal(carrier.lead_source_id, source);
  assert.equal(
    carrier.status_id,
    lookupId(db, alpha.id, "status", STATUS.ABOUT_TO_BE_ACTIVE),
    "a won lead is agreed but not yet running",
  );
});

test("the lead survives conversion as the record of how the carrier arrived", () => {
  submit({ companyName: "Keepsake Logistics", status: "qualified" });
  const [before_] = leads.listLeads(org);
  const result = leads.convertLead(org, before_!.id, alpha.ownerId);

  const [after_] = leads.listLeads(org);
  assert.equal(after_!.status, LEAD_STATUS.WON);
  assert.equal(after_!.converted_carrier_id, (result as { id: number }).id);
  assert.ok(after_!.converted_at, "conversion is dated");
});

test("the carrier's own timeline says it came from a lead", () => {
  submit({ companyName: "Traceable Freight" });
  const [lead] = leads.listLeads(org);
  const result = leads.convertLead(org, lead!.id, alpha.ownerId);

  const summaries = db
    .all<{ summary: string }>(
      "SELECT summary FROM carrier_activity WHERE organization_id = ? AND carrier_id = ?",
      [alpha.id, (result as { id: number }).id],
    )
    .map((r) => r.summary);
  assert.ok(
    summaries.some((s) => /converted from a lead/i.test(s)),
    `expected a conversion entry, got ${JSON.stringify(summaries)}`,
  );
  assert.ok(summaries.some((s) => /record created/i.test(s)), "and the ordinary creation entry");
});

test("a lead converts once", () => {
  submit({ companyName: "Once Only" });
  const [lead] = leads.listLeads(org);
  assert.equal(leads.convertLead(org, lead!.id, alpha.ownerId).ok, true);

  const second = leads.convertLead(org, lead!.id, alpha.ownerId);
  assert.equal(second.ok, false);
  assert.match((second as { error: string }).error, /already been converted/i);
  assert.equal(
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM carriers WHERE organization_id = ?", [alpha.id])!.n,
    1,
    "the refused second attempt created no carrier",
  );
});

test("a lost lead is not converted by accident", () => {
  submit({ companyName: "Gone Elsewhere", status: "lost" });
  const [lead] = leads.listLeads(org);
  const result = leads.convertLead(org, lead!.id, alpha.ownerId);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /lost lead/i);
});

test("a converted lead can no longer be edited", () => {
  submit({ companyName: "Sealed" });
  const [lead] = leads.listLeads(org);
  leads.convertLead(org, lead!.id, alpha.ownerId);

  const result = leads.saveLead(org, { id: lead!.id, companyName: "Rewritten History" }, rep);
  assert.equal(result.ok, false);
  assert.equal(leads.listLeads(org)[0]!.company_name, "Sealed");
});

test("a lead in another organisation cannot be converted from this one", () => {
  submit({ companyName: "Alpha Prospect" });
  const [lead] = leads.listLeads(org);
  const result = leads.convertLead(betaOrg, lead!.id, beta.ownerId);
  assert.equal(result.ok, false);
  assert.equal(
    db.get<{ n: number }>("SELECT COUNT(*) AS n FROM carriers WHERE organization_id = ?", [beta.id])!.n,
    0,
  );
});

// ── the nested transaction conversion depends on ─────────────────────────────
//
// `convertLead` calls `createCarrier`, which already transacts. Before this, `BEGIN`
// inside a transaction was a SQLite error, so a composite write had to inline a copy of
// whatever it wanted to reuse. These pin the behaviour conversion's atomicity rests on.

test("a nested transaction joins the outer one rather than failing", () => {
  db.transaction(() => {
    submit({ companyName: "Outer" });
    db.transaction(() => { submit({ companyName: "Inner" }); });
  });
  assert.deepEqual(leads.listLeads(org).map((l) => l.company_name).sort(), ["Inner", "Outer"]);
});

test("an outer rollback discards what the nested transaction wrote", () => {
  assert.throws(() =>
    db.transaction(() => {
      db.transaction(() => { submit({ companyName: "Nested" }); });
      throw new Error("the outer half failed");
    }),
  );
  assert.equal(leads.listLeads(org).length, 0, "nothing may survive the outer rollback");
});

test("a caught inner failure loses only the inner writes", () => {
  db.transaction(() => {
    submit({ companyName: "Kept" });
    try {
      db.transaction(() => {
        submit({ companyName: "Discarded" });
        throw new Error("the inner half failed");
      });
    } catch {
      // Swallowed on purpose: the point is that the outer transaction may continue.
    }
    submit({ companyName: "Also kept" });
  });
  assert.deepEqual(leads.listLeads(org).map((l) => l.company_name).sort(), ["Also kept", "Kept"]);
});

// ── who may do what ──────────────────────────────────────────────────────────

const asRole = (role: string, id = 1) => ({
  id,
  organization_id: alpha.id,
  name: "Test",
  email: "t@x.test",
  role: role as never,
  active: 1,
});

test("sales may view and submit leads, and nothing else in the product", () => {
  const user = asRole(ROLES.SALES);
  const { can } = permissions;
  assert.equal(can(user, "lead:view"), true);
  assert.equal(can(user, "lead:create"), true);
  assert.equal(can(user, "lead:edit"), true, "in the abstract — scoped below");
  for (const action of ["lead:convert", "carrier:view", "carrier:create", "load:view", "load:rate", "invoice:view"] as const) {
    assert.equal(can(user, action), false, `sales must not have ${action}`);
  }
});

test("a rep may edit their own lead and not another rep's", () => {
  const user = asRole(ROLES.SALES, rep);
  assert.equal(permissions.can(user, "lead:edit", { owner_id: rep }), true);
  assert.equal(permissions.can(user, "lead:edit", { owner_id: otherRep }), false);
  assert.equal(permissions.can(user, "lead:edit", { owner_id: null }), false);
});

test("administrators run the whole pipeline; dispatchers and viewers are not in it", () => {
  const { can } = permissions;
  for (const action of ["lead:view", "lead:create", "lead:edit", "lead:convert"] as const) {
    assert.equal(can(asRole(ROLES.ADMIN), action), true, `admin ${action}`);
    assert.equal(can(asRole(ROLES.OWNER), action), true, `owner ${action}`);
    for (const role of [ROLES.DISPATCHER, ROLES.ACCOUNT_MANAGER, ROLES.VIEWER, ROLES.SUPPORT]) {
      assert.equal(can(asRole(role), action), false, `${role} must not have ${action}`);
    }
  }
});

test("a deactivated sales user reaches nothing", () => {
  const user = { ...asRole(ROLES.SALES, rep), active: 0 };
  assert.equal(permissions.can(user, "lead:view"), false);
  assert.equal(permissions.can(user, "lead:edit", { owner_id: rep }), false);
});
