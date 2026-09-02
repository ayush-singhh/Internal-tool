import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { getInvoice, invoiceLines } from "@/lib/invoices";
import { setInvoiceStatusAction } from "@/lib/invoice-actions";
import { INVOICE_STATUS, INVOICE_STATUS_LABELS, INVOICE_STATUS_TONE } from "@/lib/constants";
import { formatDate, formatMoney } from "@/lib/format";
import { Badge, Card, CardHeader, Field, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Invoice" };

export default async function InvoicePage(props: PageProps<"/invoices/[id]">) {
  const { user, org } = await requireOrg();
  if (!can(user, "invoice:view")) redirect("/");

  const id = Number((await props.params).id);
  if (!Number.isInteger(id)) notFound();
  const invoice = getInvoice(org, id);
  if (!invoice) notFound();

  const mayManage = can(user, "invoice:manage");
  const lines = invoiceLines(org, id);

  return (
    <>
      <PageHeader
        title={`Invoice #${invoice.id}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={INVOICE_STATUS_TONE[invoice.status]}>{INVOICE_STATUS_LABELS[invoice.status]}</Badge>
            <span className="text-ink-500">{invoice.carrier_name}</span>
          </span>
        }
        actions={
          <Link
            href="/invoices"
            className="rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
          >
            All invoices
          </Link>
        }
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader title="Loads" subtitle="Dispatch fee per load, fixed at the time this invoice was created." />
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line bg-ink-50/70">
                    {["Load", "Delivered", "Final Load Amount", "Basis", "Dispatch Fee"].map((h) => (
                      <th key={h} scope="col" className="px-3 py-2 text-left text-xs font-semibold text-ink-600">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.id} className="border-b border-line/70 last:border-0">
                      <td className="px-3 py-2">
                        <Link href={`/loads/${line.load_id}`} className="font-medium text-brand-700 hover:underline">
                          {line.load_number || `Load #${line.load_id}`}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-ink-600">{formatDate(line.delivered_at?.slice(0, 10) ?? null)}</td>
                      <td className="px-3 py-2 font-mono tnum text-ink-900">{formatMoney(line.final_load_amount)}</td>
                      <td className="px-3 py-2 text-ink-600">
                        {line.fee_basis === "percentage" ? `${line.fee_rate}%` : formatMoney(line.fee_rate)}
                      </td>
                      <td className="px-3 py-2 font-mono tnum text-ink-900">{formatMoney(line.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4} className="px-3 py-2 text-right text-sm font-semibold text-ink-700">Total</td>
                    <td className="px-3 py-2 font-mono tnum text-sm font-semibold text-ink-900">{formatMoney(invoice.total_amount)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Record" />
            <dl className="grid gap-y-2">
              <Field label="Issued">{formatDate(invoice.issued_on)}</Field>
              <Field label="Paid">{formatDate(invoice.paid_on)}</Field>
              <Field label="Notes">{invoice.notes}</Field>
            </dl>
          </Card>

          {mayManage && (
            <Card>
              <CardHeader title="Status" />
              <form action={setInvoiceStatusAction} className="flex flex-wrap gap-2">
                <input type="hidden" name="id" value={invoice.id} />
                {Object.values(INVOICE_STATUS)
                  .filter((s) => s !== invoice.status)
                  .map((s) => (
                    <button
                      key={s}
                      name="status"
                      value={s}
                      className="rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-sm font-semibold text-ink-700 hover:bg-ink-50"
                    >
                      Mark {INVOICE_STATUS_LABELS[s]}
                    </button>
                  ))}
              </form>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
