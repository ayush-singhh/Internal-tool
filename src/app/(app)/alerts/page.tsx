import type { Metadata } from "next";
import Link from "next/link";
import { requireOrg } from "@/lib/auth";
import { alertsFor } from "@/lib/alerts";
import { Badge, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { Icon } from "@/components/icons";

export const metadata: Metadata = { title: "Alerts" };

/**
 * Notifications & Alerts Summary.
 *
 * No permission of its own: everything here is composed from things the reader may
 * already see, and a role that may see none of them gets an empty page rather than a
 * refusal. Nothing is stored — see `src/lib/alerts.ts` for why.
 */
export default async function AlertsPage() {
  const { user, org } = await requireOrg();
  const alerts = alertsFor(org, user);
  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <PageHeader
        title="Alerts"
        subtitle={
          alerts.total === 0
            ? "Nothing is asking for your attention."
            : `${alerts.total} thing${alerts.total === 1 ? "" : "s"} want your attention. Every figure is read live — an alert clears the moment the thing behind it is resolved.`
        }
      />

      {alerts.total === 0 ? (
        <EmptyState
          title="All clear"
          description="No overdue tasks, no unread announcements, and nothing in the carrier queue."
        />
      ) : (
        <div className="space-y-5">
          <section aria-label="Alert summary" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {alerts.groups.map((group) => (
              <Link
                key={group.key}
                href={group.href}
                className="rounded-card border border-line bg-surface p-4 shadow-card transition hover:border-brand-300 hover:shadow-pop"
              >
                <div className="flex items-start justify-between gap-3">
                  <p className="text-sm font-semibold text-ink-900">{group.label}</p>
                  <Badge tone={group.tone}>{group.count}</Badge>
                </div>
                <p className="mt-1 text-xs text-ink-500">{group.description}</p>
              </Link>
            ))}
          </section>

          {alerts.overdueTasks.length > 0 && (
            <Card>
              <CardHeader
                title="Tasks that have run out of road"
                subtitle="Due today or already past their date"
                action={
                  <Link href="/tasks" className="text-xs font-medium text-brand-600 hover:underline">
                    All tasks
                  </Link>
                }
              />
              <ul className="divide-y divide-line">
                {alerts.overdueTasks.map((task) => (
                  <li key={task.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-2.5 first:pt-0 last:pb-0">
                    <span className="text-[0.83rem] font-medium text-ink-900">{task.title}</span>
                    {task.carrier_id && task.carrier_name && (
                      <Link href={`/carriers/${task.carrier_id}`} className="text-xs text-brand-600 hover:underline">
                        {task.carrier_name}
                      </Link>
                    )}
                    <span className="ml-auto shrink-0 text-xs">
                      <span className={task.due_on !== null && task.due_on < today ? "font-semibold text-red-600" : "text-amber-600"}>
                        {task.due_on !== null && task.due_on < today ? `Overdue ${task.due_on}` : "Due today"}
                      </span>
                      <span className="text-ink-400"> · {task.assignee_name ?? "Unassigned"}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {alerts.attention.length > 0 && (
            <Card>
              <CardHeader
                title="Carrier queue"
                subtitle="The same rules the dashboard shows — thresholds are configurable in Settings."
              />
              <div className="grid gap-3 md:grid-cols-2">
                {alerts.attention.map((rule) => (
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
            </Card>
          )}

          {alerts.unreadAnnouncements > 0 && (
            <Link
              href="/announcements"
              className="flex items-center gap-2 rounded-lg border border-brand-200 bg-brand-50 px-3.5 py-3 text-sm font-medium text-brand-800 transition hover:bg-brand-100"
            >
              <Icon name="note" className="h-4 w-4" />
              {alerts.unreadAnnouncements} unread announcement
              {alerts.unreadAnnouncements === 1 ? "" : "s"} — open the noticeboard
            </Link>
          )}
        </div>
      )}
    </>
  );
}
