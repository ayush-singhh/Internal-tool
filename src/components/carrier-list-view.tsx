import { cookies } from "next/headers";
import Link from "next/link";
import { listCarriers, withLookups, type CarrierFilters } from "@/lib/carriers";
import { parseFilters, parseListOptions, countActiveFilters, type RawParams, type FilterParam } from "@/lib/query";
import { parseColumns } from "@/lib/columns";
import { options as lookupOptions } from "@/lib/lookups";
import { all } from "@/lib/db";
import { requireOrg } from "@/lib/auth";
import { STATUS } from "@/lib/constants";
import { idOf } from "@/lib/lookups";
import { CarrierTable } from "./carrier-table";
import { CarrierToolbar, type Option, type QuickFilter, type SavedFilter } from "./carrier-toolbar";
import { Pagination } from "./pagination";
import { Card, EmptyState, PageHeader } from "./ui";

const QUICK_ORDER = [
  STATUS.ACTIVE,
  STATUS.ABOUT_TO_BE_ACTIVE,
  STATUS.PENDING_INVESTIGATION,
  STATUS.INACTIVE,
  STATUS.SUSPENDED,
  STATUS.BLACKLISTED,
  STATUS.BACK_OFF,
];

const QUICK_LABELS: Record<string, string> = {
  [STATUS.ABOUT_TO_BE_ACTIVE]: "About to Be Active",
  [STATUS.PENDING_INVESTIGATION]: "Investigation",
  [STATUS.BACK_OFF]: "Back-off",
};

/** One implementation behind /carriers and every preset view; they differ only in
 *  the status group they pin and the copy at the top. */
export async function CarrierListView({
  basePath,
  title,
  subtitle,
  searchParams,
  group,
  showQuickFilters = false,
}: {
  basePath: string;
  title: string;
  subtitle?: string;
  searchParams: RawParams;
  group?: CarrierFilters["group"];
  showQuickFilters?: boolean;
}) {
  const { user, org } = await requireOrg();
  const filters = parseFilters(searchParams, group);
  const listOpts = parseListOptions(searchParams);
  const { rows, total, page, pages, pageSize } = listCarriers(org, filters, listOpts);
  const columns = parseColumns((await cookies()).get("ch_cols")?.value);

  const team = all<{ id: number; name: string }>(
    "SELECT id, name FROM users WHERE organization_id = ? AND active = 1 ORDER BY name",
    [org.id],
  );
  const teamOptions: Option[] = team.map((t) => ({ id: t.id, label: t.name }));
  const toOptions = (kind: Parameters<typeof lookupOptions>[1]): Option[] =>
    lookupOptions(org, kind).map((l) => ({ id: l.id, label: l.label, tone: l.tone }));

  const options: Record<FilterParam, Option[]> = {
    status: toOptions("status"),
    dispatcher: teamOptions,
    am: teamOptions,
    source: toOptions("lead_source"),
    otype: toOptions("onboarding_type"),
    trailer: toOptions("trailer_type"),
    plan: toOptions("plan"),
    pricing: toOptions("pricing_type"),
    agreement: toOptions("agreement_status"),
    sub: toOptions("subscription"),
    invoice: toOptions("invoice_mode"),
  };

  const quickFilters: QuickFilter[] | undefined = showQuickFilters
    ? [
        { id: null, label: "All" } satisfies QuickFilter,
        ...QUICK_ORDER.flatMap<QuickFilter>((value) => {
          const id = idOf(org, "status", value);
          const opt = id ? options.status.find((o) => o.id === id) : undefined;
          if (!id || !opt) return [];
          return [{ id, label: QUICK_LABELS[value] ?? opt.label, tone: opt.tone }];
        }),
      ]
    : undefined;

  const savedFilters = all<SavedFilter>(
    "SELECT id, name, query FROM saved_filters WHERE organization_id = ? AND user_id = ? ORDER BY name",
    [org.id, user.id],
  );

  const activeFilterCount = countActiveFilters({ ...filters, group: undefined });
  const empty = total === 0;

  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          <Link
            href="/carriers/new"
            className="rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700"
          >
            Add Carrier
          </Link>
        }
      />

      <div className="space-y-4">
        <CarrierToolbar
          basePath={basePath}
          params={searchParams}
          options={options}
          quickFilters={quickFilters}
          columns={columns}
          savedFilters={savedFilters}
          activeFilterCount={activeFilterCount}
          total={total}
        />

        {empty ? (
          <EmptyState
            title={activeFilterCount > 0 ? "No carriers match these filters" : "No carriers yet"}
            description={
              activeFilterCount > 0
                ? "Try widening the date range or clearing a filter."
                : "Import your existing spreadsheet, or add the first carrier manually."
            }
            action={
              activeFilterCount > 0 ? (
                <Link
                  href={basePath}
                  className="rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50"
                >
                  Clear filters
                </Link>
              ) : (
                <Link
                  href="/import"
                  className="rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700"
                >
                  Import spreadsheet
                </Link>
              )
            }
          />
        ) : (
          <Card padded={false} className="overflow-hidden">
            <CarrierTable
              rows={withLookups(org, rows)}
              columns={columns}
              params={searchParams}
              basePath={basePath}
            />
            <Pagination
              basePath={basePath}
              params={searchParams}
              page={page}
              pages={pages}
              total={total}
              pageSize={pageSize}
            />
          </Card>
        )}
      </div>
    </>
  );
}
