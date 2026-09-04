/**
 * What the wire actually returns.
 *
 * Two rules shape every assertion here, both learned from the `/support` leak:
 *
 *  1. **A status code is not a denial.** That bug returned 404 and served the data anyway.
 *     So every refusal is checked twice — the status, *and* the absence of the secret from
 *     the body. Asserting only the status is what let it ship.
 *  2. **Refuse with the page, not the layout.** Next renders a page concurrently with its
 *     layout, so a layout that rejects a request does not stop the page running.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { startApp, type Harness } from "./harness.ts";

let app: Harness;

/** A fake S3 the download route can actually reach — same shape `documents.test.ts` and
 *  `backup.test.ts` use, a real `node:http` server rather than a mocking library. Started
 *  before `startApp()`, not per-test: `next start` is spawned as a child process that gets
 *  its environment as a one-time snapshot, so `DOCUMENTS_S3_URL` has to be set before that
 *  spawn, not while a test is running. */
let fakeS3: Server;
const DOC_BODY = "%PDF-1.4 fake bill of lading bytes";

/** Strings that must never appear in a response the caller was not entitled to. */
const VICTIM = ["SECRET VICTIM CARRIER", "Confidential Owner", "555000111", "Victim Logistics"];

function assertNoVictimData(body: string, where: string): void {
  for (const secret of VICTIM) {
    assert.ok(
      !body.includes(secret),
      `${where}: "${secret}" was in the response body — a status code is not a denial`,
    );
  }
}

let victimOrg: number;
let victimCarrier: number;
let outsider: string;   // an ordinary owner of a different tenant
let supportNoMfa: string;
let supportMfa: string;

before(async () => {
  fakeS3 = createServer((_req, res) => { res.writeHead(200).end(DOC_BODY); });
  await new Promise<void>((resolve) => fakeS3.listen(0, "127.0.0.1", () => resolve()));
  const fakeS3Port = (fakeS3.address() as { port: number }).port;
  process.env.DOCUMENTS_S3_URL = `http://KEY:SECRET@127.0.0.1:${fakeS3Port}/docs`;

  app = await startApp();
  const { db } = app;
  const now = new Date().toISOString();

  const { seedOrg, lookupId } = await import("../helpers.ts");
  const victim = seedOrg(db, "Victim Logistics", "vic@victim.test");
  seedOrg(db, "Attacker Dispatch", "mal@attacker.test");
  victimOrg = victim.id;

  db.run(
    `INSERT INTO carriers (organization_id, legal_name, owner_name, phone, mc_number,
                           status_id, created_at, updated_at)
     VALUES (?, 'SECRET VICTIM CARRIER LLC', 'Confidential Owner', '555000111', '999111', ?, ?, ?)`,
    [victim.id, lookupId(db, victim.id, "status", "active"), now, now],
  );
  victimCarrier = db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
  db.run(
    `INSERT INTO carrier_notes (organization_id, carrier_id, user_id, body, pinned, created_at)
     VALUES (?, ?, ?, 'a confidential note', 0, ?)`,
    [victim.id, victimCarrier, victim.ownerId, now],
  );

  // Platform support lives in the operator's own organisation and holds no role inside it.
  const { ROLES } = await import("../../src/lib/constants.ts");
  const ops = db.systemQuery(() =>
    db.get<{ id: number }>("SELECT id FROM organizations ORDER BY id LIMIT 1"),
  )!.id;
  for (const [email, mfa] of [["nomfa@platform.test", false], ["mfa@platform.test", true]] as const) {
    db.run(
      `INSERT INTO users (organization_id, name, email, password_hash, role, active,
                          email_verified_at, mfa_secret, mfa_activated_at, created_at, updated_at)
       VALUES (?, 'Sam Support', ?, 'x', ?, 1, ?, ?, ?, ?, ?)`,
      [ops, email, ROLES.SUPPORT, now, mfa ? "JBSWY3DPEHPK3PXP" : null, mfa ? now : null, now, now],
    );
  }

  outsider = app.session("mal@attacker.test");
  supportNoMfa = app.session("nomfa@platform.test");
  supportMfa = app.session("mfa@platform.test");
});

after(() => {
  app?.stop();
  fakeS3?.close();
  delete process.env.DOCUMENTS_S3_URL;
});

test("an unauthenticated visitor is sent to sign in and shown nothing", async () => {
  for (const path of ["/", "/carriers", "/reports", "/team", "/audit"]) {
    const res = await app.get(path);
    assert.equal(res.status, 307, `${path} redirects`);
    assert.match(res.location ?? "", /\/login/, `${path} redirects to /login`);
    assertNoVictimData(res.body, path);
  }
});

