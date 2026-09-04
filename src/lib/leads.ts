import "server-only";
import { all, get, run, transaction } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import {
  LEAD_STATUS, LEAD_STATUS_OPEN, LEAD_STATUS_SETTABLE, STATUS, type LeadStatus,
} from "./constants.ts";
import { phoneDigits } from "./dispatch-admin.ts";
import { createCarrier } from "./carrier-write.ts";
import { recordActivity } from "./activity.ts";
import { idOf } from "./lookups.ts";

/**
 * Leads — the sales pipeline, and the only thing a sales user can reach.
 *
 * A lead is a prospect, not a carrier: no dispatcher, no plan, no rate, no agreement.
 * Conversion is the one place the two meet, and it is deliberately one-way and one-time.
 */

export type LeadRow = {
  id: number;
  company_name: string;
  contact_name: string | null;
  phone: string | null;
  phone_digits: string | null;
  email: string | null;
  mc_number: string | null;
  usdot: string | null;
  truck_count: number | null;
  trailer_type_id: number | null;
  lead_source_id: number | null;
  status: LeadStatus;
  notes: string | null;
  owner_id: number | null;
  converted_carrier_id: number | null;
  converted_at: string | null;
  created_at: string;
  updated_at: string;
  owner_name: string | null;
  source_label: string | null;
  trailer_label: string | null;
};

export type Result = { ok: true; id: number } | { ok: false; error: string };

/** Everything, or one rep's own when `ownerId` is given — the same query, because the
 *  sales view differs from the admin view by a single predicate. */
export function listLeads(org: Org, ownerId?: number): LeadRow[] {
  const mine = ownerId === undefined ? "" : " AND l.owner_id = ?";
  return all<LeadRow>(
    `SELECT l.*, u.name AS owner_name,
            src.label AS source_label, tt.label AS trailer_label
       FROM leads l
       LEFT JOIN users   u   ON u.organization_id   = l.organization_id AND u.id   = l.owner_id
       LEFT JOIN lookups src ON src.organization_id = l.organization_id AND src.id = l.lead_source_id
       LEFT JOIN lookups tt  ON tt.organization_id  = l.organization_id AND tt.id  = l.trailer_type_id
      WHERE l.organization_id = ?${mine}
      ORDER BY l.created_at DESC, l.id DESC`,
    ownerId === undefined ? [org.id] : [org.id, ownerId],
  );
}

export function getLead(org: Org, id: number): LeadRow | undefined {
  return get<LeadRow>("SELECT * FROM leads WHERE organization_id = ? AND id = ?", [org.id, id]);
}

export type LeadMetrics = Record<LeadStatus, number> & { total: number; open: number };

/** Counts by stage, org-wide or for one rep. Feeds both the dashboard and the sidebar. */
export function leadMetrics(org: Org, ownerId?: number): LeadMetrics {
  const mine = ownerId === undefined ? "" : " AND owner_id = ?";
  const rows = all<{ status: LeadStatus; n: number }>(
    `SELECT status, COUNT(*) AS n FROM leads WHERE organization_id = ?${mine} GROUP BY status`,
    ownerId === undefined ? [org.id] : [org.id, ownerId],
  );
  const m: LeadMetrics = { new: 0, contacted: 0, qualified: 0, won: 0, lost: 0, total: 0, open: 0 };
  for (const row of rows) {
    if (row.status in m) m[row.status] = row.n;
    m.total += row.n;
  }
  m.open = LEAD_STATUS_OPEN.reduce((sum, s) => sum + m[s], 0);
  return m;
}

export type LeadInput = {
  id?: number | null;
  companyName: string;
  contactName?: string | null;
  phone?: string | null;
  email?: string | null;
  mcNumber?: string | null;
  usdot?: string | null;
  truckCount?: number | null;
  trailerTypeId?: number | null;
  leadSourceId?: number | null;
  status?: string | null;
  notes?: string | null;
  ownerId?: number | null;
};

/**
 * Creates or updates one lead. `ownerId` is who works it — for a sales rep submitting
 * their own, the caller passes their own id and never lets the form choose.
 */
