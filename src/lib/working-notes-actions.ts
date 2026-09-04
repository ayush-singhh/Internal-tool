"use server";

import { revalidatePath } from "next/cache";
import { requireOrg } from "./auth.ts";
import { saveWorkingNotes } from "./working-notes.ts";

export type WorkingNotesState = { error?: string; ok?: string };

export async function saveWorkingNotesAction(
  _prev: WorkingNotesState,
  form: FormData,
): Promise<WorkingNotesState> {
  // The session decides whose notes these are. There is no id in the form and there must
  // never be one — the only way to write somebody else's page would be to accept an
  // identifier from the browser for a record the browser has no business naming.
  const { user, org } = await requireOrg();
  const result = saveWorkingNotes(org, user.id, String(form.get("body") ?? ""));
  if (!result.ok) return { error: result.error };
  revalidatePath("/notes");
  return { ok: "Saved." };
}
