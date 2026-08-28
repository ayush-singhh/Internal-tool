"use server";

import { revalidatePath } from "next/cache";
import { requireOrg } from "./auth.ts";
import { can } from "./permissions.ts";
import {
  buildPreview, commitImport, type DuplicateMode, type ImportSummary, type PreviewRow,
} from "./import.ts";

export type PreviewResult =
  | { ok: true; preview: PreviewRow[]; counts: { total: number; errors: number; flagged: number; duplicates: number } }
  | { ok: false; error: string };

export async function previewImportAction(
  rows: Record<string, string>[],
): Promise<PreviewResult> {
  const { user, org } = await requireOrg();
  if (!can(user, "import:run")) {
    return { ok: false, error: "Only administrators can import carrier data." };
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, error: "No rows to import." };
  }
  const { preview, counts } = buildPreview(org, rows);
  return { ok: true, preview, counts };
}

export type CommitResult =
  | { ok: true; summary: ImportSummary }
  | { ok: false; error: string };

export async function commitImportAction(
  rows: Record<string, string>[],
  mode: DuplicateMode,
): Promise<CommitResult> {
  const { user, org } = await requireOrg();
  if (!can(user, "import:run")) {
    return { ok: false, error: "Only administrators can import carrier data." };
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, error: "No rows to import." };
  }
  if (!["skip", "update", "create"].includes(mode)) {
    return { ok: false, error: "Choose how duplicates should be handled." };
  }

  try {
    const summary = commitImport(org, rows, mode as DuplicateMode, user.id);
    revalidatePath("/carriers");
    revalidatePath("/");
    return { ok: true, summary };
  } catch (error) {
    // The whole import runs in one transaction, so a throw means nothing was written.
    return {
      ok: false,
      error: `Import failed and nothing was saved: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    };
  }
}
