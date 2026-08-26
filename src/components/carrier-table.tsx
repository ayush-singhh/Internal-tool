import Link from "next/link";
import type { ReactNode } from "react";
import { COLUMN_MAP, type ColumnKey } from "@/lib/columns";
import { buildQuery, type RawParams } from "@/lib/query";
import type { DecoratedCarrier } from "@/lib/carriers";
import { reviewFlags } from "@/lib/carriers";
import { formatDate, formatMoney, formatPhone, formatPricing, relativeTime } from "@/lib/format";
import { Badge } from "./ui";
import { Icon } from "./icons";

function cell(row: DecoratedCarrier, key: ColumnKey): ReactNode {
  const d = row.d;
  switch (key) {
    case "serial":
      return row.serial ? <span className="tnum text-ink-500">{row.serial}</span> : null;
    case "legal_name":
      return (
        <Link
          href={`/carriers/${row.id}`}
          className="font-medium text-ink-900 underline-offset-2 hover:text-brand-700 hover:underline"
        >
          {row.legal_name}
        </Link>
      );
    case "owner_name": return row.owner_name;
    case "status":
      return d.status ? <Badge tone={d.statusTone} dot>{d.status.label}</Badge> : null;
    case "dispatcher": return row.dispatcher_name;
    case "account_manager": return row.account_manager_name;
    case "phone":
      return row.phone ? (
        <a href={`tel:${row.phone_digits ?? row.phone}`} className="tnum hover:text-brand-700">
          {formatPhone(row.phone)}
        </a>
      ) : null;
    case "email":
      return row.email ? (
        <a href={`mailto:${row.email}`} className="hover:text-brand-700">{row.email}</a>
      ) : null;
    case "address":
      return row.address ? <span className="line-clamp-2">{row.address}</span> : null;
    case "mc_number": return row.mc_number ? <span className="tnum">{row.mc_number}</span> : null;
    case "usdot": return row.usdot ? <span className="tnum">{row.usdot}</span> : null;
    case "trailer_type": return d.trailerType?.label;
    case "trailer_size": return row.trailer_size;
    case "truck_count":
      return row.truck_count == null ? null : <span className="tnum">{row.truck_count}</span>;
    case "born_date": return formatDate(row.born_date);
    case "onboarding_date": return formatDate(row.onboarding_date);
    case "onboarding_type": return d.onboardingType?.label;
    case "lead_source": return d.leadSource?.label;
    case "first_load_date": return formatDate(row.first_load_date);
    case "plan": return d.plan?.label;
    case "pricing_type": return d.pricingType?.label;
    case "pricing":
      return formatPricing({
        pricingType: d.pricingType?.label ?? null,
        planName: d.plan?.label ?? null,
        rate: row.rate,
        percentage: row.percentage,
        billingFrequency: d.billingFrequency?.label ?? null,
      });
    case "percentage":
      return row.percentage == null ? null : <span className="tnum">{row.percentage}%</span>;
    case "rate":
      return row.rate == null ? null : <span className="tnum">{formatMoney(row.rate)}</span>;
    case "subscription":
      return d.subscription ? <Badge tone={d.subscription.tone}>{d.subscription.label}</Badge> : null;
    case "agreement_status":
      return d.agreementStatus ? (
        <Badge tone={d.agreementStatus.tone}>{d.agreementStatus.label}</Badge>
      ) : null;
    case "invoice_mode": return d.invoiceMode?.label;
    case "updated_at":
      return <span className="text-ink-500">{relativeTime(row.updated_at)}</span>;
  }
}

export function CarrierTable({
  rows,
  columns,
  params,
  basePath,
}: {
  rows: DecoratedCarrier[];
  columns: ColumnKey[];
  params: RawParams;
  basePath: string;
}) {
  const currentSort = Array.isArray(params.sort) ? params.sort[0] : params.sort;
  const currentDir = (Array.isArray(params.dir) ? params.dir[0] : params.dir) === "desc" ? "desc" : "asc";

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-max border-collapse text-sm">
        <thead>
          <tr className="border-b border-line bg-ink-50/70">
            {columns.map((key) => {
              const col = COLUMN_MAP.get(key)!;
              const sorted = col.sort && currentSort === col.sort;
              const nextDir = sorted && currentDir === "asc" ? "desc" : "asc";
              const content = (
                <span className="inline-flex items-center gap-1">
                  {col.label}
                  {col.sort && (
                    <span
                      className={`transition ${sorted ? "text-brand-600" : "text-ink-300"}`}
                      aria-hidden="true"
                    >
                      {sorted ? (
                        <svg viewBox="0 0 12 12" className="h-3 w-3" fill="currentColor">
                          <path d={currentDir === "asc" ? "M6 3 9.5 8h-7z" : "M6 9 2.5 4h7z"} />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 12 12" className="h-3 w-3" fill="currentColor" opacity="0.55">
                          <path d="M6 2 8.6 5.4H3.4zM6 10 3.4 6.6h5.2z" />
                        </svg>
                      )}
                    </span>
                  )}
                </span>
              );
              return (
                <th
                  key={key}
                  scope="col"
                  aria-sort={sorted ? (currentDir === "asc" ? "ascending" : "descending") : undefined}
                  className={`whitespace-nowrap px-3 py-2.5 text-xs font-semibold text-ink-600 ${
                    col.align === "right" ? "text-right" : "text-left"
                  } ${col.locked ? "sticky left-0 z-10 bg-ink-50/95 backdrop-blur-sm" : ""}`}
                >
                  {col.sort ? (
                    <Link
                      href={`${basePath}${buildQuery(params, { sort: col.sort, dir: nextDir })}`}
                      className="hover:text-ink-900"
                    >
                      {content}
                    </Link>
                  ) : (
                    content
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const flags = reviewFlags(row);
            return (
              <tr key={row.id} className="group border-b border-line/70 last:border-0 hover:bg-brand-50/40">
                {columns.map((key) => {
                  const col = COLUMN_MAP.get(key)!;
                  return (
                    <td
                      key={key}
                      className={`max-w-[22rem] px-3 py-2.5 align-middle text-ink-700 ${
                        col.align === "right" ? "text-right" : ""
                      } ${
                        col.locked
                          ? "sticky left-0 z-10 bg-surface group-hover:bg-[color-mix(in_srgb,var(--color-brand-50)_40%,white)]"
                          : ""
                      }`}
                    >
                      <span className="flex items-center gap-1.5">
                        {cell(row, key) ?? <span className="text-ink-300">—</span>}
                        {col.locked && flags.length > 0 && (
                          <span
                            title={`Flagged for review: ${flags.join("; ")}`}
                            className="shrink-0 text-amber-500"
                          >
                            <Icon name="warning" className="h-3.5 w-3.5" />
                          </span>
                        )}
                      </span>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
