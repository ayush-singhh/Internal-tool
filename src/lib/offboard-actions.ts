"use server";

import { revalidatePath } from "next/cache";
import { requireOrg } from "./auth.ts";
import { can } from "./permissions.ts";
import { getCarrier } from "./carriers.ts";
import { allowedIds } from "./carrier-form.ts";
import { createNote } from "./notes.ts";
import {
  changeStatus, isExitStatus, offboardCarrier, reactivateCarrier,
} from "./offboard-write.ts";
import { choice, date, decimal, str, type FieldErrors } from "./validate.ts";

export type StatusState = { errors?: FieldErrors; message?: string; ok?: boolean };

/**
 * One action for every status transition. Moving to an exit status carries the
 * offboarding capture in the same submission; moving back out of one is recorded as a
 * reactivation. Nothing here deletes a carrier.
 */
export async function changeStatusAction(
  _prev: StatusState,
  formData: FormData,
): Promise<StatusState> {
  const { user, org } = await requireOrg();
  const carrierId = Number(formData.get("carrierId"));
  if (!Number.isInteger(carrierId)) return { message: "Unknown carrier." };

  const carrier = getCarrier(org, carrierId);
  if (!carrier) return { message: "Unknown carrier." };
  if (!can(user, "carrier:offboard", carrier)) {
    return { message: "You can only change the status of carriers assigned to you." };
  }

  const allowed = allowedIds(org);
  const errors: FieldErrors = {};
  const statusId = choice(
    formData.get("status_id"), "status_id", "Status", allowed.status, errors, true,
  );
  const note = str(formData.get("note"), 4000);

  if (statusId === null) return { errors, message: "Choose a status." };

  if (isExitStatus(org, statusId)) {
    const offboardedOn = date(
      formData.get("offboarded_on"), "offboarded_on", "Offboarding date", errors,
    );
    const lastLoad = date(
      formData.get("last_load_date"), "last_load_date", "Last load date", errors,
    );
    const balance = decimal(
      formData.get("outstanding_balance"), "outstanding_balance", "Outstanding balance",
      errors, { min: 0 },
    );
    const reasonId = choice(
      formData.get("reason_id"), "reason_id", "Reason", allowed.offboard_reason, errors, true,
    );
    const categoryId = choice(
      formData.get("category_id"), "category_id", "Category", allowed.offboard_category, errors,
    );
    const finalStatusId = choice(
      formData.get("final_status_id"), "final_status_id", "Final Status",
      allowed.final_status, errors,
    );
    const handledBy = choice(
      formData.get("handled_by"), "handled_by", "Handled By", allowed.users, errors,
    );

    if (Object.keys(errors).length > 0) {
      return { errors, message: "Fix the highlighted fields and try again." };
    }

    offboardCarrier(
      org,
      {
        carrierId,
        statusId,
        offboardedOn: offboardedOn ?? new Date().toISOString().slice(0, 10),
        reasonId,
        categoryId,
        finalStatusId,
        handledBy: handledBy ?? user.id,
        lastLoadDate: lastLoad,
        outstandingBalance: balance,
        subscriptionCancelled: formData.get("subscription_cancelled") === "on",
        agreementClosed: formData.get("agreement_closed") === "on",
        canReturn: formData.get("can_return") === "on",
        notes: str(formData.get("offboard_notes"), 4000),
      },
      user.id,
    );
  } else if (isExitStatus(org, carrier.status_id)) {
    reactivateCarrier(org, carrierId, statusId, user.id, note);
  } else {
    changeStatus(org, carrierId, statusId, user.id, note);
  }

  if (note) createNote({ org, carrierId, userId: user.id, body: note });

  revalidatePath(`/carriers/${carrierId}`);
  revalidatePath("/carriers");
  return { ok: true };
}
