"use server";

import { requireUser } from "./auth.ts";
import { assertCan } from "./permissions.ts";
import { consumeReset, issueReset } from "./reset.ts";
import { get } from "./db.ts";

export type IssueState = { link?: string; expiresAt?: string; forName?: string; error?: string };

export async function issueResetAction(
  _prev: IssueState,
  formData: FormData,
): Promise<IssueState> {
  const admin = await requireUser();
  assertCan(admin, "team:manage");

  const userId = Number(formData.get("userId"));
  if (!Number.isInteger(userId)) return { error: "Unknown team member." };

  const user = get<{ name: string; active: number }>(
    "SELECT name, active FROM users WHERE id = ?", [userId],
  );
  if (!user) return { error: "Unknown team member." };
  if (!user.active) return { error: "Reactivate this account before resetting its password." };

  const { token, expiresAt } = issueReset(userId, admin.id);
  return { link: `/reset/${token}`, expiresAt, forName: user.name };
}

export type ResetState = { error?: string; done?: boolean };

export async function completeResetAction(
  _prev: ResetState,
  formData: FormData,
): Promise<ResetState> {
  const token = String(formData.get("token") ?? "");
  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");

  if (password !== confirm) return { error: "The two passwords do not match." };

  const result = consumeReset(token, password);
  if (!result.ok) return { error: result.error };
  return { done: true };
}
