/**
 * Working Notes — a private scratchpad on the reader's own user row.
 *
 * The only rule that matters: the session names whose notes these are, and there is no
 * path that takes an id from anywhere else. A column on `users` makes that structural
 * rather than a thing to remember — every query below is keyed on organisation *and*
 * user, so one person's page cannot reach another's even inside the same tenant.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { seedOrg, type TestOrg } from "./helpers.ts";

const DB = path.join(tmpdir(), `carrier-hub-notes-${process.pid}.db`);
for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let notes: typeof import("../src/lib/working-notes.ts");
let alpha: TestOrg;
let beta: TestOrg;
let org: import("../src/lib/tenant-db.ts").Org;
let betaOrg: import("../src/lib/tenant-db.ts").Org;
let colleague: number;

before(async () => {
  db = await import("../src/lib/db.ts");
  notes = await import("../src/lib/working-notes.ts");
  const { Org } = await import("../src/lib/tenant-db.ts");
  const { ROLES } = await import("../src/lib/constants.ts");

  alpha = seedOrg(db, "Alpha Notes");
  beta = seedOrg(db, "Beta Notes");
  org = new Org(alpha.id);
  betaOrg = new Org(beta.id);

  const now = new Date().toISOString();
  db.run(
    `INSERT INTO users (organization_id, name, email, password_hash, role, active, created_at, updated_at)
     VALUES (?, 'Colleague', 'colleague@notes.test', 'x', ?, 1, ?, ?)`,
    [alpha.id, ROLES.DISPATCHER, now, now],
  );
  colleague = db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

test("a person who has never written anything gets an empty page, not a null", () => {
  const page = notes.workingNotes(org, colleague);
  assert.equal(page.body, "");
  assert.equal(page.savedAt, null);
});

test("what was written is what comes back, and the save is timestamped", () => {
  const before = new Date().toISOString();
  assert.deepEqual(notes.saveWorkingNotes(org, alpha.ownerId, "  Call Reliable at 4  "), { ok: true });

  const page = notes.workingNotes(org, alpha.ownerId);
  // Trimmed at the edges, untouched in the middle — this is prose, not a field.
  assert.equal(page.body, "Call Reliable at 4");
  assert.ok(page.savedAt !== null && page.savedAt >= before);
});

test("newlines and punctuation survive a round trip", () => {
  const text = "Lanes:\n  - Dallas → Memphis, 2.10/mi\n  - \"ask about detention\"\n\t50%% margin?";
  notes.saveWorkingNotes(org, alpha.ownerId, text);
  assert.equal(notes.workingNotes(org, alpha.ownerId).body, text);
});

test("clearing the page is the same as never having written one", () => {
  notes.saveWorkingNotes(org, alpha.ownerId, "something");
  notes.saveWorkingNotes(org, alpha.ownerId, "   ");
  assert.equal(notes.workingNotes(org, alpha.ownerId).body, "");
  // Stored as NULL, so "cleared" and "never written" are genuinely the same state rather
  // than two that a later query would have to tell apart.
  const raw = db.get<{ working_notes: string | null }>(
    "SELECT working_notes FROM users WHERE organization_id = ? AND id = ?",
    [alpha.id, alpha.ownerId],
  )!;
  assert.equal(raw.working_notes, null);
});

test("one person's page is never another's, inside a tenant or across one", () => {
  notes.saveWorkingNotes(org, alpha.ownerId, "OWNER PRIVATE");
  notes.saveWorkingNotes(org, colleague, "COLLEAGUE PRIVATE");

  assert.equal(notes.workingNotes(org, alpha.ownerId).body, "OWNER PRIVATE");
  assert.equal(notes.workingNotes(org, colleague).body, "COLLEAGUE PRIVATE");

  // The other tenant's owner has the same kind of row and none of this text. Asking for
  // an id that belongs to a different organisation returns nothing at all, rather than
  // that organisation's notes.
  assert.equal(notes.workingNotes(betaOrg, alpha.ownerId).body, "");
  assert.equal(notes.workingNotes(betaOrg, beta.ownerId).body, "");
});

test("a write cannot cross a tenant either", () => {
  notes.saveWorkingNotes(org, alpha.ownerId, "STILL MINE");
  // Alpha's owner id, but Beta's handle: the UPDATE matches no row and nothing happens.
  notes.saveWorkingNotes(betaOrg, alpha.ownerId, "WRITTEN FROM NEXT DOOR");
  assert.equal(notes.workingNotes(org, alpha.ownerId).body, "STILL MINE");
});

test("an absurd paste is refused rather than stored", () => {
  const huge = "x".repeat(notes.WORKING_NOTES_MAX + 1);
  const result = notes.saveWorkingNotes(org, colleague, huge);
  assert.equal(result.ok, false);
  // And the refusal left the previous page alone.
  assert.equal(notes.workingNotes(org, colleague).body, "COLLEAGUE PRIVATE");
  // The limit itself is allowed — the boundary is not off by one.
  assert.deepEqual(notes.saveWorkingNotes(org, colleague, "y".repeat(notes.WORKING_NOTES_MAX)), { ok: true });
});
