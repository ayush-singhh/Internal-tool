"use server";

import { revalidatePath } from "next/cache";
import { requireOrg } from "./auth.ts";
import { can } from "./permissions.ts";
import { createNote, toggleNotePin } from "./notes.ts";

export type NoteState = { error?: string; ok?: boolean };

export async function addNoteAction(
  _prev: NoteState,
  formData: FormData,
): Promise<NoteState> {
  const { user, org } = await requireOrg();
  if (!can(user, "note:create")) return { error: "You do not have permission to add notes." };

  const carrierId = Number(formData.get("carrierId"));
  const result = createNote({
    org,
    carrierId,
    userId: user.id,
    body: String(formData.get("body") ?? ""),
    important: formData.get("important") === "on",
  });
  if (!result.ok) return { error: result.error };

  revalidatePath(`/carriers/${carrierId}`);
  return { ok: true };
}

export async function toggleNotePinAction(formData: FormData) {
  const { user, org } = await requireOrg();
  if (!can(user, "note:create")) return;

  const noteId = Number(formData.get("noteId"));
  if (!Number.isInteger(noteId)) return;

  const carrierId = toggleNotePin(org, noteId);
  if (carrierId !== null) revalidatePath(`/carriers/${carrierId}`);
}
