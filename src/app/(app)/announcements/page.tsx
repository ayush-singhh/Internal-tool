import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { get } from "@/lib/db";
import { listAnnouncements, markAnnouncementsSeen } from "@/lib/announcements";
import { PageHeader } from "@/components/ui";
import { AnnouncementBoard } from "@/components/announcement-board";

export const metadata: Metadata = { title: "Announcements" };

export default async function AnnouncementsPage() {
  const { user, org } = await requireOrg();
  if (!can(user, "announcement:view")) redirect("/");

  // Read the watermark *before* moving it, so this render can still mark the notices that
  // were new when the page was opened. Moving it first would show the reader nothing new,
  // ever — the badge would clear and they would never learn which one it was for.
  const seenBefore =
    get<{ announcements_seen_at: string | null }>(
      "SELECT announcements_seen_at FROM users WHERE organization_id = ? AND id = ?",
      [org.id, user.id],
    )?.announcements_seen_at ?? null;

  const announcements = listAnnouncements(org);
  markAnnouncementsSeen(org, user.id);

  return (
    <>
      <PageHeader
        title="Announcements"
        subtitle="Notices to everyone in the organisation, newest first."
      />
      <AnnouncementBoard
        announcements={announcements}
        canManage={can(user, "announcement:manage")}
        unreadSince={seenBefore}
      />
    </>
  );
}
