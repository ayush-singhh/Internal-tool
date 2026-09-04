import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import {
  audienceLabel, getChannel, listChannels, listMessages, markChannelRead,
} from "@/lib/communication";
import { CHANNEL_AUDIENCE_ALL, ROLES } from "@/lib/constants";
import { PageHeader } from "@/components/ui";
import { ChannelView } from "@/components/channel-view";

export const metadata: Metadata = { title: "Communication" };

/** Every audience a channel may be addressed to. Platform support is absent on purpose —
 *  it is not a role inside an organisation, so a channel addressed to it would be a room
 *  nobody in the company could enter. */
const AUDIENCE_OPTIONS = [
  { value: CHANNEL_AUDIENCE_ALL, label: "Everyone" },
  ...Object.values(ROLES)
    .filter((role) => role !== ROLES.SUPPORT)
    .map((role) => ({ value: role, label: audienceLabel(role) })),
];

export default async function CommunicationPage({ searchParams }: PageProps<"/communication">) {
  const { user, org } = await requireOrg();
  if (!can(user, "message:view")) redirect("/");

  const channels = listChannels(org, user, can(user, "channel:manage"));

  const requested = Number((await searchParams).channel);
  // Falling back to the first *visible* channel rather than the first channel: the list
  // was already narrowed by audience, so this cannot land on somebody else's team room.
  const wanted = Number.isInteger(requested) && requested > 0 ? requested : channels[0]?.id;

  let active = channels.find((c) => c.id === wanted) ?? null;
  if (active === null && wanted !== undefined) {
    // Asked for a channel that exists but is not theirs, or does not exist at all. Both
    // answer the same way — a reader learns nothing about what they cannot see.
    const exists = getChannel(org, wanted);
    if (exists && !can(user, "message:view", exists)) redirect("/communication");
    active = channels[0] ?? null;
  }

  const messages = active === null ? [] : listMessages(org, active.id);
  if (active !== null) {
    // Read the unread count into the render before clearing it, the same way
    // /announcements does: mark first and the reader never sees what was new.
    markChannelRead(org, active.id, user.id);
    // The badge in the list came from the query above, which still shows the truth as of
    // page load. Reset only the open channel's, so the rail agrees with what is on screen.
    active = { ...active, unread: 0 };
  }

  return (
    <>
      <PageHeader
        title="Communication"
        subtitle="Internal channels. Nothing here reaches a carrier, a broker or a driver."
      />
      <ChannelView
        channels={channels.map((c) => (c.id === active?.id ? active : c))}
        active={active}
        messages={messages}
        audiences={AUDIENCE_OPTIONS}
        canManage={can(user, "channel:manage")}
        canPost={active !== null && can(user, "message:post", active)}
        currentUserId={user.id}
      />
    </>
  );
}
