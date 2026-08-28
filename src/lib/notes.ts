import "server-only";
import { get, run, transaction } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import { recordActivity } from "./activity.ts";

export const MAX_NOTE = 4000;

export type WriteResult = { ok: true } | { ok: false; error: string };

/**
 * Note creation without any request context, so it can be exercised directly by tests.
 * The Server Action is a thin authentication wrapper around this.
 */
export function createNote(input: {
  org: Org;
  carrierId: number;
  userId: number | null;
  body: string;
  important?: boolean;
}): WriteResult {
  const body = input.body.trim().slice(0, MAX_NOTE);
  if (!Number.isInteger(input.carrierId)) return { ok: false, error: "Unknown carrier." };
  if (!body) return { ok: false, error: "Write something before saving the note." };

  // The carrier lookup is itself org-scoped, so a note can never attach to another
  // tenant's carrier even if a stray id is passed.
  const carrier = get<{ id: number }>(
    "SELECT id FROM carriers WHERE organization_id = ? AND id = ?",
    [input.org.id, input.carrierId],
  );
  if (!carrier) return { ok: false, error: "Unknown carrier." };

  transaction(() => {
    run(
      `INSERT INTO carrier_notes (organization_id, carrier_id, user_id, body, pinned, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [input.org.id, input.carrierId, input.userId, body, input.important ? 1 : 0, new Date().toISOString()],
    );
    // Only important notes reach the activity timeline; routine notes would drown it.
    if (input.important) {
      recordActivity({
        org: input.org,
        carrierId: input.carrierId,
        userId: input.userId,
        type: "note",
        summary: `Important note added: ${body.slice(0, 120)}${body.length > 120 ? "…" : ""}`,
      });
    }
  });

  return { ok: true };
}

export function toggleNotePin(org: Org, noteId: number): number | null {
  const note = get<{ carrier_id: number; pinned: number }>(
    "SELECT carrier_id, pinned FROM carrier_notes WHERE organization_id = ? AND id = ?",
    [org.id, noteId],
  );
  if (!note) return null;
  run("UPDATE carrier_notes SET pinned = ? WHERE organization_id = ? AND id = ?",
    [note.pinned ? 0 : 1, org.id, noteId]);
  return note.carrier_id;
}
