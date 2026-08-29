"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { AUDIT, record } from "./audit.ts";
import { requireOrg } from "./auth.ts";
import { get } from "./db.ts";
import { appUrl, mailConfigured, mailer } from "./mailer.ts";
import { assertCan, can } from "./permissions.ts";
import { issueReset } from "./reset.ts";
import {
  createTeamMember, setPassword, setTeamMemberActive, updateTeamMember,
  wouldRemoveLastAdmin,
} from "./team.ts";
import { resetSettings, saveSettings, setLookupActive, SETTING_DEFS } from "./settings.ts";

export type AdminState = {
  error?: string;
  errors?: Record<string, string>;
  ok?: string;
  values?: Record<string, string>;
};

const echo = (formData: FormData, keys: string[]): Record<string, string> =>
  Object.fromEntries(
    keys.map((k) => [k, String(formData.get(k) ?? "")]).filter(([, v]) => v !== ""),
  );

/** A week, not a day: an invitation has to survive a holiday, and it grants nothing until
 *  it is used — the account behind it cannot be signed into. */
const INVITE_TTL_HOURS = 7 * 24;

/**
 * Invites somebody. The account is created with a password nobody knows and no confirmed
 * address, so it is unreachable until they follow the link — which is what makes an
 * unaccepted invitation and an unconfirmed member the same thing, in one table.
 */
export async function createTeamMemberAction(
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const { user, org } = await requireOrg();
  if (!can(user, "team:manage")) return { error: "Only administrators can manage the team." };

  const values = echo(formData, ["name", "email", "role", "phone"]);
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const name = String(formData.get("name") ?? "");
  const result = createTeamMember(org, {
    name,
    email,
    role: String(formData.get("role") ?? ""),
    phone: String(formData.get("phone") ?? ""),
  });
  if (!result.ok) return { error: result.error, values };

  // `Org` carries an id and nothing else on purpose, so the name is read where it is
  // needed. The recipient has to be told which company is asking them to join.
  const orgName =
    get<{ name: string }>("SELECT name FROM organizations WHERE id = ?", [org.id])?.name ??
    "their team";

  record({ organizationId: org.id, userId: user.id, actor: user.email, action: AUDIT.MEMBER_INVITED,
    subject: email, detail: `as ${String(formData.get("role") ?? "")}` });

  const { token } = issueReset(result.id, user.id, INVITE_TTL_HOURS);
  const link = `${appUrl()}/reset/${token}`;
  revalidatePath("/team");

  if (!mailConfigured()) {
    // No relay: hand the link over rather than claiming to have sent something.
    return { ok: `Invitation ready for ${email}. Send them this link: ${link}` };
  }
  try {
    await mailer()({
      to: email,
      subject: `${user.name} has invited you to Carrier Hub`,
      text:
        `Hello ${name.trim()},\n\n` +
        `${user.name} has added you to ${orgName} on Carrier Hub. ` +
        `Choose a password and you are in:\n\n` +
        `${link}\n\n` +
        `The link works once and expires in seven days.\n`,
    });
    return { ok: `Invitation sent to ${email}.` };
  } catch (error) {
    // The account exists and the link is valid — losing it because SMTP is misconfigured
    // would be worse than showing it.
    return {
      ok: `Added, but the invitation could not be emailed (${(error as Error).message}). ` +
        `Send them this link: ${link}`,
    };
  }
}

export async function updateTeamMemberAction(
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const { user, org } = await requireOrg();
  if (!can(user, "team:manage")) return { error: "Only administrators can manage the team." };

  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { error: "Unknown team member." };

  const role = String(formData.get("role") ?? "");
  if (wouldRemoveLastAdmin(org, id, role)) {
    return { error: "You cannot change the role of the last active administrator." };
  }

  const result = updateTeamMember(org, id, {
    name: String(formData.get("name") ?? ""),
    email: String(formData.get("email") ?? ""),
    role,
    phone: String(formData.get("phone") ?? ""),
  });
  if (!result.ok) return { error: result.error };

  record({ organizationId: org.id, userId: user.id, actor: user.email, action: AUDIT.MEMBER_UPDATED,
    subject: String(formData.get("email") ?? ""), detail: `role: ${role}` });
  revalidatePath("/team");
  return { ok: "Team member updated." };
}

export async function toggleTeamMemberAction(formData: FormData) {
  const { user, org } = await requireOrg();
  assertCan(user, "team:manage");

  const id = Number(formData.get("id"));
  const active = formData.get("active") === "1";
  if (Number.isInteger(id)) {
    const target = get<{ email: string }>(
      "SELECT email FROM users WHERE organization_id = ? AND id = ?", [org.id, id],
    );
    const result = setTeamMemberActive(org, id, active);
    if (result.ok) {
      record({
        organizationId: org.id, userId: user.id, actor: user.email,
        action: active ? AUDIT.MEMBER_REACTIVATED : AUDIT.MEMBER_DEACTIVATED,
        subject: target?.email ?? String(id),
      });
    }
  }
  revalidatePath("/team");
}

export async function setPasswordAction(
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const { user, org } = await requireOrg();
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { error: "Unknown team member." };

  // Anyone may change their own password; only an admin may change someone else's.
  if (id !== user.id && !can(user, "team:manage")) {
    return { error: "You can only change your own password." };
  }

  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (password !== confirm) return { error: "The two passwords do not match." };

  // setPassword is org-scoped, so an admin can only reset a password within their own
  // organisation — an id from another tenant simply resolves to "unknown".
  const current = id === user.id ? (await cookies()).get("ch_session")?.value : undefined;
  const result = setPassword(org, id, password, current);
  if (!result.ok) return { error: result.error };

  const target = get<{ email: string }>(
    "SELECT email FROM users WHERE organization_id = ? AND id = ?", [org.id, id],
  );
  record({ organizationId: org.id, userId: user.id, actor: user.email, action: AUDIT.PASSWORD_CHANGED,
    subject: target?.email ?? String(id), detail: id === user.id ? "Their own" : "Set by an administrator" });
  revalidatePath("/team");
  revalidatePath("/settings");
  return { ok: "Password updated. Other sessions for this account were signed out." };
}

export async function saveSettingsAction(
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const { user, org } = await requireOrg();
  if (!can(user, "settings:manage")) {
    return { error: "Only administrators can change settings." };
  }

  const values = Object.fromEntries(
    SETTING_DEFS.map((d) => [d.key, String(formData.get(d.key) ?? "")]),
  );
  const result = saveSettings(org, values);
  if (!result.ok) return { errors: result.errors, values, error: "Fix the highlighted fields." };

  revalidatePath("/settings");
  revalidatePath("/");
  return { ok: "Settings saved." };
}

export async function resetSettingsAction() {
  const { user, org } = await requireOrg();
  assertCan(user, "settings:manage");
  resetSettings(org);
  revalidatePath("/settings");
  revalidatePath("/");
}

export async function toggleLookupAction(formData: FormData) {
  const { user, org } = await requireOrg();
  assertCan(user, "settings:manage");

  const id = Number(formData.get("id"));
  const active = formData.get("active") === "1";
  if (Number.isInteger(id)) setLookupActive(org, id, active);
  revalidatePath("/settings");
}
