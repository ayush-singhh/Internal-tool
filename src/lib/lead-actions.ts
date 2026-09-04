"use server";

import { revalidatePath } from "next/cache";
import { requireOrg } from "./auth.ts";
import { can } from "./permissions.ts";
import { convertLead, getLead, saveLead } from "./leads.ts";

export type LeadState = { error?: string; ok?: string };

const text = (f: FormData, k: string) => {
  const v = String(f.get(k) ?? "").trim();
  return v || null;
};
const id = (f: FormData, k: string) => {
  const n = Number(f.get(k));
  return Number.isInteger(n) && n > 0 ? n : null;
};

export async function saveLeadAction(_prev: LeadState, form: FormData): Promise<LeadState> {
  const { user, org } = await requireOrg();
  const leadId = id(form, "id");
  const existing = leadId ? getLead(org, leadId) : null;

  if (leadId) {
    if (!existing) return { error: "Unknown lead." };
    // Scoped, so a sales rep editing somebody else's lead is refused here and not merely
    // hidden from the list — the list is presentation, this is the boundary.
    if (!can(user, "lead:edit", existing)) return { error: "This is not your lead to edit." };
  } else if (!can(user, "lead:create")) {
    return { error: "You cannot submit leads." };
  }

  // A sales rep owns what they submit and cannot hand it to somebody else; anyone who
  // manages the whole pipeline picks. Deciding it here rather than trusting the posted
  // field is what stops a rep reassigning a lead by editing the form.
  const ownerId = can(user, "lead:convert")
    ? id(form, "owner_id")
    : (existing?.owner_id ?? user.id);

  const result = saveLead(
    org,
    {
      id: leadId,
      companyName: String(form.get("company_name") ?? ""),
      contactName: text(form, "contact_name"),
      phone: text(form, "phone"),
      email: text(form, "email"),
      mcNumber: text(form, "mc_number"),
      usdot: text(form, "usdot"),
      truckCount: Number(form.get("truck_count")) || null,
      trailerTypeId: id(form, "trailer_type_id"),
      leadSourceId: id(form, "lead_source_id"),
      status: text(form, "status"),
      notes: text(form, "notes"),
      ownerId,
    },
    user.id,
  );
  if (!result.ok) return { error: result.error };
  revalidatePath("/leads");
  return { ok: leadId ? "Lead updated." : "Lead submitted." };
}

export async function convertLeadAction(_prev: LeadState, form: FormData): Promise<LeadState> {
  const { user, org } = await requireOrg();
  if (!can(user, "lead:convert")) {
    return { error: "Only an administrator can turn a lead into a carrier record." };
  }
  const leadId = id(form, "id");
  if (!leadId) return { error: "Unknown lead." };

  const result = convertLead(org, leadId, user.id);
  if (!result.ok) return { error: result.error };
  revalidatePath("/leads");
  revalidatePath("/carriers");
  return { ok: "Carrier record created. Finish the details on the carrier profile." };
}