test("/support is invisible to a customer, and serves them nothing", async () => {
  for (const path of [
    "/support",
    `/support/${victimOrg}`,
    `/support/${victimOrg}/carriers/${victimCarrier}`,
    "/support/account",
  ]) {
    const res = await app.get(path, outsider);
    assert.equal(res.status, 404, `${path} is a 404 for an ordinary customer`);
    assertNoVictimData(res.body, path);
    // The tenant list leaks names even for organisations the caller has no carrier in.
    assert.ok(!res.body.includes("Attacker Dispatch"), `${path} did not render the tenant list`);
  }
});

test("a customer cannot write to the support access record by requesting a support page", async () => {
  const count = () =>
    app.db.systemQuery(
      () => app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM support_access_log")!.n,
    );
  const before = count();
  await app.get(`/support/${victimOrg}`, outsider);
  await app.get(`/support/${victimOrg}/carriers/${victimCarrier}`, outsider);
  assert.equal(count(), before, "a refused request must not land in the access record");
});

test("a support account without a second factor is sent to enrol and gets no data on the way", async () => {
  for (const path of ["/support", `/support/${victimOrg}`]) {
    const res = await app.get(path, supportNoMfa);
    assert.equal(res.status, 307, `${path} redirects`);
    assert.equal(res.location, "/support/account");
    assertNoVictimData(res.body, path);
  }
  const account = await app.get("/support/account", supportNoMfa);
  assert.equal(account.status, 200, "the enrolment page itself has to open");
});

test("a support account with a second factor sees the tenant, and the view is recorded", async () => {
  const before = app.db.systemQuery(
    () => app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM support_access_log")!.n,
  );

  const list = await app.get(`/support/${victimOrg}`, supportMfa);
  assert.equal(list.status, 200);
  assert.ok(list.body.includes("SECRET VICTIM CARRIER"), "the carrier is shown to support");

  const detail = await app.get(`/support/${victimOrg}/carriers/${victimCarrier}`, supportMfa);
  assert.equal(detail.status, 200);
  assert.ok(detail.body.includes("a confidential note"), "notes are shown to support");

  const rows = app.db.systemQuery(() =>
    app.db.all<{ path: string }>(
      "SELECT path FROM support_access_log ORDER BY id DESC LIMIT 2",
    ),
  );
  assert.equal(
    app.db.systemQuery(
      () => app.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM support_access_log")!.n,
    ),
    before + 2,
    "both views were recorded",
  );
  assert.deepEqual(
    rows.map((r) => r.path).sort(),
    [`/support/${victimOrg}`, `/support/${victimOrg}/carriers/${victimCarrier}`].sort(),
    "recorded against the path actually viewed",
  );
});

test("one tenant cannot open another tenant's carrier through the ordinary app", async () => {
  const res = await app.get(`/carriers/${victimCarrier}`, outsider);
  assert.equal(res.status, 404);
  assertNoVictimData(res.body, `/carriers/${victimCarrier}`);
});

test("the CSV exports refuse an unauthenticated caller", async () => {
  for (const path of ["/api/export", "/api/export/report?r=by_status"]) {
    const res = await app.get(path);
    assert.equal(res.status, 307, `${path} redirects rather than exporting`);
    assert.match(res.location ?? "", /\/login/);
  }
});

test("the document route refuses an unauthenticated caller", async () => {
  const res = await app.get("/api/documents/1");
  assert.equal(res.status, 307, "redirects rather than serving");
  assert.match(res.location ?? "", /\/login/);
});

test("one tenant cannot download another tenant's document", async () => {
  const now = new Date().toISOString();
  const { seedOrg, lookupId } = await import("../helpers.ts");
  const { Org } = await import("../../src/lib/tenant-db.ts");
  const owner = seedOrg(app.db, "Doc Owner Dispatch", "docowner@doctest.test");

  app.db.run(
    `INSERT INTO carriers (organization_id, legal_name, status_id, created_at, updated_at)
     VALUES (?, 'Doc Test Carrier', ?, ?, ?)`,
    [owner.id, lookupId(app.db, owner.id, "status", "active"), now, now],
  );
  const carrierId = app.db.get<{ id: number }>(
    "SELECT id FROM carriers WHERE organization_id = ?", [owner.id])!.id;
  const { createLoad } = await import("../../src/lib/load-write.ts");
  const loadResult = createLoad(new Org(owner.id), {
    carrierId, stops: [{ kind: "pickup", city: "Dallas" }, { kind: "delivery", city: "Newark" }],
  }, owner.ownerId) as { ok: true; id: number };

  app.db.run(
    `INSERT INTO load_documents
       (organization_id, load_id, kind, filename, storage_key, content_type, size_bytes, uploaded_by, created_at)
     VALUES (?, ?, 'pod', 'CONFIDENTIAL-POD.pdf', 'unused-key', 'application/pdf', 5, ?, ?)`,
    [owner.id, loadResult.id, owner.ownerId, now],
  );
  const documentId = app.db.get<{ id: number }>(
    "SELECT id FROM load_documents WHERE organization_id = ?", [owner.id])!.id;

  const res = await app.get(`/api/documents/${documentId}`, outsider);
  assert.equal(res.status, 404);
  assertNoVictimData(res.body, `/api/documents/${documentId}`);
  assert.ok(!res.body.includes("CONFIDENTIAL-POD"), "the filename never reaches an outsider either");
});

