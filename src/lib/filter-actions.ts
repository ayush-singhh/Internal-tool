"use server";

import { revalidatePath } from "next/cache";
import { requireOrg } from "./auth.ts";
import { run, get } from "./db.ts";

export async function saveFilterAction(formData: FormData) {
  const { user, org } = await requireOrg();
  const name = String(formData.get("name") ?? "").trim().slice(0, 80);
  const query = String(formData.get("query") ?? "").slice(0, 2000);
  const path = String(formData.get("path") ?? "/carriers");
  if (!name) return;

  // Re-saving a name replaces it rather than stacking duplicates in the dropdown.
  const existing = get<{ id: number }>(
    "SELECT id FROM saved_filters WHERE organization_id = ? AND user_id = ? AND name = ?",
    [org.id, user.id, name],
  );
  if (existing) {
    run("UPDATE saved_filters SET query = ? WHERE organization_id = ? AND id = ?",
      [query, org.id, existing.id]);
  } else {
    run(
      "INSERT INTO saved_filters (organization_id, user_id, name, query, created_at) VALUES (?, ?, ?, ?, ?)",
      [org.id, user.id, name, query, new Date().toISOString()],
    );
  }
  revalidatePath(path);
}

export async function deleteFilterAction(formData: FormData) {
  const { user, org } = await requireOrg();
  const id = Number(formData.get("id"));
  const path = String(formData.get("path") ?? "/carriers");
  if (!Number.isInteger(id)) return;
  // Scoped to org AND owner so an id from the URL cannot delete another tenant's filter.
  run("DELETE FROM saved_filters WHERE organization_id = ? AND id = ? AND user_id = ?",
    [org.id, id, user.id]);
  revalidatePath(path);
}
