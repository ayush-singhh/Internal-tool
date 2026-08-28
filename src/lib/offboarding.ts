import "server-only";
import { get } from "./db.ts";
import type { Org } from "./tenant-db.ts";

export type OffboardingRow = {
  id: number;
  carrier_id: number;
  offboarded_on: string | null;
  reason_id: number | null;
  category_id: number | null;
  final_status_id: number | null;
  handled_by: number | null;
  last_load_date: string | null;
  outstanding_balance: number | null;
  subscription_cancelled: number;
  agreement_closed: number;
  can_return: number;
  notes: string | null;
  created_at: string;
  created_by: number | null;
  handler_name: string | null;
};

export function getOffboarding(org: Org, carrierId: number): OffboardingRow | undefined {
  return get<OffboardingRow>(
    `SELECT o.*, u.name AS handler_name
       FROM offboarding_records o
       LEFT JOIN users u ON u.id = o.handled_by
      WHERE o.organization_id = ? AND o.carrier_id = ?`,
    [org.id, carrierId],
  );
}