test("a legitimate load:view user downloads their own document, non-ASCII filename included", async () => {
  const now = new Date().toISOString();
  const { seedOrg, lookupId } = await import("../helpers.ts");
  const { Org } = await import("../../src/lib/tenant-db.ts");
  const owner = seedOrg(app.db, "Doc Download Dispatch", "docdownload@doctest.test");

  app.db.run(
    `INSERT INTO carriers (organization_id, legal_name, status_id, created_at, updated_at)
     VALUES (?, 'Download Test Carrier', ?, ?, ?)`,
    [owner.id, lookupId(app.db, owner.id, "status", "active"), now, now],
  );
  const carrierId = app.db.get<{ id: number }>(
    "SELECT id FROM carriers WHERE organization_id = ?", [owner.id])!.id;
  const { createLoad } = await import("../../src/lib/load-write.ts");
  const loadResult = createLoad(new Org(owner.id), {
    carrierId, stops: [{ kind: "pickup", city: "Dallas" }, { kind: "delivery", city: "Newark" }],
  }, owner.ownerId) as { ok: true; id: number };

  // A non-Latin-1 filename — exactly what made every download 500 before I2's fix, because
  // the Content-Disposition sanitiser only stripped control characters and let any
  // character above U+00FF straight through into the header.
  app.db.run(
    `INSERT INTO load_documents
       (organization_id, load_id, kind, filename, storage_key, content_type, size_bytes, uploaded_by, created_at)
     VALUES (?, ?, 'bol', '提单.pdf', 'unused-key', 'application/pdf', ?, ?, ?)`,
    [owner.id, loadResult.id, DOC_BODY.length, owner.ownerId, now],
  );
  const documentId = app.db.get<{ id: number }>(
    "SELECT id FROM load_documents WHERE organization_id = ?", [owner.id])!.id;

  const res = await app.get(`/api/documents/${documentId}`, app.session("docdownload@doctest.test"));
  assert.equal(res.status, 200, "a legitimate load:view user gets the document, not a 404 or 500");
  assert.equal(res.body, DOC_BODY, "the exact bytes the fake object store served");
});

test("the report export is rate-limited and every pull is recorded", async () => {
  const owner = app.session("vic@victim.test");
  const exported = () =>
    app.db.systemQuery(
      () =>
        app.db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'export.report'",
        )!.n,
    );
  const before = exported();

  const first = await app.get("/api/export/report?r=by_status", owner);
  assert.equal(first.status, 200);
  assert.match(first.body, /Status/, "a CSV came back");
  assert.equal(exported(), before + 1, "the pull was recorded");

  // EXPORT_RULE is 20/hour; the 21st in the window has to be refused.
  let refused = 0;
  for (let i = 0; i < 25; i++) {
    const res = await app.get("/api/export/report?r=by_plan", owner);
    if (res.status === 429) { refused = i; break; }
  }
  assert.ok(refused > 0, "the limit eventually refuses");
  assert.ok(exported() <= before + 20, "a refused export is not recorded as one");

  // Its own budget: spending the report allowance must not close the carrier export.
  assert.equal((await app.get("/api/export", owner)).status, 200);
});

test("an unauthenticated visitor is sent to sign in from every invoices route", async () => {
  for (const path of ["/invoices", "/invoices/new", `/invoices/1`]) {
    const res = await app.get(path);
    assert.equal(res.status, 307);
    assert.match(res.location ?? "", /\/login/);
  }
});

test("a dispatcher can view invoices but not create one", async () => {
  const now = new Date().toISOString();
  const { seedOrg } = await import("../helpers.ts");
  const { ROLES } = await import("../../src/lib/constants.ts");
  const owner = seedOrg(app.db, "Invoice Test Dispatch", "invowner@invtest.test");
  app.db.run(
    `INSERT INTO users (organization_id, name, email, password_hash, role, active,
                        email_verified_at, created_at, updated_at)
     VALUES (?, 'Dee Dispatcher', 'invdispatch@invtest.test', 'x', ?, 1, ?, ?, ?)`,
    [owner.id, ROLES.DISPATCHER, now, now, now],
  );
  const dispatcherSession = app.session("invdispatch@invtest.test");

  const list = await app.get("/invoices", dispatcherSession);
  assert.equal(list.status, 200, "invoice:view is universal to any non-sales, non-support role");

  const create = await app.get("/invoices/new", dispatcherSession);
  assert.equal(create.status, 307, "redirected away from the create screen — no dispatcher tier for invoicing");
  assert.match(create.location ?? "", /\/invoices$/);
});

