import "server-only";
import { all, get } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import { listLoads, type LoadRow } from "./loads.ts";
import { LOAD_STATUS, FEE_BASIS, type FeeBasis, type InvoiceStatus } from "./constants.ts";

/**
 * Dispatch invoices: reads, and the pure dispatch-fee calculation. Writes (creating one,
 * changing its status) live in `invoice-write.ts` — same split as `loads.ts`/`load-write.ts`.
 */

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type DispatchFeeResult =
  | { ok: true; basis: FeeBasis; rateValue: number; amount: number }
  | { ok: false; error: string };

/**
 * The Asterism → Carrier dispatch fee for one load, from the carrier's configured pricing
 * arrangement, applied to Final Load Amount — after approved deductions/extra pay, per
 * the carrier agreement, not the raw linehaul rate.
 */
export function computeDispatchFee(
  carrier: { pricingType: string | null; rate: number | null; percentage: number | null },
  finalLoadAmount: number,
): DispatchFeeResult {
  if (carrier.pricingType === "percentage_per_load") {
    if (carrier.percentage === null) {
      return { ok: false, error: "This carrier has no dispatch percentage configured." };
    }
    return {
      ok: true,
      basis: FEE_BASIS.PERCENTAGE,
      rateValue: carrier.percentage,
      amount: round2((carrier.percentage / 100) * finalLoadAmount),
    };
  }
  if (carrier.pricingType === "flat_per_load") {
    if (carrier.rate === null) {
      return { ok: false, error: "This carrier has no flat dispatch fee configured." };
    }
    return { ok: true, basis: FEE_BASIS.FLAT, rateValue: carrier.rate, amount: round2(carrier.rate) };
  }
  return {
    ok: false,
    error:
      "This carrier's pricing arrangement does not support automatic per-load dispatch " +
      "invoicing. Set it to Percentage Per Load or Flat Fee Per Load first.",
  };
}

/** Delivered loads for one carrier, not yet on any invoice — status forward-only means a
 *  load already invoiced can never reappear here. */
export function listInvoiceableLoads(org: Org, carrierId: number): LoadRow[] {
  return listLoads(org, { carrier: [carrierId], status: [LOAD_STATUS.DELIVERED] }, { pageSize: 200 }).rows;
}

export type InvoiceRow = {
  id: number;
  organization_id: number;
  invoice_type: string;
  carrier_id: number;
  status: InvoiceStatus;
  issued_on: string;
  paid_on: string | null;
  total_amount: number;
  notes: string | null;
  created_at: string;
  created_by: number | null;
  updated_at: string;
  updated_by: number | null;
  carrier_name: string;
};

export type InvoiceLineRow = {
  id: number;
  invoice_id: number;
  load_id: number;
  final_load_amount: number;
  fee_basis: FeeBasis;
  fee_rate: number;
  amount: number;
  created_at: string;
  load_number: string | null;
  delivered_at: string | null;
};

const INVOICE_SELECT = `
  SELECT i.*, c.legal_name AS carrier_name
    FROM invoices i JOIN carriers c ON c.organization_id = i.organization_id AND c.id = i.carrier_id
`;

export function listInvoices(
  org: Org,
  filters: { carrierId?: number; status?: InvoiceStatus } = {},
): InvoiceRow[] {
  const clauses = ["i.organization_id = ?"];
  const params: unknown[] = [org.id];
  if (filters.carrierId) { clauses.push("i.carrier_id = ?"); params.push(filters.carrierId); }
  if (filters.status) { clauses.push("i.status = ?"); params.push(filters.status); }
  return all<InvoiceRow>(
    `${INVOICE_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY i.issued_on DESC, i.id DESC`,
    params,
  );
}

export function getInvoice(org: Org, id: number): InvoiceRow | undefined {
  return get<InvoiceRow>(`${INVOICE_SELECT} WHERE i.organization_id = ? AND i.id = ?`, [org.id, id]);
}

export function invoiceLines(org: Org, invoiceId: number): InvoiceLineRow[] {
  return all<InvoiceLineRow>(
    `SELECT il.*, l.load_number, l.delivered_at
       FROM invoice_lines il JOIN loads l ON l.organization_id = il.organization_id AND l.id = il.load_id
      WHERE il.organization_id = ? AND il.invoice_id = ?
      ORDER BY il.id`,
    [org.id, invoiceId],
  );
}

/** The invoice a load is on, if any — for a link back from the load's own page. */
export function invoiceForLoad(org: Org, loadId: number): { id: number; status: InvoiceStatus } | undefined {
  return get<{ id: number; status: InvoiceStatus }>(
    `SELECT i.id, i.status FROM invoice_lines il
       JOIN invoices i ON i.organization_id = il.organization_id AND i.id = il.invoice_id
      WHERE il.organization_id = ? AND il.load_id = ?`,
    [org.id, loadId],
  );
}
