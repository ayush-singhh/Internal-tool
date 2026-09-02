"use server";

import { revalidatePath } from "next/cache";
import { requireOrg } from "./auth.ts";
import { can } from "./permissions.ts";
import { uploadLoadDocument } from "./documents.ts";

export type DocumentState = { error?: string; ok?: string };

export async function uploadDocumentAction(_prev: DocumentState, form: FormData): Promise<DocumentState> {
  const { user, org } = await requireOrg();
  if (!can(user, "load:manage")) return { error: "Only dispatch can attach documents." };

  const loadId = Number(form.get("load_id"));
  if (!Number.isInteger(loadId) || loadId <= 0) return { error: "Unknown load." };

  const kind = String(form.get("kind") ?? "");
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a file." };

  const buffer = Buffer.from(await file.arrayBuffer());
  const result = await uploadLoadDocument(
    org, loadId, kind,
    { name: file.name, type: file.type, size: file.size, buffer },
    user.id,
  );
  if (!result.ok) return { error: result.error };
  revalidatePath(`/loads/${loadId}`);
  return { ok: "Document attached." };
}
