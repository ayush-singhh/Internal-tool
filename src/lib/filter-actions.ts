"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "./auth.ts";
import { run, get } from "./db.ts";

export async function saveFilterAction(formData: FormData) {
  const user = await requireUser();
  const name = String(formData.get("name") ?? "").trim().slice(0, 80);
  const query = String(formData.get("query") ?? "").slice(0, 2000);
  const path = String(formData.get("path") ?? "/carriers");
  if (!name) return;

  // Re-saving a name replaces it rather than stacking duplicates in the dropdown.
  const existing = get<{ id: number }>(
    "SELECT id FROM saved_filters WHERE user_id = ? AND name = ?",
    [user.id, name],
  );
  if (existing) {
    run("UPDATE saved_filters SET query = ? WHERE id = ?", [query, existing.id]);
  } else {
    run(
      "INSERT INTO saved_filters (user_id, name, query, created_at) VALUES (?, ?, ?, ?)",
      [user.id, name, query, new Date().toISOString()],
    );
  }
  revalidatePath(path);
}

export async function deleteFilterAction(formData: FormData) {
  const user = await requireUser();
  const id = Number(formData.get("id"));
  const path = String(formData.get("path") ?? "/carriers");
  if (!Number.isInteger(id)) return;
  // Scoped to the owner so an id from the URL cannot delete someone else's filter.
  run("DELETE FROM saved_filters WHERE id = ? AND user_id = ?", [id, user.id]);
  revalidatePath(path);
}
