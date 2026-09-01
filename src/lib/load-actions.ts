"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrg } from "./auth.ts";
import { can } from "./permissions.ts";
import { assignDriver, createLoad, setException, setStatus, type StopInput } from "./load-write.ts";
import { LOAD_EXCEPTION, LOAD_STATUS, STOP_KIND, type LoadException, type LoadStatus } from "./constants.ts";

/**
 * Server Actions for loads.
 *
 * Every one re-checks `can()`. A Server Action is a POST endpoint with a nice syntax —
 * reachable whether or not the button that calls it was ever rendered — so the permission
 * decision is made here, not by whichever page chose to show a control.
 */

export type LoadFormState = { error?: string; ok?: string; values?: Record<string, string> };

/** Numeric fields arrive as strings and are frequently blank; "" is not 0. */
function num(form: FormData, key: string): number | null {
  const raw = String(form.get(key) ?? "").trim();
  if (!raw) return null;
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function int(form: FormData, key: string): number | null {
  const n = num(form, key);
  return n === null ? null : Math.trunc(n);
}

function text(form: FormData, key: string, max = 400): string | null {
  const raw = String(form.get(key) ?? "").trim();
  return raw ? raw.slice(0, max) : null;
}

/**
 * Stops arrive as parallel arrays — `pickup_city[]`, `pickup_state[]` and so on — because
 * the form grows a row at a time and the browser posts repeated names in document order.
 * Blank rows are dropped rather than rejected: an empty extra row is somebody changing
 * their mind, not an error worth a message.
 */
function stopsFrom(form: FormData): StopInput[] {
  const stops: StopInput[] = [];
  for (const kind of [STOP_KIND.PICKUP, STOP_KIND.DELIVERY] as const) {
    const cities = form.getAll(`${kind}_city`).map(String);
    const states = form.getAll(`${kind}_state`).map(String);
    const addresses = form.getAll(`${kind}_address`).map(String);
    const times = form.getAll(`${kind}_at`).map(String);
    for (let i = 0; i < cities.length; i++) {
      const city = cities[i]?.trim();
      if (!city) continue;
      stops.push({
        kind,
        city,
        state: states[i]?.trim() || null,
        address: addresses[i]?.trim() || null,
        scheduledAt: times[i]?.trim() || null,
      });
    }
  }
  return stops;
}

export async function createLoadAction(
  _prev: LoadFormState,
  form: FormData,
): Promise<LoadFormState> {
  const { user, org } = await requireOrg();
  if (!can(user, "load:manage")) return { error: "You do not have permission to create loads." };

  const carrierId = int(form, "carrier_id");
  if (!carrierId) return { error: "Choose the carrier this load runs for." };

  const result = createLoad(
    org,
    {
      loadNumber: text(form, "load_number", 60),
      carrierId,
      driverId: int(form, "driver_id"),
      brokerId: int(form, "broker_id"),
      commodity: text(form, "commodity", 160),
      weightLbs: int(form, "weight_lbs"),
      temperatureF: num(form, "temperature_f"),
      deadheadMiles: num(form, "deadhead_miles"),
      loadedMiles: num(form, "loaded_miles"),
      rate: num(form, "rate"),
      specialInstructions: text(form, "special_instructions", 2000),
      stops: stopsFrom(form),
    },
    user.id,
  );
  if (!result.ok) return { error: result.error };

  revalidatePath("/loads");
  redirect(`/loads/${result.id}`);
}

export async function assignDriverAction(form: FormData) {
  const { user, org } = await requireOrg();
  if (!can(user, "load:manage")) throw new Error("Not authorized to assign drivers.");
  const id = Number(form.get("id"));
  const raw = String(form.get("driver_id") ?? "");
  if (Number.isInteger(id)) {
    assignDriver(org, id, raw ? Number(raw) : null, user.id);
  }
  revalidatePath(`/loads/${id}`);
  revalidatePath("/loads");
}

export async function setStatusAction(form: FormData): Promise<void> {
  const { user, org } = await requireOrg();
  const id = Number(form.get("id"));
  const to = String(form.get("to")) as LoadStatus;

  // Invoiced and Closed are the invoicing end of the flow. A dispatcher's authority stops
  // at Delivered, and this is where that is enforced — not by omitting a button.
  const invoicing = to === LOAD_STATUS.INVOICED || to === LOAD_STATUS.CLOSED;
  if (!can(user, invoicing ? "load:close" : "load:manage")) {
    throw new Error("Not authorized to change this load's status.");
  }
  if (Number.isInteger(id)) setStatus(org, id, to, user.id);
  revalidatePath(`/loads/${id}`);
  revalidatePath("/loads");
}

export async function setExceptionAction(form: FormData) {
  const { user, org } = await requireOrg();
  if (!can(user, "load:manage")) throw new Error("Not authorized to flag this load.");
  const id = Number(form.get("id"));
  const raw = String(form.get("exception") ?? "");
  const valid = Object.values(LOAD_EXCEPTION) as string[];
  if (Number.isInteger(id)) {
    setException(org, id, raw && valid.includes(raw) ? (raw as LoadException) : null, user.id);
  }
  revalidatePath(`/loads/${id}`);
  revalidatePath("/loads");
}
