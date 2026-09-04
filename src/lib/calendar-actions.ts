"use server";

import { revalidatePath } from "next/cache";
import { requireOrg } from "./auth.ts";
import { can } from "./permissions.ts";
import { deleteEvent, getEvent, saveEvent } from "./calendar.ts";

export type CalendarState = { error?: string; ok?: string };

const text = (f: FormData, k: string) => {
  const v = String(f.get(k) ?? "").trim();
  return v || null;
};
const id = (f: FormData, k: string) => {
  const n = Number(f.get(k));
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function saveEventAction(_prev: CalendarState, form: FormData): Promise<CalendarState> {
  const { user, org } = await requireOrg();
  const eventId = id(form, "id");

  if (eventId) {
    const existing = getEvent(org, eventId);
    if (!existing) return { error: "Unknown event." };
    // Scoped: a dispatcher manages the events they raised, an administrator manages all.
    if (!can(user, "calendar:manage", existing)) {
      return { error: "This event is not yours to change." };
    }
  } else if (!can(user, "calendar:manage")) {
    return { error: "You cannot add calendar events." };
  }

  const result = saveEvent(
    org,
    {
      id: eventId,
      title: String(form.get("title") ?? ""),
      details: text(form, "details"),
      startsOn: String(form.get("starts_on") ?? ""),
      endsOn: text(form, "ends_on"),
      startsAt: text(form, "starts_at"),
      carrierId: can(user, "carrier:view") ? id(form, "carrier_id") : null,
    },
    user.id,
  );
  if (!result.ok) return { error: result.error };
  revalidatePath("/calendar");
  return { ok: eventId ? "Event updated." : "Event added." };
}

export async function deleteEventAction(form: FormData) {
  const { user, org } = await requireOrg();
  const eventId = id(form, "id");
  if (!eventId) return;

  const event = getEvent(org, eventId);
  if (!event) return;
  if (!can(user, "calendar:manage", event)) {
    throw new Error("This event is not yours to remove.");
  }

  deleteEvent(org, eventId);
  revalidatePath("/calendar");
}
