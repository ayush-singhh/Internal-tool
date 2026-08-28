import "server-only";
import { all } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import { options } from "./lookups.ts";
import type { CarrierFormOptions } from "@/components/carrier-form";

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