test("an owner can reach the create screen", async () => {
  const { seedOrg } = await import("../helpers.ts");
  seedOrg(app.db, "Invoice Admin Dispatch", "invadmin@invtest.test");
  const res = await app.get("/invoices/new", app.session("invadmin@invtest.test"));
  assert.equal(res.status, 200);
});

test("one tenant cannot open another tenant's invoice", async () => {
  const now = new Date().toISOString();
  app.db.run(
    `INSERT INTO invoices (organization_id, invoice_type, carrier_id, status, issued_on,
                           total_amount, created_at, updated_at)
     VALUES (?, 'dispatch', ?, 'pending', ?, 500, ?, ?)`,
    [victimOrg, victimCarrier, now.slice(0, 10), now, now],
  );
  const invoiceId = app.db.systemQuery(
    () => app.db.get<{ id: number }>("SELECT id FROM invoices WHERE organization_id = ?", [victimOrg])!.id,
  );

  const res = await app.get(`/invoices/${invoiceId}`, outsider);
  assert.equal(res.status, 404);
  assertNoVictimData(res.body, `/invoices/${invoiceId}`);
});

// ── Role panels (Phase 16) ───────────────────────────────────────────────────

/**
 * The sidebar rendered over the wire, per role.
 *
 * `tests/nav.test.ts` pins `visibleNav()` in isolation; these assert what a browser
 * actually receives, which is the half that was wrong before Phase 16 — the filtering
 * lived in the component, so no unit test could have seen it.
 */
test("a sales agent's page carries no carrier, load or invoice link, and no carrier data", async () => {
  const now = new Date().toISOString();
  const { seedOrg, lookupId } = await import("../helpers.ts");
  const { ROLES } = await import("../../src/lib/constants.ts");
  const org = seedOrg(app.db, "Panel Test Dispatch", "panelowner@panel.test");
  app.db.run(
    `INSERT INTO carriers (organization_id, legal_name, owner_name, phone, mc_number,
                           status_id, created_at, updated_at)
     VALUES (?, 'PANEL SECRET CARRIER LLC', 'Panel Owner', '555222333', '888222', ?, ?, ?)`,
    [org.id, lookupId(app.db, org.id, "status", "active"), now, now],
  );
  app.db.run(
    `INSERT INTO users (organization_id, name, email, password_hash, role, active,
                        email_verified_at, created_at, updated_at)
     VALUES (?, 'Sal Sales', 'panelsales@panel.test', 'x', ?, 1, ?, ?, ?)`,
    [org.id, ROLES.SALES, now, now, now],
  );

  const res = await app.get("/", app.session("panelsales@panel.test"));
  assert.equal(res.status, 200, "sales reaches its own dashboard rather than an error");

  for (const href of ["/carriers", "/active", "/onboarding", "/loads", "/drivers",
                      "/brokers", "/invoices", "/reports", "/team", "/settings", "/import"]) {
    assert.ok(
      !res.body.includes(`href="${href}"`),
      `the sales sidebar must not link to ${href}`,
    );
  }
  assert.ok(res.body.includes('href="/activity"'), "sales still gets My Activity");
  assert.ok(res.body.includes('href="/leads"'), "sales gets the pipeline, which is its job");
  assert.ok(
    !res.body.includes("PANEL SECRET CARRIER LLC"),
    "the sales dashboard must not render carrier data",
  );
  assert.ok(!res.body.includes("Add Carrier"), "no Add Carrier button without carrier:create");
});

test("a dispatcher's sidebar keeps carriers and dispatch but drops Administration", async () => {
  const now = new Date().toISOString();
  const { seedOrg } = await import("../helpers.ts");
  const { ROLES } = await import("../../src/lib/constants.ts");
  const org = seedOrg(app.db, "Panel Dispatcher Co", "paneldispowner@panel.test");
  app.db.run(
    `INSERT INTO users (organization_id, name, email, password_hash, role, active,
                        email_verified_at, created_at, updated_at)
     VALUES (?, 'Dee Dispatcher', 'paneldisp@panel.test', 'x', ?, 1, ?, ?, ?)`,
    [org.id, ROLES.DISPATCHER, now, now, now],
  );

  const res = await app.get("/", app.session("paneldisp@panel.test"));
  assert.equal(res.status, 200);
  for (const href of ["/carriers", "/loads", "/brokers", "/invoices", "/reports", "/activity"]) {
    assert.ok(res.body.includes(`href="${href}"`), `dispatcher should see ${href}`);
  }
  for (const href of ["/leads", "/team", "/settings", "/import", "/audit"]) {
    assert.ok(!res.body.includes(`href="${href}"`), `dispatcher must not see ${href}`);
  }
});

// ── Leads (Phase 17) ─────────────────────────────────────────────────────────

