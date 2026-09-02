import "server-only";
import { all, get, run } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import { ADJUSTMENT_KIND, type AdjustmentKind } from "./constants.ts";

/**
 * Deductions and extra pay, itemized against a load. Append-only, like `load_documents`:
 * a detention charge or an approved TONU fee is evidence in a payment dispute, not a
 * value to quietly edit later. Feeds `loads.ts`'s `finalLoadAmount` and, downstream, the
 * dispatch fee.
 */

export type AdjustmentRow = {
  id: number;
  organization_id: number;
  load_id: number;
  kind: AdjustmentKind;
  description: string;
  amount: number;
  created_at: string;
  created_by: number | null;
  created_by_name: string | null;
};

export type Result = { ok: true; id: number } | { ok: false; error: string };

const SELECT = `
  SELECT a.*, u.name AS created_by_name
    FROM load_adjustments a LEFT JOIN users u ON u.organization_id = a.organization_id AND u.id = a.created_by
`;

export function listLoadAdjustments(org: Org, loadId: number): AdjustmentRow[] {
  return all<AdjustmentRow>(
    `${SELECT} WHERE a.organization_id = ? AND a.load_id = ? ORDER BY a.created_at, a.id`,
    [org.id, loadId],
  );
}

export function addLoadAdjustment(
  org: Org,
  loadId: number,
  input: { kind: string; description: string; amount: number },
  userId: number,
): Result {
  if (!Object.values(ADJUSTMENT_KIND).includes(input.kind as AdjustmentKind)) {
    return { ok: false, error: "Unknown adjustment kind." };
  }
  if (!get("SELECT 1 FROM loads WHERE organization_id = ? AND id = ?", [org.id, loadId])) {
    return { ok: false, error: "Unknown load." };
  }
  const description = input.description.trim().slice(0, 200);
  if (!description) return { ok: false, error: "Describe what this adjustment is for." };
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { ok: false, error: "Amount must be a positive number." };
  }

  run(
    `INSERT INTO load_adjustments (organization_id, load_id, kind, description, amount, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [org.id, loadId, input.kind, description, input.amount, new Date().toISOString(), userId],
  );
  return { ok: true, id: get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id };
}
