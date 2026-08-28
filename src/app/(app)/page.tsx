import Link from "next/link";
import { requireOrg } from "@/lib/auth";
import {
  dashboardMetrics, carriersByStatus, carriersByDispatcher, carriersByAccountManager,
  carriersByLeadSource, carriersByPlan, carriersByPricingType,
  onboardingTrend, offboardingTrend,
} from "@/lib/stats";
import { needsAttention, attentionTotal } from "@/lib/attention";
import { recentActivity } from "@/lib/activity";
import { idOf } from "@/lib/lookups";
import { STATUS } from "@/lib/constants";
import { relativeTime } from "@/lib/format";
import { Card, CardHeader, PageHeader, Badge, EmptyState } from "@/components/ui";
import { BarList, TrendChart, StatTile } from "@/components/charts";
import { Icon } from "@/components/icons";

export default async function DashboardPage() {
  const { user, org } = await requireOrg();
  const m = dashboardMetrics(org);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const statusHref = (value: string) => {
    const id = idOf(org, "status", value);
    return id ? `/carriers?status=${id}` : "/carriers";
  };

  if (m.total === 0) {
    return (
      <>
        <PageHeader
          title={`${greeting}, ${user.name.split(" ")[0]}`}
          subtitle="Carrier operations overview"
        />
        <EmptyState
          title="No carriers yet"
          description="Import your existing carrier spreadsheet to get started, or add the first carrier manually. Every number on this dashboard is read live from the database."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Link href="/import" className="rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700">
                Import spreadsheet
              </Link>
              <Link href="/carriers/new" className="rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50">
                Add carrier
              </Link>
            </div>
          }
        />
      </>
    );
  }

  const attention = needsAttention(org);
  const attentionCount = attentionTotal(attention);
  const activity = recentActivity(org, 10);

  return (
    <>
      <PageHeader
        title={`${greeting}, ${user.name.split(" ")[0]}`}
        subtitle="Carrier operations overview — every figure reads live from the database."
      />

      <div className="space-y-5">
        <section aria-label="Headline metrics" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label="Total carriers" value={m.total} emphasis href="/carriers" hint="All records, including offboarded" />
          <StatTile label="Active" value={m.active} emphasis tone="green" href="/active" />
          <StatTile label="About to be active" value={m.aboutToBeActive} emphasis tone="blue" href="/onboarding" />
          <StatTile label="Pending investigation" value={m.pendingInvestigation} emphasis tone="amber" href="/investigations" />
        </section>

        <section aria-label="Exit statuses" className="grid gap-3 grid-cols-2 lg:grid-cols-4">
          <StatTile label="Inactive" value={m.inactive} tone="slate" href={statusHref(STATUS.INACTIVE)} />
          <StatTile label="Suspended" value={m.suspended} tone="orange" href={statusHref(STATUS.SUSPENDED)} />
          <StatTile label="Blacklisted" value={m.blacklisted} tone="red" href={statusHref(STATUS.BLACKLISTED)} />
          <StatTile label="Carrier back-off" value={m.backOff} tone="purple" href={statusHref(STATUS.BACK_OFF)} />
        </section>

        <section aria-label="Fleet and movement" className="grid gap-3 sm:grid-cols-3">
          <StatTile label="Total trucks / trailers" value={m.trucks} hint="Across every carrier on file" />
          <StatTile label="New carriers this month" value={m.newThisMonth} hint="By onboarding date" />
          <StatTile label="Offboarded this month" value={m.offboardedThisMonth} hint="By offboarding date" />
        </section>

        <Card>
          <CardHeader
            title="Needs attention"
            subtitle={
              attentionCount === 0
                ? "Nothing outstanding."
                : `${attentionCount} record${attentionCount === 1 ? "" : "s"} across ${attention.length} rule${attention.length === 1 ? "" : "s"} — thresholds are configurable in Settings.`
            }
            action={
              attentionCount > 0 ? (
                <Link href="/settings" className="text-xs font-medium text-brand-600 hover:underline">
                  Adjust thresholds
                </Link>
              ) : undefined
            }
          />
          {attention.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3.5 py-3 text-sm text-emerald-800">
              <Icon name="check" className="h-4 w-4" />
              Every carrier record is complete and up to date.
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {attention.map((rule) => (
                <div key={rule.key} className="rounded-lg border border-line bg-ink-50/40 p-3.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 text-[0.83rem] font-semibold text-ink-900">
                        <Badge tone={rule.tone}>{rule.count}</Badge>
                        {rule.label}
                      </p>
                      <p className="mt-1 text-xs text-ink-500">{rule.description}</p>
                    </div>
                    {rule.href && (
                      <Link href={rule.href} className="shrink-0 text-xs font-medium text-brand-600 hover:underline">
                        View
                      </Link>
                    )}
                  </div>
                  <ul className="mt-2.5 space-y-1">
                    {rule.items.map((item) => (
                      <li key={item.id} className="flex items-baseline justify-between gap-2 text-xs">
                        <Link href={`/carriers/${item.id}`} className="truncate text-ink-700 underline-offset-2 hover:text-brand-700 hover:underline">
                          {item.legal_name}
                        </Link>
                        {item.detail && <span className="shrink-0 text-ink-400">{item.detail}</span>}
                      </li>
                    ))}
                    {rule.count > rule.items.length && (
                      <li className="text-xs text-ink-400">+ {rule.count - rule.items.length} more</li>
                    )}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Card>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader title="Carriers by status" subtitle="Every record, by current status" />
            <BarList data={carriersByStatus(org)} showDots />
          </Card>
          <Card>
            <CardHeader title="Carriers by dispatcher" subtitle="Workload across the dispatch team" />
            <BarList data={carriersByDispatcher(org)} limit={8} />
          </Card>
          <Card>
            <CardHeader title="Carriers by account manager" subtitle="Commercial ownership" />
            <BarList data={carriersByAccountManager(org)} limit={8} />
          </Card>
          <Card>
            <CardHeader title="Carriers by lead source" subtitle="Where carriers come from" />
            <BarList data={carriersByLeadSource(org)} limit={8} />
          </Card>
          <Card>
            <CardHeader title="Plan distribution" subtitle="Plans offered across the book" />
            <BarList data={carriersByPlan(org)} />
          </Card>
          <Card>
            <CardHeader title="Pricing distribution" subtitle="How carriers are charged" />
            <BarList data={carriersByPricingType(org)} />
          </Card>
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader title="Monthly onboarding" subtitle="Carriers onboarded, last 12 months" />
            <TrendChart data={onboardingTrend(org)} label="Carriers onboarded per month" />
          </Card>
          <Card>
            <CardHeader title="Monthly offboarding" subtitle="Carriers offboarded, last 12 months" />
            <TrendChart data={offboardingTrend(org)} label="Carriers offboarded per month" />
          </Card>
        </div>

        <Card>
          <CardHeader title="Recent activity" subtitle="Latest recorded changes across all carriers" />
          {activity.length === 0 ? (
            <p className="py-4 text-center text-sm text-ink-400">No activity recorded yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {activity.map((e) => (
                <li key={e.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2.5 first:pt-0 last:pb-0">
                  <Link href={`/carriers/${e.carrier_id}`} className="text-[0.83rem] font-medium text-ink-900 underline-offset-2 hover:text-brand-700 hover:underline">
                    {e.legal_name}
                  </Link>
                  <span className="text-[0.83rem] text-ink-600">{e.summary}</span>
                  <span className="ml-auto shrink-0 text-xs text-ink-400">
                    {e.user_name ?? "System"} · {relativeTime(e.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
