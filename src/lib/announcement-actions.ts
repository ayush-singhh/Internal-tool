"use server";

import { revalidatePath } from "next/cache";
import { requireOrg } from "./auth.ts";
import { can } from "./permissions.ts";
import { deleteAnnouncement, saveAnnouncement } from "./announcements.ts";

export type AnnouncementState = { error?: string; ok?: string };

const id = (f: FormData, k: string) => {
  const n = Number(f.get(k));
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function saveAnnouncementAction(
  _prev: AnnouncementState,
  form: FormData,
): Promise<AnnouncementState> {
  const { user, org } = await requireOrg();
  if (!can(user, "announcement:manage")) {
    return { error: "Only an administrator can post to the whole organisation." };
  }

  const announcementId = id(form, "id");
  const result = saveAnnouncement(
    org,
    {
      id: announcementId,
      title: String(form.get("title") ?? ""),
      body: String(form.get("body") ?? ""),
    },
    user.id,
  );
  if (!result.ok) return { error: result.error };
  revalidatePath("/announcements");
  revalidatePath("/alerts");
  return { ok: announcementId ? "Announcement updated." : "Announcement posted." };
}

export async function deleteAnnouncementAction(form: FormData) {
  const { user, org } = await requireOrg();
  if (!can(user, "announcement:manage")) {
    throw new Error("Not authorized to withdraw an announcement.");
  }
  const announcementId = id(form, "id");
  if (announcementId) deleteAnnouncement(org, announcementId);
  revalidatePath("/announcements");
  revalidatePath("/alerts");
}
