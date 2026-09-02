/**
 * Ending a tenancy.
 *
 * The assertion that matters is not "the organisation is gone" — it is that the tenant
 * *next door* is untouched. A deletion that reaches one row too far is the same class of
 * failure as a query that reads one row too far, and this is the only operation in the
 * product that deletes across nine tables at once.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { seedOrg, lookupId, type TestOrg } from "./helpers.ts";

const DB = path.join(tmpdir(), `carrier-hub-lifecycle-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let life: typeof import("../src/lib/tenant-lifecycle.ts");
let write: typeof import("../src/lib/load-write.ts");
let leaving: TestOrg;
let staying: TestOrg;

before(async () => {
  db = await import("../src/lib/db.ts");
  life = await import("../src/lib/tenant-lifecycle.ts");
  write = await import("../src/lib/load-write.ts");
  const { Org } = await import("../src/lib/tenant-db.ts");
  const now = new Date().toISOString();

  leaving = seedOrg(db, "Leaving Freight", "owner@leaving.test");
  staying = seedOrg(db, "Staying Freight", "owner@staying.test");

  for (const [org, name] of [[leaving, "Leaving Carrier"], [staying, "Staying Carrier"]] as const) {
    db.run(
      `INSERT INTO carriers (organization_id, legal_name, status_id, dispatcher_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [org.id, name, lookupId(db, org.id, "status", "active"), org.ownerId, now, now],
    );
    const carrierId = db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
    db.run(
      `INSERT INTO carrier_notes (organization_id, carrier_id, user_id, body, pinned, created_at)
       VALUES (?, ?, ?, 'a note', 0, ?)`,
      [org.id, carrierId, org.ownerId, now],
    );
    db.run(
      `INSERT INTO carrier_activity (organization_id, carrier_id, user_id, type, summary, created_at)
       VALUES (?, ?, ?, 'created', 'Carrier record created', ?)`,
      [org.id, carrierId, org.ownerId, now],
    );
    db.run(
      `INSERT INTO offboarding_records (organization_id, carrier_id, offboarded_on, created_at)
       VALUES (?, ?, '2026-02-02', ?)`,
      [org.id, carrierId, now],
    );
    db.run(
      `INSERT INTO saved_filters (organization_id, user_id, name, query, shared, created_at)
       VALUES (?, ?, 'A view', '?status=1', 0, ?)`,
      [org.id, org.ownerId, now],
    );
    db.run(
      `INSERT INTO audit_log (organization_id, user_id, actor, action, created_at)
       VALUES (?, ?, 'someone@x.test', 'signin.success', ?)`,
      [org.id, org.ownerId, now],
    );
    db.run("INSERT INTO sessions (id, user_id, created_at, expires_at, mfa_pending) VALUES (?, ?, ?, ?, 0)", [
      `sess-${org.id}`, org.ownerId, now, new Date(Date.now() + 86_400_000).toISOString(),
    ]);

    // A load and a document on it — load_documents is the table I1 found missing from
    // tenant-lifecycle.ts. Without a row here, the drift guard could pass while deletion
    // and export were both still silently wrong for it.
    const loadResult = write.createLoad(new Org(org.id), {
      carrierId, stops: [{ kind: "pickup", city: "Dallas" }, { kind: "delivery", city: "Newark" }],
    }, org.ownerId) as { ok: true; id: number };
    db.run(
      `INSERT INTO load_documents
         (organization_id, load_id, kind, filename, storage_key, content_type, size_bytes, uploaded_by, created_at)
       VALUES (?, ?, 'pod', 'proof.pdf', 'unused-key', 'application/pdf', 5, ?, ?)`,
      [org.id, loadResult.id, org.ownerId, now],
    );

    // Same reasoning, for the invoicing tables migration 17 added: a fixture with no rows
    // in load_adjustments/invoices/invoice_lines would let the drift guard below pass while
    // deletion or export were silently wrong for any of the three, the same way I1 slipped
    // through for load_documents.
    db.run(
      `INSERT INTO load_adjustments (organization_id, load_id, kind, description, amount, created_at, created_by)
       VALUES (?, ?, 'extra_pay', 'Detention', 150, ?, ?)`,
      [org.id, loadResult.id, now, org.ownerId],
    );
    db.run(
      `INSERT INTO invoices (organization_id, invoice_type, carrier_id, status, issued_on, total_amount, created_at, created_by, updated_at, updated_by)
       VALUES (?, 'dispatch', ?, 'pending', ?, 15, ?, ?, ?, ?)`,
      [org.id, carrierId, now.slice(0, 10), now, org.ownerId, now, org.ownerId],
    );
    const invoiceId = db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
    db.run(
      `INSERT INTO invoice_lines (organization_id, invoice_id, load_id, final_load_amount, fee_basis, fee_rate, amount, created_at)
       VALUES (?, ?, ?, 150, 'flat', 15, 15, ?)`,
      [org.id, invoiceId, loadResult.id, now],
    );
  }
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

test("the export carries the data and never the secrets", () => {
  db.run("UPDATE users SET password_hash = 'super-secret-hash', mfa_secret = 'SECRETSEED' WHERE organization_id = ?",
    [leaving.id]);

  const bundle = life.exportOrganization(leaving.id);
  assert.equal(bundle.organization.name, "Leaving Freight");
  assert.equal(bundle.counts.carriers, 1);
  assert.equal(bundle.counts.carrier_notes, 1);
  assert.equal(bundle.counts.users, 1);

  const serialised = JSON.stringify(bundle);
  assert.ok(!serialised.includes("super-secret-hash"), "no password hash in the export");
  assert.ok(!serialised.includes("SECRETSEED"), "no two-factor secret in the export");
  assert.ok(serialised.includes("Leaving Carrier"), "but the actual data is there");
  assert.ok(!serialised.includes("Staying Carrier"), "and only this tenant's");
});

test("deletion refuses without an export, because the audit rows go with it", () => {
  assert.throws(
    () => life.deleteOrganization(leaving.id, { exported: false }),
    /Refusing to delete without an export/,
  );
  assert.ok(
    db.systemQuery(() => db.get("SELECT 1 FROM organizations WHERE id = ?", [leaving.id])),
    "still there",
  );
});

test("deletion refuses to take platform support accounts with it", async () => {
  const { ROLES } = await import("../src/lib/constants.ts");
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO users (organization_id, name, email, password_hash, role, active,
                        email_verified_at, created_at, updated_at)
     VALUES (?, 'Sam Support', 'sam@platform.test', 'x', ?, 1, ?, ?, ?)`,
    [leaving.id, ROLES.SUPPORT, now, now, now],
  );
  assert.throws(
    () => life.deleteOrganization(leaving.id, { exported: true }),
    /platform support account/,
  );
  db.run("DELETE FROM users WHERE organization_id = ? AND role = ?", [leaving.id, ROLES.SUPPORT]);
});

test("deleting one tenant leaves the one next door completely intact", () => {
  const countFor = (orgId: number) =>
    Object.fromEntries(
      ["users", "lookups", "app_settings", "carriers", "carrier_notes", "carrier_activity",
       "offboarding_records", "saved_filters", "audit_log", "loads", "load_documents",
       "load_adjustments", "invoices", "invoice_lines"].map((t) => [
        t,
        db.systemQuery(
          () => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${t} WHERE organization_id = ?`, [orgId])!.n,
        ),
      ]),
    );

  const neighbourBefore = countFor(staying.id);
  assert.ok(neighbourBefore.carriers > 0, "the neighbour has data to lose");

  life.deleteOrganization(leaving.id, { exported: true });

  assert.equal(
    db.systemQuery(() => db.get("SELECT 1 FROM organizations WHERE id = ?", [leaving.id])),
    undefined,
    "the organisation is gone",
  );
  for (const [table, n] of Object.entries(countFor(leaving.id))) {
    assert.equal(n, 0, `${table} has nothing left for the deleted tenant`);
  }
  assert.deepEqual(countFor(staying.id), neighbourBefore, "the neighbour is untouched");

  // Cascades, which the counts above cannot see.
  assert.equal(
    db.systemQuery(() => db.get("SELECT 1 FROM sessions WHERE id = ?", [`sess-${leaving.id}`])),
    undefined,
    "their sessions went too — nobody stays signed in to a deleted tenant",
  );
  assert.ok(
    db.systemQuery(() => db.get("SELECT 1 FROM sessions WHERE id = ?", [`sess-${staying.id}`])),
    "the neighbour's session survived",
  );
  assert.deepEqual(
    db.systemQuery(() => db.all("PRAGMA foreign_key_check")),
    [],
    "nothing is left pointing at what was removed",
  );
});

test("every tenant-owned table is exported and deleted with the tenant", async () => {
  // Nothing else ties OWNED to TENANT_TABLES — the source of truth the fail-closed query
  // guard already uses. Migration 15 added four tables and updated OWNED for all of them;
  // migration 16 added load_documents and updated neither (see BUGS.md, I1). This is the
  // guard that stops the next migration from repeating it silently.
  const { TENANT_TABLES } = await import("../src/lib/tenant-db.ts");
  for (const t of TENANT_TABLES) {
    assert.ok(life.OWNED.includes(t), `${t} is missing from tenant-lifecycle.ts's OWNED`);
  }
});
