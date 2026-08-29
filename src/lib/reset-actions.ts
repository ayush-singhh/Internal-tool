"use server";

import { headers } from "next/headers";
import { requireOrg } from "./auth.ts";
import { appUrl, mailConfigured, mailer } from "./mailer.ts";
import { assertCan } from "./permissions.ts";
import { consumeReset, issueReset, requestReset } from "./reset.ts";
import { get } from "./db.ts";

export type IssueState = {
  link?: string;
  expiresAt?: string;
  forName?: string;
  /** Set when the link went out by email, so the administrator never handles it. */
  sentTo?: string;
  error?: string;
};

export async function issueResetAction(
  _prev: IssueState,
  formData: FormData,
): Promise<IssueState> {
  const { user: admin, org } = await requireOrg();
  assertCan(admin, "team:manage");

  const userId = Number(formData.get("userId"));
  if (!Number.isInteger(userId)) return { error: "Unknown team member." };

  // Org-scoped: an admin can only issue a reset for a member of their own organisation.
  const user = get<{ name: string; email: string; active: number }>(
    "SELECT name, email, active FROM users WHERE organization_id = ? AND id = ?", [org.id, userId],
  );
  if (!user) return { error: "Unknown team member." };
  if (!user.active) return { error: "Reactivate this account before resetting its password." };

  const { token, expiresAt } = issueReset(userId, admin.id);

  // Mail it where there is a relay, so the link never passes through a chat window. With
  // no relay configured — a self-hosted install that never set one up — hand it back for
  // the administrator to deliver, rather than pretending it was sent.
  if (mailConfigured()) {
    try {
      await mailer()({
        to: user.email,
        subject: "Reset your password",
        text:
          `Hello ${user.name},\n\n` +
          `${admin.name} has sent you a link to set a new password:\n\n` +
          `${appUrl()}/reset/${token}\n\n` +
          `It works once and expires in 24 hours. Using it signs the account out ` +
          `everywhere.\n`,
      });
      return { expiresAt, forName: user.name, sentTo: user.email };
    } catch (error) {
      // Falling back to the link is better than losing the reset the administrator asked
      // for. The reason is worth showing — it is nearly always the SMTP configuration.
      return {
        link: `/reset/${token}`,
        expiresAt,
        forName: user.name,
        error: `Could not send the email (${(error as Error).message}). Send this link instead.`,
      };
    }
  }
  return { link: `/reset/${token}`, expiresAt, forName: user.name };
}

export type ForgotState = { error?: string; sent?: boolean };

/** Public and unauthenticated: the only route to a new password for somebody who has no
 *  administrator above them. */
export async function forgotPasswordAction(
  _prev: ForgotState,
  formData: FormData,
): Promise<ForgotState> {
  const h = await headers();
  const ip =
    h.get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 64) ||
    h.get("x-real-ip")?.slice(0, 64) ||
    null;

  const result = await requestReset(String(formData.get("email") ?? ""), ip, mailer());
  if (!result.ok) return { error: result.error };
  return { sent: true };
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