/**
 * A sales rep's own pipeline, over the wire.
 *
 * The rule is that /leads is *queried* per owner, not filtered after the fact — so the
 * proof has to be that another rep's prospect never appears in the HTML at all. A test
 * against `listLeads` alone would pass even if the page rendered everything and hid the
 * rest with CSS.
 */
test("a sales rep's pipeline shows their own leads and never another rep's", async () => {
  const now = new Date().toISOString();
  const { seedOrg } = await import("../helpers.ts");
  const { ROLES } = await import("../../src/lib/constants.ts");
  const org = seedOrg(app.db, "Pipeline Panel Co", "pipeowner@panel.test");

  const addRep = (name: string, email: string) => {
    app.db.run(
      `INSERT INTO users (organization_id, name, email, password_hash, role, active,
                          email_verified_at, created_at, updated_at)
       VALUES (?, ?, ?, 'x', ?, 1, ?, ?, ?)`,
      [org.id, name, email, ROLES.SALES, now, now, now],
    );
    return app.db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
  };
  const mine = addRep("Pip Sales", "pipesales@panel.test");
  const theirs = addRep("Other Rep", "pipeother@panel.test");

  for (const [company, owner] of [["MY OWN PROSPECT LLC", mine], ["THEIR PROSPECT LLC", theirs]] as const) {
    app.db.run(
      `INSERT INTO leads (organization_id, company_name, status, owner_id, created_at, updated_at)
       VALUES (?, ?, 'new', ?, ?, ?)`,
      [org.id, company, owner, now, now],
    );
  }

  const res = await app.get("/leads", app.session("pipesales@panel.test"));
  assert.equal(res.status, 200);
  assert.ok(res.body.includes("MY OWN PROSPECT LLC"), "a rep sees their own lead");
  assert.ok(
    !res.body.includes("THEIR PROSPECT LLC"),
    "another rep's prospect must not reach the page at all",
  );
  assert.ok(!res.body.includes(">Convert<"), "sales is not offered conversion");

  // The owner runs the pipeline, so the same page shows both.
  const asOwner = await app.get("/leads", app.session("pipeowner@panel.test"));
  assert.equal(asOwner.status, 200);
  assert.ok(asOwner.body.includes("MY OWN PROSPECT LLC"));
  assert.ok(asOwner.body.includes("THEIR PROSPECT LLC"));
});

test("a dispatcher is turned away from the pipeline entirely", async () => {
  const now = new Date().toISOString();
  const { seedOrg } = await import("../helpers.ts");
  const { ROLES } = await import("../../src/lib/constants.ts");
  const org = seedOrg(app.db, "No Pipeline Co", "nopipeowner@panel.test");
  app.db.run(
    `INSERT INTO users (organization_id, name, email, password_hash, role, active,
                        email_verified_at, created_at, updated_at)
     VALUES (?, 'Dan Dispatch', 'nopipedisp@panel.test', 'x', ?, 1, ?, ?, ?)`,
    [org.id, ROLES.DISPATCHER, now, now, now],
  );
  app.db.run(
    `INSERT INTO leads (organization_id, company_name, status, created_at, updated_at)
     VALUES (?, 'DISPATCH MUST NOT SEE THIS LLC', 'new', ?, ?)`,
    [org.id, now, now],
  );

  const res = await app.get("/leads", app.session("nopipedisp@panel.test"));
  assert.ok(res.status === 307 || res.status === 302, `expected a redirect, got ${res.status}`);
  assert.ok(
    !res.body.includes("DISPATCH MUST NOT SEE THIS LLC"),
    "a redirect must not carry the data it is redirecting away from",
  );
});

// ── Tasks, announcements, alerts (Phase 18) ──────────────────────────────────

/**
 * The three screens on all three panels, over the wire.
 *
 * The rule that needs proving here is the one a unit test cannot see: a task belonging to
 * somebody else must not reach the page at all, and neither must the "Assign to" picker
 * for a role that may not assign — hiding either in the component is presentation, and
 * presentation was exactly what Phase 16 got wrong.
 */
