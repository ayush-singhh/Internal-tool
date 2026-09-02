import "server-only";
import { get, run, transaction } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import { getCarrier } from "./carriers.ts";
import { lookup } from "./lookups.ts";
import { getLoad, finalLoadAmount } from "./loads.ts";
import { setStatus } from "./load-write.ts";
import { computeDispatchFee, round2 } from "./invoices.ts";
import { LOAD_STATUS, INVOICE_STATUS, type InvoiceStatus, type FeeBasis } from "./constants.ts";

export type CreateInvoiceInput = {
  carrierId: number;
  loadIds: number[];
  issuedOn: string;
  notes?: string | null;
};

export type InvoiceResult = { ok: true; id: number } | { ok: false; error: string };

/**
 * One dispatch invoice for one carrier, covering one or more Delivered loads. Amounts are
 * computed and snapshotted here — an invoice is a historical document, not a live view —
 * and every included load is advanced to Invoiced in the same transaction.
 *
 * Every load is re-validated here rather than trusted from the caller: carrier match,
 * Delivered status, and a real billable amount. `load:manage`'s create-load form already
 * re-validates its own referenced ids the same way (`belongs()` in `load-write.ts`).
 */
export function createInvoice(org: Org, input: CreateInvoiceInput, userId: number | null): InvoiceResult {
  if (input.loadIds.length === 0) return { ok: false, error: "Choose at least one load to invoice." };

  const carrier = getCarrier(org, input.carrierId);
  if (!carrier) return { ok: false, error: "Unknown carrier." };
  const pricingType = lookup(org, carrier.pricing_type_id)?.value ?? null;

  const lines: { loadId: number; finalAmount: number; basis: FeeBasis; rateValue: number; amount: number }[] = [];
  for (const loadId of input.loadIds) {
    const load = getLoad(org, loadId);
    if (!load) return { ok: false, error: `Load ${loadId} not found.` };
    if (load.carrier_id !== input.carrierId) {
      return { ok: false, error: `Load ${load.load_number ?? loadId} belongs to a different carrier.` };
    }
    if (load.status !== LOAD_STATUS.DELIVERED) {
      return { ok: false, error: `Load ${load.load_number ?? loadId} is not Delivered.` };
    }
    const amount = finalLoadAmount(load);
    if (amount === null) {
      return { ok: false, error: `Load ${load.load_number ?? loadId} has no billable amount yet.` };
    }
    const fee = computeDispatchFee({ pricingType, rate: carrier.rate, percentage: carrier.percentage }, amount);
    if (!fee.ok) return { ok: false, error: fee.error };
    lines.push({ loadId, finalAmount: amount, basis: fee.basis, rateValue: fee.rateValue, amount: fee.amount });
  }

  const total = round2(lines.reduce((sum, l) => sum + l.amount, 0));
  const now = new Date().toISOString();

  return transaction(() => {
    run(
      // ponytail: invoice_type is always 'dispatch' today — 'freight' (Carrier → Broker)
      // becomes real when that invoice ships; the column exists now so that doesn't need
      // its own migration.
      `INSERT INTO invoices (organization_id, invoice_type, carrier_id, status, issued_on, total_amount, notes, created_at, created_by, updated_at, updated_by)
       VALUES (?, 'dispatch', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [org.id, input.carrierId, INVOICE_STATUS.PENDING, input.issuedOn, total, input.notes?.trim() || null, now, userId, now, userId],
    );
    const invoiceId = get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;

    for (const line of lines) {
      run(
        `INSERT INTO invoice_lines (organization_id, invoice_id, load_id, final_load_amount, fee_basis, fee_rate, amount, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [org.id, invoiceId, line.loadId, line.finalAmount, line.basis, line.rateValue, line.amount, now],
      );
      const advanced = setStatus(org, line.loadId, LOAD_STATUS.INVOICED, userId);
      if (!advanced.ok) throw new Error(`Could not advance load ${line.loadId} to Invoiced: ${advanced.error}`);
    }
    return { ok: true as const, id: invoiceId };
  });
}

/**
 * Free transitions among pending / paid / disputed — not forward-only like a load's own
 * status, because a mistaken Paid has to be correctable. Moving *to* Paid advances every
 * included load from Invoiced to Paid (skipping one already moved on some other way);
 * moving *off* Paid never walks a load status backward — see the design doc §6.
 */
export function setInvoiceStatus(
  org: Org, id: number, status: InvoiceStatus, userId: number | null,
): InvoiceResult {
  const invoice = get<{ id: number }>("SELECT id FROM invoices WHERE organization_id = ? AND id = ?", [org.id, id]);
  if (!invoice) return { ok: false, error: "Unknown invoice." };
  const now = new Date().toISOString();

  return transaction(() => {
    run(
      `UPDATE invoices SET status = ?, paid_on = ?, updated_at = ?, updated_by = ?
        WHERE organization_id = ? AND id = ?`,
      [status, status === INVOICE_STATUS.PAID ? now : null, now, userId, org.id, id],
    );

    if (status === INVOICE_STATUS.PAID) {
      const rows = get<{ ids: string | null }>(
        `SELECT group_concat(load_id) AS ids FROM invoice_lines WHERE organization_id = ? AND invoice_id = ?`,
        [org.id, id],
      );
      for (const loadIdStr of (rows?.ids ?? "").split(",").filter(Boolean)) {
        const loadId = Number(loadIdStr);
        const load = get<{ status: string }>("SELECT status FROM loads WHERE organization_id = ? AND id = ?", [org.id, loadId]);
        if (load?.status === LOAD_STATUS.INVOICED) setStatus(org, loadId, LOAD_STATUS.PAID, userId);
      }
    }
    return { ok: true as const, id };
  });
}