export function saveLead(org: Org, input: LeadInput, userId: number | null): Result {
  const companyName = input.companyName.trim().slice(0, 160);
  if (!companyName) return { ok: false, error: "A lead needs a company name." };

  const status = (input.status ?? LEAD_STATUS.NEW) as LeadStatus;
  // `won` is missing from SETTABLE on purpose: it is what conversion writes, and letting
  // a form set it would produce a lead marked won with no carrier behind it.
  if (!LEAD_STATUS_SETTABLE.includes(status)) {
    return { ok: false, error: "A lead becomes Won by being converted, not by being set." };
  }

  const phone = phoneDigits(input.phone);
  const trucks = Number(input.truckCount);
  const fields = [
    companyName,
    input.contactName?.trim() || null,
    phone.value,
    phone.digits,
    input.email?.trim().toLowerCase() || null,
    (input.mcNumber ?? "").replace(/\D/g, "").slice(0, 10) || null,
    (input.usdot ?? "").replace(/\D/g, "").slice(0, 10) || null,
    Number.isFinite(trucks) && trucks > 0 ? Math.trunc(trucks) : null,
    input.trailerTypeId ?? null,
    input.leadSourceId ?? null,
    input.notes?.trim() || null,
    input.ownerId ?? null,
  ];
  const now = new Date().toISOString();

  if (input.id) {
    const existing = getLead(org, input.id);
    if (!existing) return { ok: false, error: "Unknown lead." };
    // A converted lead is the historical record of how a carrier arrived. Editing it
    // afterwards would rewrite that history to say something that never happened.
    if (existing.converted_carrier_id) {
      return { ok: false, error: "This lead has been converted and can no longer be edited." };
    }
    run(
      `UPDATE leads SET company_name = ?, contact_name = ?, phone = ?, phone_digits = ?,
              email = ?, mc_number = ?, usdot = ?, truck_count = ?, trailer_type_id = ?,
              lead_source_id = ?, notes = ?, owner_id = ?, status = ?,
              updated_at = ?, updated_by = ?
        WHERE organization_id = ? AND id = ?`,
      [...fields, status, now, userId, org.id, input.id],
    );
    return { ok: true, id: input.id };
  }

  run(
    `INSERT INTO leads (organization_id, company_name, contact_name, phone, phone_digits,
                        email, mc_number, usdot, truck_count, trailer_type_id,
                        lead_source_id, notes, owner_id, status,
                        created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [org.id, ...fields, status, now, userId, now, userId],
  );
  return { ok: true, id: get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id };
}

/**
 * A lead becomes a carrier record, once.
 *
 * The lead is kept and marked won with a pointer to the carrier it became — the sales
 * history of how that customer arrived. Both writes are one transaction: a carrier with
 * no lead pointing at it, or a lead marked won with no carrier behind it, are each worse
 * than the conversion simply failing.
 *
 * The new carrier starts at "About to Be Active", which is exactly what a won lead is:
 * agreed, not yet running. Nothing here invents a field the lead did not carry.
 */
export function convertLead(org: Org, id: number, userId: number | null): Result {
  const lead = getLead(org, id);
  if (!lead) return { ok: false, error: "Unknown lead." };
  if (lead.converted_carrier_id) {
    return { ok: false, error: "This lead has already been converted." };
  }
  if (lead.status === LEAD_STATUS.LOST) {
    return { ok: false, error: "A lost lead cannot be converted. Reopen it first." };
  }

  const now = new Date().toISOString();
  const carrierId = transaction(() => {
    const created = createCarrier(
      org,
      {
        legal_name: lead.company_name,
        owner_name: lead.contact_name,
        phone: lead.phone,
        phone_digits: lead.phone_digits ?? null,
        email: lead.email,
        mc_number: lead.mc_number,
        usdot: lead.usdot,
        truck_count: lead.truck_count,
        trailer_type_id: lead.trailer_type_id,
        lead_source_id: lead.lead_source_id,
        status_id: idOf(org, "status", STATUS.ABOUT_TO_BE_ACTIVE) ?? null,
        onboarding_date: now.slice(0, 10),
      },
      userId,
    );
    // So the provenance is visible from the carrier's own timeline, not only by querying
    // the leads table backwards.
    recordActivity({
      org,
      carrierId: created,
      userId,
      type: "created",
      summary: `Converted from a lead${lead.owner_name ? ` submitted by ${lead.owner_name}` : ""}`,
      at: now,
    });
    run(
      `UPDATE leads SET status = ?, converted_carrier_id = ?, converted_at = ?,
              updated_at = ?, updated_by = ?
        WHERE organization_id = ? AND id = ?`,
      [LEAD_STATUS.WON, created, now, now, userId, org.id, id],
    );
    return created;
  });

  return { ok: true, id: carrierId };
}
