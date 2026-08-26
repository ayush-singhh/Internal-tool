import { PageHeader, Card, EmptyState } from "@/components/ui";
import { requireUser } from "@/lib/auth";
import Link from "next/link";

// Phase 7 replaces this with the metric tiles, charts, activity feed and attention queue.
export default async function DashboardPage() {
  const user = await requireUser();
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";

  return (
    <>
      <PageHeader
        title={`${greeting}, ${user.name.split(" ")[0]}`}
        subtitle="Carrier operations overview"
      />
      <Card padded={false}>
        <EmptyState
          title="No carriers yet"
          description="Import your existing carrier spreadsheet to get started, or add the first carrier manually."
          action={
            <div className="flex gap-2">
              <Link
                href="/import"
                className="rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700"
              >
                Import spreadsheet
              </Link>
              <Link
                href="/carriers/new"
                className="rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50"
              >
                Add carrier
              </Link>
            </div>
          }
        />
      </Card>
    </>
  );
}
