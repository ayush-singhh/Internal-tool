import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { parseReportKey, runReport, visibleReports } from "@/lib/reports";
import { formatMoney } from "@/lib/format";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import { BarList, TrendChart } from "@/components/charts";
import { Icon } from "@/components/icons";

export const metadata: Metadata = { title: "Reports" };

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const GROUPS = ["Team", "Portfolio", "Commercial", "Movement", "Dispatch", "Money"] as const;

export default async function ReportsPage(props: PageProps<"/reports">) {
  const { user, org } = await requireOrg();

  // This page had no permission check at all — it took `org` from the session and served
  // every figure to anyone who typed the URL, sidebar or no sidebar. Each report now names
  // the action that reveals it, so a role with none of them gets nowhere near the data.
  const allowed = visibleReports(user);
  if (allowed.length === 0) redirect("/");

  const sp = await props.searchParams;
  const one = (k: string) => {
    const v = sp[k];
    const s = Array.isArray(v) ? v[0] : v;
    return s && ISO.test(s) ? s : undefined;
  };

  const asked = parseReportKey(Array.isArray(sp.r) ? sp.r[0] : sp.r);
  // A report they may not run falls back to their first, rather than 403-ing on a link
  // they never followed — the default key is a carrier report, and dispatch has those.
  const key = allowed.some((r) => r.key === asked) ? asked : allowed[0]!.key;
  const from = one("from");
  const to = one("to");
  const result = runReport(org, key, { from, to });
  const value = (n: number) => (result.def.money ? formatMoney(n) : n.toLocaleString());

  const query = new URLSearchParams({ r: key });
  if (from) query.set("from", from);
  if (to) query.set("to", to);

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle={`${allowed.length} standard reports. Filter by date where the question is historical, then export.`}
      />

      <div className="grid gap-5 lg:grid-cols-[15rem_1fr]">
        <nav aria-label="Reports" className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          {GROUPS.map((group) => {
            const items = allowed.filter((r) => r.group === group);
            if (items.length === 0) return null;
            return (
              <div key={group}>
                <p className="mb-1.5 px-2 text-[0.65rem] font-semibold uppercase tracking-[0.12em] text-ink-400">
                  {group}
                </p>
                <ul className="space-y-0.5">
                  {items.map((r) => {
                    const active = r.key === key;
                    const params = new URLSearchParams({ r: r.key });
                    if (from) params.set("from", from);
                    if (to) params.set("to", to);
                    return (
                      <li key={r.key}>
                        <Link
                          href={`/reports?${params}`}
                          aria-current={active ? "page" : undefined}
                          className={`block rounded-md px-2.5 py-1.5 text-[0.82rem] transition ${
                            active
                              ? "bg-brand-50 font-semibold text-brand-800 ring-1 ring-inset ring-brand-200"
                              : "text-ink-600 hover:bg-ink-100 hover:text-ink-900"
                          }`}
                        >
                          {r.title}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </nav>

        <div className="min-w-0 space-y-4">
          <Card>
            <form method="get" action="/reports" className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="r" value={key} />
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
                <Link
                  href={`/reports?r=${key}`}
                  className="text-[0.8rem] font-medium text-ink-500 hover:text-ink-900"
                >
                  Clear dates
                </Link>
              )}
              {!result.def.dated && (
                <p className="text-xs text-ink-400">
                  This report reflects the present, so the date range does not apply.
                </p>
              )}
              <Link
                href={`/api/export/report?${query}`}
                className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 py-[0.42rem] text-[0.82rem] font-medium text-ink-700 transition hover:bg-ink-50"
              >
                <Icon name="download" className="h-4 w-4" />
                Export CSV
              </Link>
            </form>
          </Card>

          <Card>
            <CardHeader
              title={result.def.title}
              subtitle={result.def.description}
              action={
                <span className="tnum shrink-0 text-sm text-ink-500">
                  {result.def.key === "retention" ? "" : `${value(result.total)} total`}
                </span>
              }
            />

            {result.trend ? (
              <TrendChart data={result.trend} label={result.def.title} height={190} />
            ) : (
              <BarList data={result.rows} emptyLabel="No data for this range" />
            )}
          </Card>

          <Card padded={false}>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <caption className="sr-only">{result.def.title}</caption>
                <thead>
                  <tr className="border-b border-line bg-ink-50/70">
                    <th scope="col" className="px-4 py-2.5 text-left text-xs font-semibold text-ink-600">
                      {result.def.dimension}
                    </th>
                    <th scope="col" className="px-4 py-2.5 text-right text-xs font-semibold text-ink-600">
                      {result.def.unit}
                    </th>
                    <th scope="col" className="px-4 py-2.5 text-right text-xs font-semibold text-ink-600">
                      Share
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="px-4 py-8 text-center text-sm text-ink-400">
                        No data for this range.
                      </td>
                    </tr>
                  ) : (
                    result.rows.map((row) => (
                      <tr key={row.label} className="border-b border-line/70 last:border-0">
                        <td className="px-4 py-2 text-ink-800">{row.label}</td>
                        <td className="tnum px-4 py-2 text-right font-medium text-ink-900">
                          {value(row.value)}
                        </td>
                        <td className="tnum px-4 py-2 text-right text-ink-500">
                          {result.total > 0 && result.def.key !== "retention"
                            ? `${Math.round((row.value / result.total) * 100)}%`
                            : "—"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