test("a dispatcher's task list carries their own work and no one else's", async () => {
  const now = new Date().toISOString();
  const { seedOrg } = await import("../helpers.ts");
  const { ROLES } = await import("../../src/lib/constants.ts");
  const org = seedOrg(app.db, "Task Panel Co", "taskowner@panel.test");

  const addUser = (name: string, email: string, role: string) => {
    app.db.run(
      `INSERT INTO users (organization_id, name, email, password_hash, role, active,
                          email_verified_at, created_at, updated_at)
       VALUES (?, ?, ?, 'x', ?, 1, ?, ?, ?)`,
      [org.id, name, email, role, now, now, now],
    );
    return app.db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
  };
  const dispatcher = addUser("Tess Dispatch", "tasksdisp@panel.test", ROLES.DISPATCHER);
  const someoneElse = addUser("Not Tess", "tasksother@panel.test", ROLES.DISPATCHER);

  for (const [title, assignee] of [
    ["MY OWN TASK MARKER", dispatcher],
    ["SOMEBODY ELSES TASK MARKER", someoneElse],
  ] as const) {
    app.db.run(
      `INSERT INTO tasks (organization_id, title, assigned_to, status, priority,
                          created_at, created_by, updated_at, updated_by)
       VALUES (?, ?, ?, 'open', 'normal', ?, ?, ?, ?)`,
      [org.id, title, assignee, now, assignee, now, assignee],
    );
  }

  const res = await app.get("/tasks", app.session("tasksdisp@panel.test"));
  assert.equal(res.status, 200);
  assert.ok(res.body.includes("MY OWN TASK MARKER"), "a person sees their own task");
  assert.ok(
    !res.body.includes("SOMEBODY ELSES TASK MARKER"),
    "another person's task must not reach the page at all",
  );
  assert.ok(
    !res.body.includes('name="assigned_to"'),
    "a role without task:assign is not served the assignment picker",
  );

  // The owner may assign, so the same page is the whole board and does carry the picker.
  const asOwner = await app.get("/tasks", app.session("taskowner@panel.test"));
  assert.equal(asOwner.status, 200);
  assert.ok(asOwner.body.includes("MY OWN TASK MARKER"));
  assert.ok(asOwner.body.includes("SOMEBODY ELSES TASK MARKER"));
  assert.ok(asOwner.body.includes('name="assigned_to"'), "an administrator can hand work out");
});

test("the noticeboard is readable by everyone and writable by administrators only", async () => {
  const now = new Date().toISOString();
  const { seedOrg } = await import("../helpers.ts");
  const { ROLES } = await import("../../src/lib/constants.ts");
  const org = seedOrg(app.db, "Notice Panel Co", "noticeowner@panel.test");
  app.db.run(
    `INSERT INTO users (organization_id, name, email, password_hash, role, active,
                        email_verified_at, created_at, updated_at)
     VALUES (?, 'Sal Notice', 'noticesales@panel.test', 'x', ?, 1, ?, ?, ?)`,
    [org.id, ROLES.SALES, now, now, now],
  );
  app.db.run(
    `INSERT INTO announcements (organization_id, title, body, published_at, created_at, updated_at)
     VALUES (?, 'DEPOT MOVE NOTICE', 'We are moving on Monday.', ?, ?, ?)`,
    [org.id, now, now, now],
  );

  const asSales = await app.get("/announcements", app.session("noticesales@panel.test"));
  assert.equal(asSales.status, 200);
  assert.ok(asSales.body.includes("DEPOT MOVE NOTICE"), "everybody reads the noticeboard");
  assert.ok(
    !asSales.body.includes("Post announcement"),
    "a role without announcement:manage is offered no way to post",
  );

  const asOwner = await app.get("/announcements", app.session("noticeowner@panel.test"));
  assert.ok(asOwner.body.includes("Post announcement"), "an administrator can post");
});

test("alerts compose only what the reader may already see", async () => {
  const now = new Date().toISOString();
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  const { seedOrg, lookupId } = await import("../helpers.ts");
  const { ROLES } = await import("../../src/lib/constants.ts");
  const org = seedOrg(app.db, "Alert Panel Co", "alertowner@panel.test");
  app.db.run(
    `INSERT INTO carriers (organization_id, legal_name, status_id, created_at, updated_at)
     VALUES (?, 'ALERT SECRET CARRIER LLC', ?, ?, ?)`,
    [org.id, lookupId(app.db, org.id, "status", "active"), now, now],
  );
  app.db.run(
    `INSERT INTO users (organization_id, name, email, password_hash, role, active,
                        email_verified_at, created_at, updated_at)
     VALUES (?, 'Sal Alert', 'alertsales@panel.test', 'x', ?, 1, ?, ?, ?)`,
    [org.id, ROLES.SALES, now, now, now],
  );
  const salesId = app.db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
  app.db.run(
    `INSERT INTO tasks (organization_id, title, assigned_to, due_on, status, priority,
                        created_at, created_by, updated_at, updated_by)
     VALUES (?, 'SALES OVERDUE MARKER', ?, ?, 'open', 'high', ?, ?, ?, ?)`,
    [org.id, salesId, yesterday, now, salesId, now, salesId],
  );

  const asSales = await app.get("/alerts", app.session("alertsales@panel.test"));
  assert.equal(asSales.status, 200);
  assert.ok(asSales.body.includes("SALES OVERDUE MARKER"), "their own overdue task is an alert");
  assert.ok(
    !asSales.body.includes("ALERT SECRET CARRIER LLC"),
    "the carrier queue is not run at all for a role without carrier:view",
  );

  // The owner sees both halves — the carrier queue and the team's overdue work.
  const asOwner = await app.get("/alerts", app.session("alertowner@panel.test"));
  assert.equal(asOwner.status, 200);
  assert.ok(asOwner.body.includes("ALERT SECRET CARRIER LLC"));
  assert.ok(asOwner.body.includes("SALES OVERDUE MARKER"));
});

