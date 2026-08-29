"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentSessionId, requireUser, signOut } from "./auth.ts";
import { revokeOtherSessions, revokeSession } from "./sessions.ts";

export async function signOutAction() {
  await signOut();
  redirect("/login");
}

/**
 * Ending sessions from the Settings page. Both act only on the signed-in account: the
 * user id comes from the session, never from the form, so a session id posted by someone
 * else matches nothing.
 */
export type SessionState = { ok?: string; error?: string };

export async function revokeSessionAction(
  _prev: SessionState,
  formData: FormData,
): Promise<SessionState> {
  const user = await requireUser();
  const done = revokeSession(user.id, await currentSessionId(), String(formData.get("id") ?? ""));
  if (!done) return { error: "That session has already ended." };
  revalidatePath("/settings");
  return { ok: "Signed that device out." };
}

export async function revokeOtherSessionsAction(): Promise<void> {
  const user = await requireUser();
  revokeOtherSessions(user.id, await currentSessionId());
  revalidatePath("/settings");
}
