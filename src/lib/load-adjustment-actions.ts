"use server";

import { revalidatePath } from "next/cache";
import { requireOrg } from "./auth.ts";
import { can } from "./permissions.ts";
import { addLoadAdjustment } from "./load-adjustments.ts";

export type AdjustmentState = { error?: string; ok?: string };

export async function addAdjustmentAction(_prev: AdjustmentState, form: FormData): Promise<AdjustmentState> {
  const { user, org } = await requireOrg();
  if (!can(user, "load:manage")) return { error: "Only dispatch can adjust a load's amount." };

  const loadId = Number(form.get("load_id"));
  if (!Number.isInteger(loadId) || loadId <= 0) return { error: "Unknown load." };

  const kind = String(form.get("kind") ?? "");
  const description = String(form.get("description") ?? "");
  const amount = Number(String(form.get("amount") ?? "").replace(/,/g, ""));

  const result = addLoadAdjustment(org, loadId, { kind, description, amount }, user.id);
  if (!result.ok) return { error: result.error };
  revalidatePath(`/loads/${loadId}`);
  return { ok: "Adjustment added." };
}
