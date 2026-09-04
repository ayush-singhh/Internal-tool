"use server";

import { revalidatePath } from "next/cache";
import { requireOrg } from "./auth.ts";
import { can } from "./permissions.ts";
import { addBroker, saveDriver, setBrokerDnu, setDriverActive, updateBroker } from "./dispatch-admin.ts";

export type AdminState = { error?: string; ok?: string };

const text = (f: FormData, k: string) => {
  const v = String(f.get(k) ?? "").trim();
  return v || null;
};
const id = (f: FormData, k: string) => {
  const n = Number(f.get(k));
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function saveDriverAction(_prev: AdminState, form: FormData): Promise<AdminState> {
  const { user, org } = await requireOrg();
  if (!can(user, "driver:manage")) return { error: "Only dispatch can manage drivers." };

  const result = saveDriver(org, {
    id: id(form, "id"),
    name: String(form.get("name") ?? ""),
    carrierId: id(form, "carrier_id"),
    phone: text(form, "phone"),
    email: text(form, "email"),
    truckNumber: text(form, "truck_number"),
    cdlNumber: text(form, "cdl_number"),
    cdlExpiresOn: text(form, "cdl_expires_on"),
    notes: text(form, "notes"),
  });
  if (!result.ok) return { error: result.error };
  revalidatePath("/drivers");
  return { ok: id(form, "id") ? "Driver updated." : "Driver added." };
}

export async function toggleDriverAction(form: FormData) {
  const { user, org } = await requireOrg();
  if (!can(user, "driver:manage")) throw new Error("Not authorized to manage drivers.");
  const driverId = id(form, "id");
  if (driverId) setDriverActive(org, driverId, form.get("active") === "1");
  revalidatePath("/drivers");
}

/**
 * Adding a broker is open to dispatch; correcting one is not. Two actions rather than one
 * with a flag, so the permission difference is visible at the call site.
 */
export async function addBrokerAction(_prev: AdminState, form: FormData): Promise<AdminState> {
  const { user, org } = await requireOrg();
  if (!can(user, "broker:create")) return { error: "You cannot add brokers." };
  const result = addBroker(org, String(form.get("name") ?? ""), user.id);
  if (!result.ok) return { error: result.error };
  revalidatePath("/brokers");
  return { ok: "Broker added. An administrator can correct the details." };
}

export async function updateBrokerAction(_prev: AdminState, form: FormData): Promise<AdminState> {
  const { user, org } = await requireOrg();
  if (!can(user, "broker:edit")) {
    return { error: "Only an administrator can correct the broker list." };
  }
  const brokerId = id(form, "id");
  if (!brokerId) return { error: "Unknown broker." };

  const result = updateBroker(org, brokerId, {
    name: String(form.get("name") ?? ""),
    mcNumber: text(form, "mc_number"),
    contactName: text(form, "contact_name"),
    phone: text(form, "phone"),
    email: text(form, "email"),
    active: form.get("active") !== "0",
  });
  if (!result.ok) return { error: result.error };
  revalidatePath("/brokers");
  return { ok: "Broker updated." };
}

/**
 * Putting a broker on the Do Not Use list, or taking them off it.
 *
 * Gated on `broker:edit` rather than an action of its own: the audience is identical
 * (administrators), and the client's spec puts the DNU list on the Admin panel only. A
 * separate `broker:dnu` would be a second row in the permission matrix that always
 * answers the same as this one. Give it its own action the day dispatch is allowed to
 * *flag* a broker for an administrator to confirm — that is a different audience.
 */
export async function setBrokerDnuAction(_prev: AdminState, form: FormData): Promise<AdminState> {
  const { user, org } = await requireOrg();
  if (!can(user, "broker:edit")) {
    return { error: "Only an administrator can change the Do Not Use list." };
  }
  const brokerId = id(form, "id");
  if (!brokerId) return { error: "Unknown broker." };

  const dnu = form.get("dnu") === "1";
  const result = setBrokerDnu(org, brokerId, { dnu, reason: text(form, "dnu_reason") }, user.id);
  if (!result.ok) return { error: result.error };

  revalidatePath("/brokers");
  // A load can no longer be booked against them, so the form that offers the choice has
  // to be rebuilt too.
  revalidatePath("/loads/new");
  return { ok: dnu ? "Added to the Do Not Use list." : "Removed from the Do Not Use list." };
}
