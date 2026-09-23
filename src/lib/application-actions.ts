"use server";

import { revalidatePath } from "next/cache";
import { requireOrg } from "./auth.ts";
import { can } from "./permissions.ts";
import { convertApplication, rejectApplication } from "./applications.ts";

/**
 * Reviewing what came in through the onboarding portal.
 *
 * Thin auth wrappers over `applications.ts`, which holds the write logic and is what the
 * tests exercise (AI Rules §8). Both re-check the permission here rather than relying on
 * the page having hidden the button — the list is presentation, this is the boundary.
 */
export type ReviewState = { error?: string; ok?: string };

const id = (f: FormData, k: string) => {
  const n = Number(f.get(k));
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function convertApplicationAction(
  _prev: ReviewState,
  form: FormData,
): Promise<ReviewState> {
  const { user, org } = await requireOrg();
  if (!can(user, "application:convert")) {
    return { error: "Only administrators can turn an application into a carrier." };
  }
  const applicationId = id(form, "id");
  if (!applicationId) return { error: "Unknown application." };

  const result = convertApplication(org, applicationId, user.id);
  if (!result.ok) return { error: result.error };

  revalidatePath("/applications");
  revalidatePath("/carriers");
  revalidatePath("/onboarding");
  revalidatePath("/");
  return { ok: "Carrier created. Fill in the dispatcher, plan and rate on their record." };
}

export async function rejectApplicationAction(
  _prev: ReviewState,
  form: FormData,
): Promise<ReviewState> {
  const { user, org } = await requireOrg();
  if (!can(user, "application:convert")) {
    return { error: "Only administrators can reject an application." };
  }
  const applicationId = id(form, "id");
  if (!applicationId) return { error: "Unknown application." };

  const result = rejectApplication(
    org,
    applicationId,
    user.id,
    String(form.get("reason") ?? ""),
  );
  if (!result.ok) return { error: result.error };

  revalidatePath("/applications");
  return { ok: "Application rejected." };
}
