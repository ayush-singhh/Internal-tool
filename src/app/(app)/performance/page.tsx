import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { teamPerformance, performanceTotals, type PerformanceRow } from "@/lib/finance";
import { ROLE_LABELS, type Role } from "@/lib/constants";
import { formatMoney } from "@/lib/format";
import { Card, EmptyState, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Team Performance" };

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Column order, and what each one is counting. The header explains itself rather than
 *  making a reader guess whether "Loads" means booked or delivered. */
const COLUMNS: { key: keyof PerformanceRow; label: string; hint: string; money?: boolean }[] = [
  { key: "carriers", label: "Carriers", hint: "Held as dispatcher or account manager" },
  { key: "loads", label: "Loads", hint: "Booked in the period" },
  { key: "loadsDelivered", label: "Delivered", hint: "Reached delivery or past it" },
  { key: "revenue", label: "Dispatch fee", hint: "Invoiced on their loads", money: true },
  { key: "leads", label: "Leads", hint: "Submitted in the period" },
  { key: "leadsConverted", label: "Converted", hint: "Became carrier records" },
  { key: "tasksOpen", label: "Tasks open", hint: "Assigned and unfinished, right now" },
  { key: "tasksDone", label: "Tasks done", hint: "Completed in the period" },
];

export default async function PerformancePage(props: PageProps<"/performance">) {
  const { user, org } = await requireOrg();
  // Reading one person's output against another's is a management act, so it sits behind
  // the same permission as the Team page itself.
  if (!can(user, "team:manage")) redirect("/");

  const sp = await props.searchParams;
  const one = (k: string) => {
    const v = sp[k];
    const s = Array.isArray(v) ? v[0] : v;
    return s && ISO.test(s) ? s : undefined;
  };
  const from = one("from");
  const to = one("to");

  const rows = teamPerformance(org, { from, to });
  const totals = performanceTotals(rows);

  return (
    <>
      <PageHeader
        title="Team Performance"
        subtitle="One row per active person. Everything here is counted from records they already own."
      />

      <div className="space-y-4">
        <Card>
          <form method="get" action="/performance" className="flex flex-wrap items-end gap-3">
            <div>
              <label className="label" htmlFor="from">From</label>
              <input id="from" name="from" type="date" defaultValue={from ?? ""} className="field field-sm" />
            </div>
            <div>
              <label className="label" htmlFor="to">To</label>
              <input id="to" name="to" type="date" defaultValue={to ?? ""} className="field field-sm" />
            </div>
            <button
              type="submit"
              className="rounded-lg bg-brand-600 px-3.5 py-[0.42rem] text-[0.82rem] font-semibold text-white transition hover:bg-brand-700"
            >
              Apply
            </button>
            {(from || to) && (
              <Link href="/performance" className="text-[0.8rem] font-medium text-ink-500 hover:text-ink-900">
                Clear dates
              </Link>
            )}
            {/* Said out loud, because a range that silently applied to some columns and
                not others is exactly how a performance report gets misread. */}
            <p className="text-xs text-ink-400">
              The range narrows what happened — loads, leads, fees and completed tasks.
              Carriers held and tasks still open describe today, so it leaves them alone.
            </p>
          </form>
        </Card>

        {rows.length === 0 ? (
          <EmptyState
            title="Nobody to measure yet"
            description="Invite the team and their work will be counted here."
          />
        ) : (
          <Card padded={false}>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">Team performance</caption>
                <thead>
                  <tr className="border-b border-line bg-ink-50/70">
                    <th scope="col" className="px-4 py-2.5 text-left text-xs font-semibold text-ink-600">
                      Person
                    </th>
                    {COLUMNS.map((c) => (
                      <th
                        key={c.key}
                        scope="col"
                        title={c.hint}
                        className="px-4 py-2.5 text-right text-xs font-semibold text-ink-600"
                      >
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={row.id} className="border-b border-line/70">
                      <th scope="row" className="px-4 py-2.5 text-left font-normal">
                        <span className="font-medium text-ink-900">{row.name}</span>
                        <span className="ml-2 text-xs text-ink-400">
                          {ROLE_LABELS[row.role as Role] ?? row.role}
                        </span>
                      </th>
                      {COLUMNS.map((c) => {
                        const value = row[c.key] as number;
                        return (
                          <td
                            key={c.key}
                            className={`tnum px-4 py-2.5 text-right ${
                              value === 0 ? "text-ink-300" : "text-ink-900"
                            }`}
                          >
                            {c.money ? formatMoney(value) : value.toLocaleString()}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                  <tr className="bg-ink-50/70">
                    <th scope="row" className="px-4 py-2.5 text-left text-xs font-semibold text-ink-600">
                      Total
                    </th>
                    {COLUMNS.map((c) => {
                      const value = totals[c.key as keyof typeof totals];
                      return (
                        <td key={c.key} className="tnum px-4 py-2.5 text-right font-semibold text-ink-900">
                          {c.money ? formatMoney(value) : value.toLocaleString()}
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
