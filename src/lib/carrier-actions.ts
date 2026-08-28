"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireUser } from "./auth.ts";
import { can } from "./permissions.ts";
import { getCarrier, findDuplicates } from "./carriers.ts";
import { createCarrier, updateCarrier } from "./carrier-write.ts";
import { allowedIds, echoValues, parseCarrierForm } from "./carrier-form.ts";
import { createNote } from "./notes.ts";
import { labelOf } from "./lookups.ts";
import type { FieldErrors } from "./validate.ts";

export type DuplicateMatch = {
  id: number;
  legal_name: string;
  mc_number: string | null;
  usdot: string | null;
  status: string;
  dispatcher_name: string | null;
};

export type CarrierFormState = {
  errors?: FieldErrors;
  message?: string;
  duplicates?: { mc: DuplicateMatch[]; usdot: DuplicateMatch[] };
  values?: Record<string, string>;
};

function summarize(rows: ReturnType<typeof findDuplicates>["mc"]): DuplicateMatch[] {
  return rows.map((r) => ({
    id: r.id,
    legal_name: r.legal_name,
    mc_number: r.mc_number,
    usdot: r.usdot,
    status: labelOf(r.status_id),
    dispatcher_name: r.dispatcher_name,
  }));
}

export async function createCarrierAction(
  _prev: CarrierFormState,
  formData: FormData,
): Promise<CarrierFormState> {
  const user = await requireUser();
  if (!can(user, "carrier:create")) {
    return { message: "You do not have permission to add carriers." };
  }

  const { input, errors } = parseCarrierForm(formData, allowedIds());
  const values = echoValues(formData);
  if (Object.keys(errors).length > 0) {
    return { errors, values, message: "Fix the highlighted fields and try again." };
  }

  // MC is the primary business identifier; a match is a warning the user resolves,
  // never a silent block and never a silent duplicate.
  if (formData.get("confirm_duplicate") !== "yes") {
    const dupes = findDuplicates(
      input.mc_number as string | null,
      input.usdot as string | null,
    );
    if (dupes.mc.length > 0 || dupes.usdot.length > 0) {
      return {
        values,
        duplicates: { mc: summarize(dupes.mc), usdot: summarize(dupes.usdot) },
        message: "A carrier with this MC or USDOT already exists.",
      };
    }
  }

  const id = createCarrier(input, user.id);

  const note = formData.get("note");
  if (typeof note === "string" && note.trim()) {
    createNote({ carrierId: id, userId: user.id, body: note });
  }

  revalidatePath("/carriers");
  redirect(`/carriers/${id}`);
}

export async function updateCarrierAction(
  _prev: CarrierFormState,
  formData: FormData,
): Promise<CarrierFormState> {
  const user = await requireUser();
  const id = Number(formData.get("id"));
  if (!Number.isInteger(id)) return { message: "Unknown carrier." };

  const carrier = getCarrier(id);
  if (!carrier) return { message: "Unknown carrier." };
  if (!can(user, "carrier:edit", carrier)) {
    return { message: "You can only edit carriers assigned to you." };
  }

  const { input, errors } = parseCarrierForm(formData, allowedIds());
  const values = echoValues(formData);
  if (Object.keys(errors).length > 0) {
    return { errors, values, message: "Fix the highlighted fields and try again." };
  }

  if (formData.get("confirm_duplicate") !== "yes") {
    const dupes = findDuplicates(
      input.mc_number as string | null,
      input.usdot as string | null,
      id,
    );
    if (dupes.mc.length > 0 || dupes.usdot.length > 0) {
      return {
        values,
        duplicates: { mc: summarize(dupes.mc), usdot: summarize(dupes.usdot) },
        message: "Another carrier already uses this MC or USDOT.",
      };
    }
  }

  // Editing resolves whatever the importer flagged, so clear the review marker.
  if (carrier.review_flags) input.review_flags = null;

  updateCarrier(id, input, user.id);

  const note = formData.get("note");
  if (typeof note === "string" && note.trim()) {
    createNote({ carrierId: id, userId: user.id, body: note });
  }

  revalidatePath("/carriers");
  revalidatePath(`/carriers/${id}`);
  redirect(`/carriers/${id}`);
}
