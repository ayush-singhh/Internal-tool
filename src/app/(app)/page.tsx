import Link from "next/link";
import { requireOrg } from "@/lib/auth";
import {
  dashboardMetrics, carriersByStatus, carriersByDispatcher, carriersByAccountManager,
  carriersByLeadSource, carriersByPlan, carriersByPricingType,
  onboardingTrend, offboardingTrend,
} from "@/lib/stats";
import { needsAttention, attentionTotal } from "@/lib/attention";
import { recentActivity } from "@/lib/activity";
import { leadMetrics, type LeadMetrics } from "@/lib/leads";
import { taskCounts, type TaskCounts } from "@/lib/tasks";
import { can, taskScope } from "@/lib/permissions";
import { idOf } from "@/lib/lookups";
import { STATUS } from "@/lib/constants";
import { relativeTime } from "@/lib/format";
import { Card, CardHeader, PageHeader, Badge, EmptyState } from "@/components/ui";
import { ActivityTimeline } from "@/components/activity-timeline";
import { BarList, TrendChart, StatTile } from "@/components/charts";
import { Icon } from "@/components/icons";

/** The pipeline strip. `scope` only changes the labels — the figures were already
 *  narrowed by the caller, because narrowing them here would be a second rule to keep
 *  in step with the one on /leads. */
function LeadTiles({ leads, scope }: { leads: LeadMetrics; scope: "all" | "mine" }) {
  return (
    <section aria-label="Lead pipeline" className="grid gap-3 grid-cols-2 lg:grid-cols-4">
      <StatTile
        label={scope === "all" ? "Total leads" : "My leads"}
        value={leads.total}
        emphasis
        href="/leads"
        hint="Every prospect, converted and lost included"
      />
      <StatTile label="New" value={leads.new} tone="blue" href="/leads" />
      <StatTile label="Qualified" value={leads.qualified} tone="purple" href="/leads" />
      <StatTile label="Converted" value={leads.won} tone="green" href="/leads" hint="Became carrier records" />
    </section>
  );
}

/** One line, not four tiles. A to-do count is only interesting when something is late. */
function TaskStrip({ counts }: { counts: TaskCounts }) {
  if (counts.open === 0) return null;
  const pressing = counts.overdue + counts.dueToday;
  return (
    <Link
      href="/tasks"
      className={`flex items-center gap-2 rounded-lg border px-3.5 py-3 text-sm font-medium transition ${
        counts.overdue > 0
          ? "border-red-200 bg-red-50 text-red-800 hover:bg-red-100"
          : pressing > 0
            ? "border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100"
            : "border-line bg-surface text-ink-700 hover:bg-ink-50"
      }`}
    >
      <Icon name="check" className="h-4 w-4" />
      {counts.open} open task{counts.open === 1 ? "" : "s"}
      {counts.overdue > 0 && ` · ${counts.overdue} overdue`}
      {counts.dueToday > 0 && ` · ${counts.dueToday} due today`}
    </Link>
  );
}

export default async function DashboardPage() {
  const { user, org } = await requireOrg();

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  // Whoever manages the whole pipeline sees all of it; a rep sees their own. Same rule
  // as /leads, and it has to be the same rule, or the tiles and the list disagree.
  const leads = can(user, "lead:view")
    ? leadMetrics(org, can(user, "lead:convert") ? undefined : user.id)
    : null;
  const tasks = taskCounts(org, taskScope(user));

  // Every figure below this line counts carriers, so a role without `carrier:view` —
  // sales today — must not reach it. Branching on the permission rather than on the
  // role name means a later role that cannot see carriers is safe here for free.
  if (!can(user, "carrier:view")) {
    return (
      <>
        <PageHeader
          title={`${greeting}, ${user.name.split(" ")[0]}`}
          subtitle={leads ? "Your pipeline and your recent work." : "Your recent work."}
        />
        <div className="space-y-5">
          {leads && <LeadTiles leads={leads} scope="mine" />}
          <TaskStrip counts={tasks} />
          <Card>
            <CardHeader title="Your activity" subtitle="Everything you have recorded, newest first." />
            <ActivityTimeline entries={recentActivity(org, 20, user.id)} />
          </Card>
        </div>
      </>
    );
  }

  const m = dashboardMetrics(org);
  const statusHref = (value: string) => {
    const id = idOf(org, "status", value);
    return id ? `/carriers?status=${id}` : "/carriers";
  };

  if (m.total === 0) {
    // Same rule as the sidebar: an affordance asks `can()` before it offers itself.
    // These two were shown to every role, so a dispatcher's empty dashboard led with
    // "Import spreadsheet" — a page `import:run` refuses them.
    const mayImport = can(user, "import:run");
    const mayAdd = can(user, "carrier:create");
    return (
      <>
        <PageHeader
          title={`${greeting}, ${user.name.split(" ")[0]}`}
          subtitle="Carrier operations overview"
        />
        <EmptyState
          title="No carriers yet"
          description={
            mayImport
              ? "Import your existing carrier spreadsheet to get started, or add the first carrier manually. Every number on this dashboard is read live from the database."
              : mayAdd
                ? "Add the first carrier to get started. Every number on this dashboard is read live from the database."
                : "No carriers have been added yet. Every number on this dashboard is read live from the database."
          }
          action={
            mayImport || mayAdd ? (
              <div className="flex flex-wrap justify-center gap-2">
                {mayImport && (
                  <Link href="/import" className="rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700">
                    Import spreadsheet
                  </Link>
                )}
                {mayAdd && (
                  <Link href="/carriers/new" className="rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50">
                    Add carrier
                  </Link>
                )}
              </div>
            ) : undefined
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
        <TaskStrip counts={tasks} />
        {leads && <LeadTiles leads={leads} scope="all" />}

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
