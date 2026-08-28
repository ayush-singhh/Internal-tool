import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { getSettings } from "@/lib/db";
import { SETTING_DEFS, lookupUsage } from "@/lib/settings";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import { SettingsForm, PasswordSelfForm, LookupManager, type LookupRow } from "@/components/settings-form";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const { user, org } = await requireOrg();
  if (!can(user, "settings:manage")) redirect("/");

  const rows = lookupUsage(org);
  const grouped = new Map<string, LookupRow[]>();
  for (const row of rows) {
    const list = grouped.get(row.kind) ?? [];
    list.push({ id: row.id, kind: row.kind, label: row.label, active: row.active, usage: row.usage });
    grouped.set(row.kind, list);
  }

  return (
    <>
      <PageHeader
        title="Settings"
        subtitle="Attention thresholds, dropdown vocabularies, and your own password."
      />

      <div className="space-y-5">
        <Card>
          <CardHeader
            title="Needs Attention thresholds"
            subtitle="These drive the work queue on the dashboard. Changes take effect immediately."
          />
          <SettingsForm defs={SETTING_DEFS} values={getSettings(org.id)} />
        </Card>

        <Card>
          <CardHeader
            title="Your password"
            subtitle="Changing it signs out every other session for your account."
          />
          <PasswordSelfForm userId={user.id} />
        </Card>

        <Card>
          <CardHeader
            title="Dropdown vocabularies"
            subtitle="Retiring a value hides it from new records without touching carriers already using it — history is never rewritten."
          />
          <LookupManager groups={[...grouped.entries()]} />
        </Card>
      </div>
    </>
  );
}
