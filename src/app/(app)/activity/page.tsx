import { requireOrg } from "@/lib/auth";
import { recentActivity } from "@/lib/activity";
import { PageHeader, Card } from "@/components/ui";
import { ActivityTimeline } from "@/components/activity-timeline";

/**
 * Everything this user has changed, newest first. Self-scoped by construction —
 * the only id it will accept is the session's own — so it needs no permission of
 * its own and every role, including sales, gets a page on day one.
 */
export default async function MyActivityPage() {
  const { user, org } = await requireOrg();
  // ponytail: fixed 200-row window, no paging. Add a cursor when someone's own history
  // outgrows one screen-scroll and they ask to see further back.
  const entries = recentActivity(org, 200, user.id);

  return (
    <>
      <PageHeader
        title="My activity"
        subtitle="Every change you have recorded, newest first."
      />
      <Card>
        <ActivityTimeline entries={entries} />
      </Card>
    </>
  );
}
