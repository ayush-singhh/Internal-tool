import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { listLoads, rpm, type LoadFilters } from "@/lib/loads";
import {
  LOAD_STATUS_LABELS, LOAD_STATUS_ORDER, LOAD_STATUS_TONE,
  LOAD_EXCEPTION_LABELS, type LoadException, type LoadStatus,
} from "@/lib/constants";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icons";
import { Pagination } from "@/components/pagination";

export const metadata: Metadata = { title: "Load Management" };

const money = (n: number | null) =>
  n === null ? "—" : n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export default async function LoadsPage(props: PageProps<"/loads">) {
  const { user, org } = await requireOrg();
  if (!can(user, "load:view")) redirect("/");
  // The rate and both rates per mile are the guarded columns. Everything else on this
  // screen is safe for anyone who may see a load at all.
  const showRates = can(user, "load:rate");

  const sp = await props.searchParams;
  const one = (k: string) => {
    const v = sp[k];
    const s = Array.isArray(v) ? v[0] : v;
    return s && s.trim() ? s.trim() : undefined;
  };

  const status = one("status");
  const filters: LoadFilters = {
    q: one("q"),
    status: status && LOAD_STATUS_ORDER.includes(status as LoadStatus) ? [status as LoadStatus] : undefined,
    openOnly: one("open") === "1",
  };
  const page = Number.parseInt(one("page") ?? "1", 10);
  const { rows, total, pages, page: current, pageSize } = listLoads(org, filters, {
    page: Number.isInteger(page) && page > 0 ? page : 1,
  });

  const chip = (label: string, href: string, on: boolean) => (
    <Link
      key={label}
      href={href}
      className={`rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
        on
          ? "border-brand-300 bg-brand-50 text-brand-800"
          : "border-line-strong bg-surface text-ink-600 hover:bg-ink-50"
      }`}
    >
      {label}
    </Link>
  );

  return (
    <>
      <PageHeader
        title="Load Management"
        subtitle="Every load, newest first. Rates and rate per mile are shown to dispatch only."
        actions={
          can(user, "load:manage") && (
            <Link
              href="/loads/new"
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-brand-700"
            >
              <Icon name="plus" className="h-4 w-4" />
              Create Load
            </Link>
          )
        }
      />

      <form method="get" className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[15rem] flex-1">
          <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <input
            name="q"
            defaultValue={filters.q ?? ""}
            placeholder="Load number, commodity, carrier, driver, broker…"
            className="field w-full pl-9"
            aria-label="Search loads"
          />
        </div>
        <button type="submit" className="rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50">
          Search
        </button>
      </form>

      <div className="mb-4 flex flex-wrap gap-1.5">
        {chip("All", "/loads", !status && !filters.openOnly)}
        {chip("Open", "/loads?open=1", Boolean(filters.openOnly))}
        {LOAD_STATUS_ORDER.map((s) =>
          chip(LOAD_STATUS_LABELS[s], `/loads?status=${s}`, status === s),
        )}
      </div>

      <Card padded={false}>
        {rows.length === 0 ? (
          <EmptyState
            title="No loads yet"
            description="Loads appear here as dispatch creates them. Every load needs a carrier, at least one pickup and one delivery."
            action={
              can(user, "load:manage") && (
                <Link href="/loads/new" className="rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700">
                  Create the first load
                </Link>
              )
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-500">
                <tr>
                  <th className="px-4 py-2.5 font-semibold">Load</th>
                  <th className="px-4 py-2.5 font-semibold">Route</th>
                  <th className="px-4 py-2.5 font-semibold">Carrier</th>
                  <th className="px-4 py-2.5 font-semibold">Driver</th>
                  <th className="px-4 py-2.5 font-semibold">Status</th>
                  {showRates && <th className="px-4 py-2.5 text-right font-semibold">Rate</th>}
                  {showRates && <th className="px-4 py-2.5 text-right font-semibold">RPM</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((l) => {
                  const r = rpm(l);
                  return (
                    <tr key={l.id} className="hover:bg-paper-50">
                      <td className="px-4 py-2.5">
                        <Link href={`/loads/${l.id}`} className="font-medium text-brand-700 hover:underline">
                          {l.load_number || `#${l.id}`}
                        </Link>
                        {l.commodity && <div className="text-xs text-ink-400">{l.commodity}</div>}
                      </td>
                      <td className="px-4 py-2.5 text-ink-700">
                        {l.origin ?? "—"} → {l.destination ?? "—"}
                        {(l.pickup_count > 1 || l.delivery_count > 1) && (
                          <div className="text-xs text-ink-400">
                            {l.pickup_count} pick{l.pickup_count === 1 ? "" : "s"} ·{" "}
                            {l.delivery_count} drop{l.delivery_count === 1 ? "" : "s"}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-ink-700">{l.carrier_name}</td>
                      <td className="px-4 py-2.5 text-ink-700">{l.driver_name ?? "—"}</td>
                      <td className="px-4 py-2.5">
                        <Badge tone={LOAD_STATUS_TONE[l.status]}>{LOAD_STATUS_LABELS[l.status]}</Badge>
                        {l.exception && (
                          <Badge tone="red">{LOAD_EXCEPTION_LABELS[l.exception as LoadException]}</Badge>
                        )}
                      </td>
                      {showRates && <td className="tnum px-4 py-2.5 text-right text-ink-800">{money(l.rate)}</td>}
                      {showRates && (
                        <td className="tnum px-4 py-2.5 text-right text-ink-600">
                          {r.total === null ? "—" : `$${r.total.toFixed(2)}`}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {pages > 1 && (
        <Pagination
          basePath="/loads"
          params={sp}
          page={current}
          pages={pages}
          total={total}
          pageSize={pageSize}
        />
      )}
    </>
  );
}
