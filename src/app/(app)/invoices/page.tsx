import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { listInvoices } from "@/lib/invoices";
import { INVOICE_STATUS_LABELS, INVOICE_STATUS_TONE } from "@/lib/constants";
import { formatDate, formatMoney } from "@/lib/format";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Invoices" };

export default async function InvoicesPage() {
  const { user, org } = await requireOrg();
  if (!can(user, "invoice:view")) redirect("/");
  const mayManage = can(user, "invoice:manage");

  const invoices = listInvoices(org);

  return (
    <>
      <PageHeader
        title="Invoices"
        subtitle="Asterism's dispatch fee, billed to the carrier."
        actions={
          mayManage ? (
            <Link
              href="/invoices/new"
              className="rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700"
            >
              Create Invoice
            </Link>
          ) : undefined
        }
      />
      {invoices.length === 0 ? (
        <EmptyState
          title="No invoices yet"
          description="Once a load is Delivered, it can be included on a dispatch invoice."
        />
      ) : (
        <Card padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-line bg-ink-50/70">
                  {["Carrier", "Issued", "Status", "Total", ""].map((h) => (
                    <th key={h} scope="col" className="px-4 py-2.5 text-left text-xs font-semibold text-ink-600">
                      {h === "" ? <span className="sr-only">Open</span> : h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} className="border-b border-line/70 last:border-0">
                    <td className="px-4 py-2.5 text-ink-900">{inv.carrier_name}</td>
                    <td className="px-4 py-2.5 text-ink-600">{formatDate(inv.issued_on)}</td>
                    <td className="px-4 py-2.5">
                      <Badge tone={INVOICE_STATUS_TONE[inv.status]}>{INVOICE_STATUS_LABELS[inv.status]}</Badge>
                    </td>
                    <td className="px-4 py-2.5 font-mono tnum text-ink-900">{formatMoney(inv.total_amount)}</td>
                    <td className="px-4 py-2.5 text-right">
                      <Link href={`/invoices/${inv.id}`} className="text-sm font-medium text-brand-700 hover:underline">
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
