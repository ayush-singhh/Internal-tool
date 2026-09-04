import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { receivables, payablesGap } from "@/lib/finance";
import { INVOICE_STATUS_LABELS, INVOICE_STATUS_TONE, type InvoiceStatus } from "@/lib/constants";
import { formatDate, formatMoney, pluralize } from "@/lib/format";
import { Badge, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { StatTile } from "@/components/charts";

export const metadata: Metadata = { title: "Billing" };

const TONE_BAR: Record<string, string> = {
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  orange: "bg-orange-500",
  red: "bg-red-500",
};

export default async function BillingPage() {
  const { user, org } = await requireOrg();
  // The whole invoicing lifecycle is administrators only, and this is the view over it.
  // Gating on `invoice:manage` rather than `invoice:view` keeps the two in step: a role
  // that may read one invoice has not thereby earned the ledger.
  if (!can(user, "invoice:manage")) redirect("/");

  const r = receivables(org);
  const gap = payablesGap();

  return (
    <>
      <PageHeader
        title="Billing"
        subtitle="What the dispatch fee has earned, and what is still owed."
        actions={
          <Link
            href="/invoices"
            className="rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-sm font-medium text-ink-700 transition hover:bg-ink-50"
          >
            All Invoices
          </Link>
        }
      />

      <div className="space-y-5">
        <section aria-label="Receivables" className="grid gap-3 grid-cols-2 lg:grid-cols-4">
          <StatTile
            label="Outstanding"
            value={formatMoney(r.outstanding)}
            emphasis
            hint={`${r.outstandingCount} ${pluralize(r.outstandingCount, "invoice")} unpaid`}
          />
          <StatTile
            label="Overdue"
            value={formatMoney(r.overdue)}
            tone={r.overdue > 0 ? "red" : "slate"}
            hint={`Past ${r.termDays} days · ${r.overdueCount} ${pluralize(r.overdueCount, "invoice")}`}
          />
          <StatTile
            label="Disputed"
            value={formatMoney(r.disputed)}
            tone={r.disputed > 0 ? "amber" : "slate"}
            hint={`${r.disputedCount} ${pluralize(r.disputedCount, "invoice")} in dispute`}
          />
          <StatTile
            label="Paid this month"
            value={formatMoney(r.paidThisMonth)}
            tone="green"
            hint="Settled since the 1st"
          />
        </section>

        {r.uninvoicedLoads > 0 && (
          <Link
            href="/invoices/new"
            className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm font-medium text-amber-800 transition hover:bg-amber-100"
          >
            {r.uninvoicedLoads} delivered {pluralize(r.uninvoicedLoads, "load")} not on any
            invoice — earned and not yet billed.
          </Link>
        )}

        <Card>
          <CardHeader
            title="Ageing"
            subtitle={`Unpaid invoices by how long they have been outstanding. Terms are ${r.termDays} days.`}
            action={
              <span className="tnum shrink-0 text-sm text-ink-500">{formatMoney(r.outstanding)}</span>
            }
          />
          {r.outstanding === 0 ? (
            <p className="py-6 text-center text-sm text-ink-400">Nothing outstanding.</p>
          ) : (
            <ul className="space-y-2.5">
              {r.buckets.map((b) => {
                const share = r.outstanding > 0 ? (b.amount / r.outstanding) * 100 : 0;
                return (
                  <li key={b.key}>
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="font-medium text-ink-800">
                        {b.label}
                        <span className="ml-2 text-xs font-normal text-ink-400">{b.description}</span>
                      </span>
                      <span className="tnum shrink-0 text-ink-900">
                        {formatMoney(b.amount)}
                        <span className="ml-2 text-xs text-ink-400">
                          {b.count} {pluralize(b.count, "invoice")}
                        </span>
                      </span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-ink-100">
                      <div
                        className={`h-full rounded-full ${TONE_BAR[b.tone] ?? "bg-ink-400"}`}
                        style={{ width: `${share}%` }}
                      />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card padded={false}>
          <div className="p-5 pb-0">
            <CardHeader
              title="Longest outstanding"
              subtitle="The oldest unpaid invoices, oldest first. These are the calls to make."
            />
          </div>
          {r.oldest.length === 0 ? (
            <div className="px-5 pb-5">
              <EmptyState title="Nothing unpaid" description="Every issued invoice has been settled." />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">Longest outstanding invoices</caption>
                <thead>
                  <tr className="border-b border-line bg-ink-50/70">
                    {["Carrier", "Issued", "Age", "Status", "Amount", ""].map((h) => (
                      <th
                        key={h}
                        scope="col"
                        className={`px-4 py-2.5 text-xs font-semibold text-ink-600 ${
                          h === "Amount" || h === "Age" ? "text-right" : "text-left"
                        }`}
                      >
                        {h === "" ? <span className="sr-only">Open</span> : h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {r.oldest.map((inv) => (
                    <tr key={inv.id} className="border-b border-line/70 last:border-0">
                      <td className="px-4 py-2.5 text-ink-900">{inv.carrier_name}</td>
                      <td className="px-4 py-2.5 text-ink-600">{formatDate(inv.issued_on)}</td>
                      <td
                        className={`tnum px-4 py-2.5 text-right ${
                          inv.days_outstanding > r.termDays ? "font-semibold text-red-700" : "text-ink-600"
                        }`}
                      >
                        {inv.days_outstanding}d
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone={INVOICE_STATUS_TONE[inv.status as InvoiceStatus]}>
                          {INVOICE_STATUS_LABELS[inv.status as InvoiceStatus] ?? inv.status}
                        </Badge>
                      </td>
                      <td className="tnum px-4 py-2.5 text-right font-medium text-ink-900">
                        {formatMoney(inv.total_amount)}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Link
                          href={`/invoices/${inv.id}`}
                          className="text-sm font-medium text-brand-700 hover:underline"
                        >
                          Open
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* The other half of "billing", said rather than faked. A finance screen that
            invents a payables figure out of columns meaning something else is worse than
            one that admits the ledger does not exist yet. */}
        <Card className="border-dashed">
          <CardHeader title={gap.title} subtitle="Accounts payable" />
          <div className="space-y-2.5">
            {gap.body.map((paragraph) => (
              <p key={paragraph.slice(0, 24)} className="text-sm leading-relaxed text-ink-600">
                {paragraph}
              </p>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
