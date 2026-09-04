"use server";

import { revalidatePath } from "next/cache";
import { requireOrg } from "./auth.ts";
import { can } from "./permissions.ts";
import { createChannel, getChannel, postMessage, setChannelArchived } from "./communication.ts";

export type CommsState = { error?: string; ok?: string };

const id = (f: FormData, k: string) => {
  const n = Number(f.get(k));
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function postMessageAction(_prev: CommsState, form: FormData): Promise<CommsState> {
  const { user, org } = await requireOrg();
  const channelId = id(form, "channel_id");
  if (!channelId) return { error: "Unknown channel." };

  // The list on the page was already narrowed by audience, but a form post is not a page
  // render — this is the boundary, and it asks the same question again.
  const channel = getChannel(org, channelId);
  if (!channel) return { error: "Unknown channel." };
  if (!can(user, "message:post", channel)) {
    return { error: "This channel is not yours to post in." };
  }

  const result = postMessage(org, channelId, String(form.get("body") ?? ""), user.id);
  if (!result.ok) return { error: result.error };
  revalidatePath("/communication");
  return {};
}

export async function createChannelAction(_prev: CommsState, form: FormData): Promise<CommsState> {
  const { user, org } = await requireOrg();
  if (!can(user, "channel:manage")) {
    return { error: "Only an administrator can open a channel." };
  }
  const result = createChannel(
    org,
    {
      name: String(form.get("name") ?? ""),
      description: String(form.get("description") ?? ""),
      audience: String(form.get("audience") ?? ""),
    },
    user.id,
  );
  if (!result.ok) return { error: result.error };
  revalidatePath("/communication");
  return { ok: "Channel opened." };
}

export async function archiveChannelAction(form: FormData) {
  const { user, org } = await requireOrg();
  if (!can(user, "channel:manage")) {
    throw new Error("Not authorized to archive a channel.");
  }
  const channelId = id(form, "id");
  if (channelId) setChannelArchived(org, channelId, form.get("archived") === "1");
  revalidatePath("/communication");
}
