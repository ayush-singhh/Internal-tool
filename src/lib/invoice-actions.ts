"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrg } from "./auth.ts";
import { can } from "./permissions.ts";
import { createInvoice, setInvoiceStatus } from "./invoice-write.ts";
import { INVOICE_STATUS, type InvoiceStatus } from "./constants.ts";

export type InvoiceFormState = { error?: string };

export async function createInvoiceAction(_prev: InvoiceFormState, form: FormData): Promise<InvoiceFormState> {
  const { user, org } = await requireOrg();
  if (!can(user, "invoice:manage")) return { error: "You do not have permission to create invoices." };

  const carrierId = Number(form.get("carrier_id"));
  if (!Number.isInteger(carrierId)) return { error: "Choose a carrier." };
  const loadIds = form.getAll("load_id").map(Number).filter(Number.isInteger);
  const issuedOn = String(form.get("issued_on") ?? "").trim() || new Date().toISOString().slice(0, 10);
  const notes = String(form.get("notes") ?? "").trim() || null;

  const result = createInvoice(org, { carrierId, loadIds, issuedOn, notes }, user.id);
  if (!result.ok) return { error: result.error };

  revalidatePath("/invoices");
  revalidatePath("/loads");
  redirect(`/invoices/${result.id}`);
}

export async function setInvoiceStatusAction(form: FormData): Promise<void> {
  const { user, org } = await requireOrg();
  if (!can(user, "invoice:manage")) throw new Error("Not authorized to change this invoice's status.");

  const id = Number(form.get("id"));
  const status = String(form.get("status")) as InvoiceStatus;
  if (!Object.values(INVOICE_STATUS).includes(status)) throw new Error("Unknown invoice status.");
  if (Number.isInteger(id)) setInvoiceStatus(org, id, status, user.id);

  revalidatePath(`/invoices/${id}`);
  revalidatePath("/invoices");
  revalidatePath("/loads");
}
