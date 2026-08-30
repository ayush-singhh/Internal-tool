import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSupport } from "@/lib/auth";
import { listCarriers, withLookups } from "@/lib/carriers";
import { formatPhone } from "@/lib/format";
import { recordAccess, tenant, tenantHandle } from "@/lib/support";
import { Badge, Card } from "@/components/ui";

export const metadata: Metadata = { title: "Organisation", robots: { index: false } };

export default async function SupportTenantPage(props: PageProps<"/support/[orgId]">) {
  const user = await requireSupport();
  const orgId = Number((await props.params).orgId);
  const summary = Number.isInteger(orgId) ? tenant(orgId) : undefined;
  if (!summary) notFound();

  // Recorded before anything is read, so a render that fails is still a look at the data.
  recordAccess(user.id, orgId, `/support/${orgId}`);

  const org = tenantHandle(orgId);
  const { rows, total } = listCarriers(org, {}, { page: 1, pageSize: 100 });
  const carriers = withLookups(org, rows);

  return (
    <div className="space-y-5">
      <div>
        <Link href="/support" className="text-xs text-ink-500 underline hover:text-ink-800">
          ← All organisations
        </Link>
        <h1 className="mt-2 text-xl font-semibold tracking-tight text-ink-900">{summary.name}</h1>
        <p className="mt-1 text-sm text-ink-500">
          {summary.users} people · {summary.carriers} carriers · created{" "}
          {summary.created_at.slice(0, 10)}
          {total > carriers.length && ` · showing the first ${carriers.length}`}
        </p>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Carrier</th>
                <th className="px-4 py-2.5 font-semibold">Status</th>
                <th className="px-4 py-2.5 font-semibold">Owner</th>
                <th className="px-4 py-2.5 font-semibold">Phone</th>
                <th className="px-4 py-2.5 font-semibold">MC</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {carriers.map((c) => (
                <tr key={c.id} className="hover:bg-paper-50">
                  <td className="px-4 py-2.5">
                    <Link
                      href={`/support/${orgId}/carriers/${c.id}`}
                      className="font-medium text-brand-700 hover:underline"
                    >
                      {c.legal_name}
                    </Link>
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={c.d.statusTone}>{c.d.status?.label ?? "—"}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-ink-700">{c.owner_name ?? "—"}</td>
                  <td className="px-4 py-2.5 text-ink-700">{formatPhone(c.phone)}</td>
                  <td className="tnum px-4 py-2.5 text-ink-700">{c.mc_number ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {carriers.length === 0 && (
          <p className="px-4 py-6 text-sm text-ink-500">This organisation has no carriers yet.</p>
        )}
      </Card>
    </div>
  );
}
