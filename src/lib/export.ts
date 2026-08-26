import "server-only";
import { toCsv } from "./csv.ts";
import { decorate, type CarrierRow } from "./carriers.ts";
import { formatPhone, formatPricing } from "./format.ts";

/** Export carries every field, not just the visible columns — the filter chooses the
 *  rows, the export gives you the whole record so nothing has to be re-queried. */
const HEADERS = [
  "Carrier ID", "Legal Name", "Owner Name", "Status", "Dispatcher", "Account Manager",
  "Phone", "Email", "Address",
  "MC Number", "USDOT", "Trailer Type", "Trailer Size", "Trucks/Trailers",
  "Carrier Born Date", "Onboarding Date", "Onboarding Type", "Lead Source", "First Load Date",
  "Plan", "Pricing Type", "Rate", "Percentage", "Billing Frequency", "Pricing Summary",
  "Subscription", "Agreement Status", "Invoice Collection Mode",
  "Offboarded On", "Flagged For Review", "Created At", "Last Updated",
];

export function carriersToCsv(rows: CarrierRow[]): string {
  const body = rows.map((r) => {
    const d = decorate(r);
    return [
      r.serial, r.legal_name, r.owner_name, d.status?.label,
      r.dispatcher_name, r.account_manager_name,
      formatPhone(r.phone), r.email, r.address,
      r.mc_number, r.usdot, d.trailerType?.label, r.trailer_size, r.truck_count,
      r.born_date, r.onboarding_date, d.onboardingType?.label, d.leadSource?.label,
      r.first_load_date,
      d.plan?.label, d.pricingType?.label, r.rate, r.percentage,
      d.billingFrequency?.label,
      formatPricing({
        pricingType: d.pricingType?.label ?? null,
        planName: d.plan?.label ?? null,
        rate: r.rate,
        percentage: r.percentage,
        billingFrequency: d.billingFrequency?.label ?? null,
      }),
      d.subscription?.label, d.agreementStatus?.label, d.invoiceMode?.label,
      r.offboarded_on, r.review_flags ? "Yes" : "", r.created_at, r.updated_at,
    ];
  });
  return toCsv([HEADERS, ...body]);
}

export function csvResponse(csv: string, filename: string): Response {
  // The BOM makes Excel open UTF-8 exports without mangling accented names.
  return new Response(`﻿${csv}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

export function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}
