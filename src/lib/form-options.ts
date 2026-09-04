import "server-only";
import { all } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import { options } from "./lookups.ts";
import type { CarrierFormOptions } from "@/components/carrier-form";
import type { FormOption } from "@/components/form-fields";

export function carrierFormOptions(org: Org): CarrierFormOptions {
  const kind = (k: Parameters<typeof options>[1]) =>
    options(org, k).map((l) => ({ id: l.id, label: l.label, value: l.value }));

  return {
    status: kind("status"),
    users: all<{ id: number; name: string; role: string }>(
      "SELECT id, name, role FROM users WHERE organization_id = ? AND active = 1 ORDER BY name",
      [org.id],
    ).map((u) => ({ id: u.id, label: u.name })),
    trailer_type: kind("trailer_type"),
    onboarding_type: kind("onboarding_type"),
    lead_source: kind("lead_source"),
    plan: kind("plan"),
    pricing_type: kind("pricing_type"),
    billing_frequency: kind("billing_frequency"),
    subscription: kind("subscription"),
    agreement_status: kind("agreement_status"),
    invoice_mode: kind("invoice_mode"),
  };
}

/**
 * The lead form's three pickers. `owners` lists only the people who actually work a
 * pipeline — sales, account managers and administrators — so a lead cannot be parked
 * with a dispatcher by picking them out of a list of everybody.
 */
export function leadFormOptions(org: Org): {
  trailerTypes: FormOption[];
  sources: FormOption[];
  owners: FormOption[];
} {
  const kind = (k: Parameters<typeof options>[1]) =>
    options(org, k).map((l) => ({ id: l.id, label: l.label }));

  return {
    trailerTypes: kind("trailer_type"),
    sources: kind("lead_source"),
    owners: all<{ id: number; name: string; role: string }>(
      `SELECT id, name, role FROM users
        WHERE organization_id = ? AND active = 1
          AND role IN ('sales', 'account_manager', 'admin', 'owner')
        ORDER BY name`,
      [org.id],
    ).map((u) => ({ id: u.id, label: u.name })),
  };
}

export function carrierOptions(org: Org): FormOption[] {
  return all<{ id: number; legal_name: string }>(
    "SELECT id, legal_name FROM carriers WHERE organization_id = ? ORDER BY legal_name",
    [org.id],
  ).map((c) => ({ id: c.id, label: c.legal_name }));
}

/** Everything the load form's three pickers need, in one pass. */
export function loadFormOptions(org: Org): import("@/components/load-form").LoadFormOptions {
  const carriers = carrierOptions(org);

  // `carrierId` rides along so the form can narrow the driver list once a carrier is
  // chosen: a driver belongs to one carrier, and asking twice invites disagreement.
  const drivers = all<{ id: number; name: string; carrier_id: number | null; truck_number: string | null }>(
    `SELECT id, name, carrier_id, truck_number FROM drivers
      WHERE organization_id = ? AND active = 1 ORDER BY name`,
    [org.id],
  ).map((d) => ({
    id: d.id,
    label: d.truck_number ? `${d.name} · ${d.truck_number}` : d.name,
    carrierId: d.carrier_id,
  }));

  const brokers = all<{ id: number; name: string }>(
    "SELECT id, name FROM brokers WHERE organization_id = ? AND active = 1 ORDER BY name",
    [org.id],
  ).map((b) => ({ id: b.id, label: b.name }));

  return { carriers, drivers, brokers };
}