// ── Communication (Phase 19) ─────────────────────────────────────────────────

/**
 * The audience boundary over the wire.
 *
 * The list is narrowed in SQL, so another team's messages must not be in the HTML at all
 * — not hidden, not collapsed, absent. And asking for that channel by id has to answer
 * the same way as asking for one that does not exist, or the URL becomes a way to learn
 * what channels a company has.
 */
test("a sales rep's channels exclude the dispatch room, by id as well as by list", async () => {
  const now = new Date().toISOString();
  const { seedOrg } = await import("../helpers.ts");
  const { ROLES } = await import("../../src/lib/constants.ts");
  const org = seedOrg(app.db, "Comms Panel Co", "commsowner@panel.test");
  app.db.run(
    `INSERT INTO users (organization_id, name, email, password_hash, role, active,
                        email_verified_at, created_at, updated_at)
     VALUES (?, 'Sal Comms', 'commssales@panel.test', 'x', ?, 1, ?, ?, ?)`,
    [org.id, ROLES.SALES, now, now, now],
  );

  const channelId = (name: string) =>
    app.db.get<{ id: number }>(
      "SELECT id FROM channels WHERE organization_id = ? AND name = ?",
      [org.id, name],
    )!.id;
  const dispatch = channelId("Dispatch Team");
  const general = channelId("General");

  app.db.run(
    `INSERT INTO messages (organization_id, channel_id, body, author_id, created_at)
     VALUES (?, ?, 'DISPATCH ONLY MARKER', ?, ?)`,
    [org.id, dispatch, org.ownerId, now],
  );
  app.db.run(
    `INSERT INTO messages (organization_id, channel_id, body, author_id, created_at)
     VALUES (?, ?, 'EVERYONE MARKER', ?, ?)`,
    [org.id, general, org.ownerId, now],
  );

  const sales = app.session("commssales@panel.test");

  const listed = await app.get("/communication", sales);
  assert.equal(listed.status, 200);
  assert.ok(listed.body.includes("Sales Team"), "their own team room is listed");
  assert.ok(!listed.body.includes("Dispatch Team"), "another team's room is not even named");
  assert.ok(!listed.body.includes("DISPATCH ONLY MARKER"));

  // Asking for it by id: the redirect must not carry the content it is redirecting from.
  const byId = await app.get(`/communication?channel=${dispatch}`, sales);
  assert.ok(
    byId.status === 200 || byId.status === 307 || byId.status === 302,
    `unexpected status ${byId.status}`,
  );
  assert.ok(
    !byId.body.includes("DISPATCH ONLY MARKER"),
    "requesting another team's channel by id must serve none of it",
  );

  // The owner is in every room, which is what makes the audience column enough.
  const asOwner = await app.get(`/communication?channel=${dispatch}`, app.session("commsowner@panel.test"));
  assert.equal(asOwner.status, 200);
  assert.ok(asOwner.body.includes("DISPATCH ONLY MARKER"));
});

test("only an administrator is offered a way to open a channel", async () => {
  const now = new Date().toISOString();
  const { seedOrg } = await import("../helpers.ts");
  const { ROLES } = await import("../../src/lib/constants.ts");
  const org = seedOrg(app.db, "Channel Admin Co", "chanowner@panel.test");
  app.db.run(
    `INSERT INTO users (organization_id, name, email, password_hash, role, active,
                        email_verified_at, created_at, updated_at)
     VALUES (?, 'Dee Chan', 'chandisp@panel.test', 'x', ?, 1, ?, ?, ?)`,
    [org.id, ROLES.DISPATCHER, now, now, now],
  );

  const asDispatcher = await app.get("/communication", app.session("chandisp@panel.test"));
  assert.equal(asDispatcher.status, 200);
  assert.ok(!asDispatcher.body.includes("New channel"), "no channel:manage, no button");
  assert.ok(!asDispatcher.body.includes('name="audience"'), "and no audience picker either");

  const asOwner = await app.get("/communication", app.session("chanowner@panel.test"));
  assert.ok(asOwner.body.includes("New channel"));
});

// ── Brokers Do Not Use (Phase 20) ────────────────────────────────────────────

/**
 * The DNU flag on the two screens that matter.
 *
 * A unit test proves `createLoad` refuses one. What it cannot see is whether the load
 * form still *offers* the broker — and offering a choice the server will reject is how a
 * dispatcher ends up adding a duplicate under a different spelling. It has to be present,
 * marked, and unselectable.
 */
