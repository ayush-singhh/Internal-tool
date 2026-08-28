import "server-only";
import { get, run, transaction } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import { recordActivity } from "./activity.ts";
import { labelOf, idOf } from "./lookups.ts";
import { OFFBOARDING_STATUSES, STATUS } from "./constants.ts";

export type OffboardInput = {
  carrierId: number;
  statusId: number;
  offboardedOn: string | null;
  reasonId: number | null;
  categoryId: number | null;
  finalStatusId: number | null;
  handledBy: number | null;
  lastLoadDate: string | null;
  outstandingBalance: number | null;
  subscriptionCancelled: boolean;
  agreementClosed: boolean;
  canReturn: boolean;
  notes: string | null;
};

/** True when a status means the carrier has left. Drives whether the workflow opens. */
export function isExitStatus(org: Org, statusId: number | null | undefined): boolean {
  if (statusId == null) return false;
  return OFFBOARDING_STATUSES.some((value) => idOf(org, "status", value) === statusId);
}

/**
 * Records an exit. The carrier row is never deleted — its status moves and a dated,
 * attributed offboarding record is attached alongside the full existing history.
 */
export function offboardCarrier(org: Org, input: OffboardInput, userId: number | null) {
  const carrier = get<{ id: number; status_id: number | null; legal_name: string }>(
    "SELECT id, status_id, legal_name FROM carriers WHERE organization_id = ? AND id = ?",
    [org.id, input.carrierId],
  );
  if (!carrier) throw new Error("Carrier not found.");

  const now = new Date().toISOString();
  const fromStatus = labelOf(org, carrier.status_id);
  const toStatus = labelOf(org, input.statusId);

  transaction(() => {
    if (carrier.status_id !== input.statusId) {
      run(
        "UPDATE carriers SET status_id = ?, status_changed_at = ?, updated_at = ?, updated_by = ? WHERE organization_id = ? AND id = ?",
        [input.statusId, now, now, userId, org.id, input.carrierId],
      );
      recordActivity({
        org,
        carrierId: input.carrierId,
        userId,
        type: "status",
        field: "Status",
        oldValue: fromStatus,
        newValue: toStatus,
        summary: `Status changed from ${fromStatus || "none"} to ${toStatus || "none"}`,
        at: now,
      });
    }

    // One offboarding record per carrier; re-running the workflow revises it rather
    // than stacking duplicates.
    run(
      `INSERT INTO offboarding_records (
         organization_id, carrier_id, offboarded_on, reason_id, category_id, final_status_id, handled_by,
         last_load_date, outstanding_balance, subscription_cancelled, agreement_closed,
         can_return, notes, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (carrier_id) DO UPDATE SET
         offboarded_on = excluded.offboarded_on,
         reason_id = excluded.reason_id,
         category_id = excluded.category_id,
         final_status_id = excluded.final_status_id,
         handled_by = excluded.handled_by,
         last_load_date = excluded.last_load_date,
         outstanding_balance = excluded.outstanding_balance,
         subscription_cancelled = excluded.subscription_cancelled,
         agreement_closed = excluded.agreement_closed,
         can_return = excluded.can_return,
         notes = excluded.notes`,
      [
        org.id, input.carrierId, input.offboardedOn, input.reasonId, input.categoryId,
        input.finalStatusId, input.handledBy, input.lastLoadDate, input.outstandingBalance,
        input.subscriptionCancelled ? 1 : 0, input.agreementClosed ? 1 : 0,
        input.canReturn ? 1 : 0, input.notes, now, userId,
      ],
    );

    // Keep the commercial fields honest with what the workflow recorded.
    if (input.subscriptionCancelled) {
      const cancelled = idOf(org, "subscription", "cancelled");
      if (cancelled) run("UPDATE carriers SET subscription_id = ? WHERE organization_id = ? AND id = ?", [cancelled, org.id, input.carrierId]);
    }

    recordActivity({
      org,
      carrierId: input.carrierId,
      userId,
      type: "offboarding",
      summary: `Offboarding recorded — ${labelOf(org, input.reasonId) || "reason not stated"}${
        input.canReturn ? " · may return" : " · may not return"
      }`,
      at: now,
    });
  });
}

/** Brings a carrier back. The offboarding record is kept as history, not erased. */
export function reactivateCarrier(
  org: Org,
  carrierId: number,
  statusId: number,
  userId: number | null,
  note: string | null,
) {
  const carrier = get<{ status_id: number | null }>(
    "SELECT status_id FROM carriers WHERE organization_id = ? AND id = ?",
    [org.id, carrierId],
  );
  if (!carrier) throw new Error("Carrier not found.");

  const now = new Date().toISOString();
  const fromStatus = labelOf(org, carrier.status_id);
  const toStatus = labelOf(org, statusId);

  transaction(() => {
    run(
      "UPDATE carriers SET status_id = ?, status_changed_at = ?, updated_at = ?, updated_by = ? WHERE organization_id = ? AND id = ?",
      [statusId, now, now, userId, org.id, carrierId],
    );
    recordActivity({
      org, carrierId, userId, type: "reactivation", field: "Status",
      oldValue: fromStatus, newValue: toStatus,
      summary: `Carrier reactivated — status changed from ${fromStatus || "none"} to ${toStatus || "none"}${
        note ? ` (${note})` : ""
      }`,
      at: now,
    });
  });
}

/** A plain status change with no offboarding paperwork attached. */
export function changeStatus(
  org: Org,
  carrierId: number,
  statusId: number,
  userId: number | null,
  note: string | null,
) {
  const carrier = get<{ status_id: number | null }>(
    "SELECT status_id FROM carriers WHERE organization_id = ? AND id = ?",
    [org.id, carrierId],
  );
  if (!carrier) throw new Error("Carrier not found.");
  if (carrier.status_id === statusId) return;

  const now = new Date().toISOString();
  const fromStatus = labelOf(org, carrier.status_id);
  const toStatus = labelOf(org, statusId);
  const returning = isExitStatus(org, carrier.status_id) && !isExitStatus(org, statusId);

  transaction(() => {
    run(
      "UPDATE carriers SET status_id = ?, status_changed_at = ?, updated_at = ?, updated_by = ? WHERE organization_id = ? AND id = ?",
      [statusId, now, now, userId, org.id, carrierId],
    );
    recordActivity({
      org,
      carrierId,
      userId,
      type: returning ? "reactivation" : "status",
      field: "Status",
      oldValue: fromStatus,
      newValue: toStatus,
      summary: `Status changed from ${fromStatus || "none"} to ${toStatus || "none"}${
        note ? ` (${note})` : ""
      }`,
      at: now,
    });
  });
}

export { STATUS };
