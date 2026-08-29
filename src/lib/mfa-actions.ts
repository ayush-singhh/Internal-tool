"use server";

import { revalidatePath } from "next/cache";
import { AUDIT, record } from "./audit.ts";
import { requireUser } from "./auth.ts";
import { activate, beginEnrollment, cancelEnrollment, disable } from "./mfa.ts";

/**
 * Two-factor authentication is self-service: every action here acts on the signed-in
 * user's own account and takes no user id from the form. An administrator cannot enrol
 * or disable someone else's second factor, because they would have to hold the phone.
 */
export type MfaFormState = { error?: string; ok?: string; recoveryCodes?: string[] };

export async function beginEnrollmentAction(): Promise<void> {
  const user = await requireUser();
  beginEnrollment(user.id);
  revalidatePath("/settings");
}

export async function cancelEnrollmentAction(): Promise<void> {
  const user = await requireUser();
  cancelEnrollment(user.id);
  revalidatePath("/settings");
}

export async function activateAction(
  _prev: MfaFormState,
  formData: FormData,
): Promise<MfaFormState> {
  const user = await requireUser();
  const result = activate(user.id, String(formData.get("code") ?? ""));
  if (!result.ok) return { error: result.error };
  record({ organizationId: user.organization_id, userId: user.id,
    actor: user.email, action: AUDIT.MFA_ENABLED, subject: user.email });
  revalidatePath("/settings");
  // Shown once. They are not stored in a readable form, so this is the only chance.
  return { ok: "Two-factor authentication is on.", recoveryCodes: result.recoveryCodes };
}

export async function disableAction(
  _prev: MfaFormState,
  formData: FormData,
): Promise<MfaFormState> {
  const user = await requireUser();
  const result = disable(user.id, String(formData.get("code") ?? ""));
  if (!result.ok) return { error: result.error };
  record({ organizationId: user.organization_id, userId: user.id,
    actor: user.email, action: AUDIT.MFA_DISABLED, subject: user.email });
  revalidatePath("/settings");
  return { ok: "Two-factor authentication is off. Your password is now the only factor." };
}
