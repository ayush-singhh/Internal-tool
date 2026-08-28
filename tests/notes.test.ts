import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A throwaway database per run — tests never touch data/carrier-hub.db.
const DB = path.join(tmpdir(), `carrier-hub-notes-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;

type Db = typeof import("../src/lib/db.ts");
type Notes = typeof import("../src/lib/notes.ts");

let db: Db;
let notes: Notes;
let carrierId: number;

before(async () => {
  db = await import("../src/lib/db.ts");
  notes = await import("../src/lib/notes.ts");
  const statusId = db.get<{ id: number }>(
    "SELECT id FROM lookups WHERE kind = 'status' AND value = 'active'",
  )!.id;
  db.run(
    `INSERT INTO carriers (legal_name, status_id, created_at, updated_at)
     VALUES ('Fixture Carrier', ?, ?, ?)`,
    [statusId, new Date().toISOString(), new Date().toISOString()],
  );
  carrierId = db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
});

after(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB}${suffix}`, { force: true });
});

test("stores a note with author attribution", () => {
  const result = notes.createNote({ carrierId, userId: 1, body: "  Called the owner.  " });
  assert.deepEqual(result, { ok: true });

  const row = db.get<{ body: string; user_id: number; pinned: number }>(
    "SELECT body, user_id, pinned FROM carrier_notes WHERE carrier_id = ? ORDER BY id DESC",
    [carrierId],
  )!;
  assert.equal(row.body, "Called the owner.", "body is trimmed");
  assert.equal(row.user_id, 1);
  assert.equal(row.pinned, 0);
});

test("a routine note does not clutter the activity timeline", () => {
  const before_ = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM carrier_activity WHERE carrier_id = ?", [carrierId],
  )!.n;
  notes.createNote({ carrierId, userId: 1, body: "Routine check-in." });
  const after_ = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM carrier_activity WHERE carrier_id = ?", [carrierId],
  )!.n;
  assert.equal(after_, before_);
});

test("an important note is pinned and recorded in activity", () => {
  notes.createNote({
    carrierId, userId: 1, important: true, body: "Insurance lapses next month.",
  });

  const note = db.get<{ pinned: number }>(
    "SELECT pinned FROM carrier_notes WHERE carrier_id = ? ORDER BY id DESC", [carrierId],
  )!;
  assert.equal(note.pinned, 1);

  const activity = db.get<{ type: string; summary: string; user_id: number }>(
    "SELECT type, summary, user_id FROM carrier_activity WHERE carrier_id = ? ORDER BY id DESC",
    [carrierId],
  )!;
  assert.equal(activity.type, "note");
  assert.equal(activity.user_id, 1);
  assert.match(activity.summary, /Insurance lapses next month\./);
});

test("rejects an empty body and an unknown carrier", () => {
  assert.deepEqual(notes.createNote({ carrierId, userId: 1, body: "   " }), {
    ok: false, error: "Write something before saving the note.",
  });
  assert.deepEqual(notes.createNote({ carrierId: 999999, userId: 1, body: "hi" }), {
    ok: false, error: "Unknown carrier.",
  });
});

test("long notes are truncated rather than rejected", () => {
  notes.createNote({ carrierId, userId: 1, body: "x".repeat(notes.MAX_NOTE + 500) });
  const row = db.get<{ body: string }>(
    "SELECT body FROM carrier_notes WHERE carrier_id = ? ORDER BY id DESC", [carrierId],
  )!;
  assert.equal(row.body.length, notes.MAX_NOTE);
});

test("a note cannot be attributed to a user who does not exist", () => {
  assert.throws(
    () => notes.createNote({ carrierId, userId: 4242, body: "Ghost author." }),
    /FOREIGN KEY constraint failed/,
  );
});

test("pin toggles both ways and reports the carrier to revalidate", () => {
  notes.createNote({ carrierId, userId: 1, body: "Toggle me." });
  const id = db.get<{ id: number }>(
    "SELECT id FROM carrier_notes WHERE carrier_id = ? ORDER BY id DESC", [carrierId],
  )!.id;

  assert.equal(notes.toggleNotePin(id), carrierId);
  assert.equal(db.get<{ pinned: number }>("SELECT pinned FROM carrier_notes WHERE id = ?", [id])!.pinned, 1);
  assert.equal(notes.toggleNotePin(id), carrierId);
  assert.equal(db.get<{ pinned: number }>("SELECT pinned FROM carrier_notes WHERE id = ?", [id])!.pinned, 0);
  assert.equal(notes.toggleNotePin(999999), null);
});

test("notes are ordered important-first, then newest-first", () => {
  const rows = db.all<{ pinned: number }>(
    `SELECT pinned FROM carrier_notes WHERE carrier_id = ?
     ORDER BY pinned DESC, created_at DESC, id DESC`, [carrierId],
  );
  const firstUnpinned = rows.findIndex((r) => r.pinned === 0);
  assert.ok(
    firstUnpinned === -1 || rows.slice(firstUnpinned).every((r) => r.pinned === 0),
    "no pinned note appears after an unpinned one",
  );
});
