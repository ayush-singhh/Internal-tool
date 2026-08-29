import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { AUDIT_LABELS, recentAudit, type AuditAction } from "@/lib/audit";
import { relativeTime } from "@/lib/format";
import { Card, EmptyState, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Audit log" };

export default async function AuditPage() {
  const { user, org } = await requireOrg();
  if (!can(user, "team:manage")) redirect("/");

  const entries = recentAudit(org, 300);

  return (
    <>
      <PageHeader
        title="Audit log"
        subtitle="Who signed in, who changed who can sign in, and who took data out. Append-only — nothing here can be edited or removed."
      />
      <Card>
        {entries.length === 0 ? (
          <EmptyState title="Nothing recorded yet" description="Sign-ins and account changes appear here as they happen." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">When</th>
                  <th className="px-4 py-2.5 font-semibold">Who</th>
                  <th className="px-4 py-2.5 font-semibold">What</th>
                  <th className="px-4 py-2.5 font-semibold">Details</th>
                  <th className="px-4 py-2.5 font-semibold">From</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {entries.map((e) => (
                  <tr key={e.id} className="hover:bg-paper-50">
                    <td className="whitespace-nowrap px-4 py-2 text-ink-500" title={e.created_at}>
                      {relativeTime(e.created_at)}
                    </td>
                    <td className="px-4 py-2 text-ink-800">{e.user_name ?? "—"}</td>
                    <td className="px-4 py-2 text-ink-800">
                      {AUDIT_LABELS[e.action as AuditAction] ?? e.action}
                    </td>
                    <td className="px-4 py-2 text-ink-600">
                      {[e.subject, e.detail].filter(Boolean).join(" · ") || "—"}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-ink-400">{e.ip ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
