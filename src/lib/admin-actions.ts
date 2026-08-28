"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { requireUser } from "./auth.ts";
import { assertCan, can } from "./permissions.ts";
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

export async function createTeamMemberAction(
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const user = await requireUser();
  if (!can(user, "team:manage")) return { error: "Only administrators can manage the team." };

  const values = echo(formData, ["name", "email", "role", "phone"]);
  const result = createTeamMember({
    name: String(formData.get("name") ?? ""),
    email: String(formData.get("email") ?? ""),
    role: String(formData.get("role") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    password: String(formData.get("password") ?? ""),
  });
  if (!result.ok) return { error: result.error, values };

  revalidatePath("/team");
  return { ok: "Team member added." };
}

export async function updateTeamMemberAction(
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const user = await requireUser();
  if (!can(user, "team:manage")) return { error: "Only administrators can manage the team." };

  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { error: "Unknown team member." };

  const role = String(formData.get("role") ?? "");
  if (wouldRemoveLastAdmin(id, role)) {
    return { error: "You cannot change the role of the last active administrator." };
  }

  const result = updateTeamMember(id, {
    name: String(formData.get("name") ?? ""),
    email: String(formData.get("email") ?? ""),
    role,
    phone: String(formData.get("phone") ?? ""),
  });
  if (!result.ok) return { error: result.error };

  revalidatePath("/team");
  return { ok: "Team member updated." };
}

export async function toggleTeamMemberAction(formData: FormData) {
  const user = await requireUser();
  assertCan(user, "team:manage");

  const id = Number(formData.get("id"));
  const active = formData.get("active") === "1";
  if (Number.isInteger(id)) setTeamMemberActive(id, active);
  revalidatePath("/team");
}

export async function setPasswordAction(
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const user = await requireUser();
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { error: "Unknown team member." };

  // Anyone may change their own password; only an admin may change someone else's.
  if (id !== user.id && !can(user, "team:manage")) {
    return { error: "You can only change your own password." };
  }

  const password = String(formData.get("password") ?? "");
  const confirm = String(formData.get("confirm") ?? "");
  if (password !== confirm) return { error: "The two passwords do not match." };

  // Keep the current session alive when someone changes their own password, so they
  // are not signed out mid-task; every other session for that account is revoked.
  const current = id === user.id ? (await cookies()).get("ch_session")?.value : undefined;
  const result = setPassword(id, password, current);
  if (!result.ok) return { error: result.error };

  revalidatePath("/team");
  revalidatePath("/settings");
  return { ok: "Password updated. Other sessions for this account were signed out." };
}

export async function saveSettingsAction(
  _prev: AdminState,
  formData: FormData,
): Promise<AdminState> {
  const user = await requireUser();
  if (!can(user, "settings:manage")) {
    return { error: "Only administrators can change settings." };
  }

  const values = Object.fromEntries(
    SETTING_DEFS.map((d) => [d.key, String(formData.get(d.key) ?? "")]),
  );
  const result = saveSettings(values);
  if (!result.ok) return { errors: result.errors, values, error: "Fix the highlighted fields." };

  revalidatePath("/settings");
  revalidatePath("/");
  return { ok: "Settings saved." };
}

export async function resetSettingsAction() {
  const user = await requireUser();
  assertCan(user, "settings:manage");
  resetSettings();
  revalidatePath("/settings");
  revalidatePath("/");
}

export async function toggleLookupAction(formData: FormData) {
  const user = await requireUser();
  assertCan(user, "settings:manage");

  const id = Number(formData.get("id"));
  const active = formData.get("active") === "1";
  if (Number.isInteger(id)) setLookupActive(id, active);
  revalidatePath("/settings");
}