test("a flagged broker stays in the load form, marked and unselectable", async () => {
  const now = new Date().toISOString();
  const { seedOrg, lookupId } = await import("../helpers.ts");
  const { ROLES } = await import("../../src/lib/constants.ts");
  const org = seedOrg(app.db, "DNU Panel Co", "dnuowner@panel.test");
  app.db.run(
    `INSERT INTO carriers (organization_id, legal_name, status_id, created_at, updated_at)
     VALUES (?, 'DNU Test Carrier', ?, ?, ?)`,
    [org.id, lookupId(app.db, org.id, "status", "active"), now, now],
  );
  app.db.run(
    `INSERT INTO users (organization_id, name, email, password_hash, role, active,
                        email_verified_at, created_at, updated_at)
     VALUES (?, 'Dee DNU', 'dnudisp@panel.test', 'x', ?, 1, ?, ?, ?)`,
    [org.id, ROLES.DISPATCHER, now, now, now],
  );
  app.db.run(
    `INSERT INTO brokers (organization_id, name, seeded, active, dnu, dnu_reason, dnu_at, created_at)
     VALUES (?, 'BLOCKED BROKER MARKER', 0, 1, 1, 'Did not pay on three loads.', ?, ?)`,
    [org.id, now, now],
  );

  const form = await app.get("/loads/new", app.session("dnudisp@panel.test"));
  assert.equal(form.status, 200);
  assert.ok(
    form.body.includes("BLOCKED BROKER MARKER"),
    "the broker is still listed — a name that silently vanishes teaches nobody why",
  );
  assert.ok(form.body.includes("DO NOT USE"), "and it is labelled as such");
  // The option carries `disabled`, so the browser will not let it be chosen. The server
  // refuses it regardless; this is the half that explains rather than the half that guards.
  const option = form.body.match(/<option[^>]*>[^<]*BLOCKED BROKER MARKER[^<]*<\/option>/)?.[0] ?? "";
  assert.ok(option.includes("disabled"), `expected a disabled option, got: ${option}`);
});

test("the Do Not Use list is on the brokers page, with its reason", async () => {
  const now = new Date().toISOString();
  const { seedOrg } = await import("../helpers.ts");
  const org = seedOrg(app.db, "DNU List Co", "dnulistowner@panel.test");
  app.db.run(
    `INSERT INTO brokers (organization_id, name, seeded, active, dnu, dnu_reason, dnu_at, dnu_by, created_at)
     VALUES (?, 'LISTED BROKER MARKER', 0, 1, 1, 'REASON MARKER: disputed detention.', ?, ?, ?)`,
    [org.id, now, org.ownerId, now],
  );

  const res = await app.get("/brokers", app.session("dnulistowner@panel.test"));
  assert.equal(res.status, 200);
  assert.ok(res.body.includes("Do Not Use"), "the section is there");
  assert.ok(res.body.includes("LISTED BROKER MARKER"));
  assert.ok(res.body.includes("REASON MARKER"), "carrying the reason, which is the point");
});

test("My Activity is reachable by every role and shows only that user's own entries", async () => {
  const now = new Date().toISOString();
  const { seedOrg, lookupId } = await import("../helpers.ts");
  const { ROLES } = await import("../../src/lib/constants.ts");
  const org = seedOrg(app.db, "Activity Panel Co", "actowner@panel.test");
  app.db.run(
    `INSERT INTO carriers (organization_id, legal_name, owner_name, phone, mc_number,
                           status_id, created_at, updated_at)
     VALUES (?, 'ACTIVITY CARRIER LLC', 'A Owner', '555444555', '777333', ?, ?, ?)`,
    [org.id, lookupId(app.db, org.id, "status", "active"), now, now],
  );
  const carrierId = app.db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
  app.db.run(
    `INSERT INTO users (organization_id, name, email, password_hash, role, active,
                        email_verified_at, created_at, updated_at)
     VALUES (?, 'Ann Other', 'actother@panel.test', 'x', ?, 1, ?, ?, ?)`,
    [org.id, ROLES.DISPATCHER, now, now, now],
  );
  const otherId = app.db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;

  // One entry by the owner, one by somebody else. Only the owner's may come back.
  app.db.run(
    `INSERT INTO carrier_activity (organization_id, carrier_id, user_id, type, summary, created_at)
     VALUES (?, ?, ?, 'field', 'OWNS THIS ENTRY', ?)`,
    [org.id, carrierId, org.ownerId, now],
  );
  app.db.run(
    `INSERT INTO carrier_activity (organization_id, carrier_id, user_id, type, summary, created_at)
     VALUES (?, ?, ?, 'field', 'SOMEBODY ELSES ENTRY', ?)`,
    [org.id, carrierId, otherId, now],
  );

  const res = await app.get("/activity", app.session("actowner@panel.test"));
  assert.equal(res.status, 200);
  assert.ok(res.body.includes("OWNS THIS ENTRY"), "the user's own entry is shown");
  assert.ok(
    !res.body.includes("SOMEBODY ELSES ENTRY"),
    "My Activity is self-scoped — another user's entry must never appear",
  );
});
