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
