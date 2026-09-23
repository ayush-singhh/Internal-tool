/**
 * The gate on the whole public surface.
 *
 * `portalFor` is the only thing standing between a URL anyone can guess and an
 * organisation's onboarding form, so the property that matters is that it fails closed:
 * every way of not being explicitly open produces the same nothing.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { seedOrg, type TestOrg } from "./helpers.ts";

const DB = path.join(tmpdir(), `carrier-hub-portal-${process.pid}.db`);
for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let portal: typeof import("../src/lib/portal.ts");
let org: TestOrg;
let slug: string;

before(async () => {
  db = await import("../src/lib/db.ts");
  portal = await import("../src/lib/portal.ts");
  org = seedOrg(db, "Asterism Services");
  slug = db.systemQuery(() =>
    db.get<{ slug: string }>("SELECT slug FROM organizations WHERE id = ?", [org.id])!.slug);
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

const setPortal = (value: string | null) => {
  if (value === null) {
    db.run("DELETE FROM app_settings WHERE organization_id = ? AND key = 'portal_open'", [org.id]);
    return;
  }
  db.run(
    `INSERT INTO app_settings (organization_id, key, value) VALUES (?, 'portal_open', ?)
     ON CONFLICT (organization_id, key) DO UPDATE SET value = excluded.value`,
    [org.id, value],
  );
};

test("an organisation with no portal setting at all has no portal", () => {
  setPortal(null);
  // Every organisation that predates this feature is in exactly this state. None of them
  // may acquire a public signup form by being upgraded.
  assert.equal(portal.portalFor(slug), null);
});

test("an explicitly closed portal is closed", () => {
  setPortal("0");
  assert.equal(portal.portalFor(slug), null);
});

test("anything other than exactly '1' is closed", () => {
  for (const value of ["true", "yes", "open", "2", "", " 1"]) {
    setPortal(value);
    assert.equal(portal.portalFor(slug), null, `"${value}" must not open the portal`);
  }
});

test("an open portal resolves to its organisation", () => {
  setPortal("1");
  const found = portal.portalFor(slug);
  assert.ok(found);
  assert.equal(found.org.id, org.id);
  assert.equal(found.orgName, "Asterism Services");
  assert.equal(found.slug, slug);
});

test("a slug nobody owns is the same nothing as a closed portal", () => {
  setPortal("1");
  // Identical results are the point: the URL must not reveal which companies exist here.
  assert.equal(portal.portalFor("no-such-company"), null);
  assert.equal(portal.portalFor(""), null);
});

test("a suspended organisation's portal closes with it", () => {
  setPortal("1");
  db.systemQuery(() =>
    db.run("UPDATE organizations SET status = 'suspended' WHERE id = ?", [org.id]));
  assert.equal(portal.portalFor(slug), null, "an inactive tenant takes no applications");
  db.systemQuery(() =>
    db.run("UPDATE organizations SET status = 'active' WHERE id = ?", [org.id]));
  assert.ok(portal.portalFor(slug));
});
