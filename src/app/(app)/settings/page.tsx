import type { Metadata } from "next";
import { redirect } from "next/navigation";
import QRCode from "qrcode";
import { currentSessionId, requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { getSettings } from "@/lib/db";
import { mfaState } from "@/lib/mfa";
import { listSessions } from "@/lib/sessions";
import { SETTING_DEFS, lookupUsage } from "@/lib/settings";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import { SettingsForm, PasswordSelfForm, LookupManager, type LookupRow } from "@/components/settings-form";
import { MfaCard } from "@/components/mfa-card";
import { SessionsCard } from "@/components/sessions-card";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const { user, org } = await requireOrg();
  if (!can(user, "settings:manage")) redirect("/");

  // The QR is drawn on the server, so the secret reaches the browser only as an image
  // and the typed-entry string on the enrolment step.
  const mfa = mfaState(user.id);
  const qrUri = mfa.otpauth ? await QRCode.toDataURL(mfa.otpauth, { margin: 1, width: 336 }) : null;

  const sessions = listSessions(user.id, await currentSessionId());

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
        subtitle="Attention thresholds, vocabularies, two-factor authentication, your sessions, and your own password."
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
            title="Two-factor authentication"
            subtitle="A second factor from your phone, checked after your password at every sign-in."
          />
          <MfaCard state={mfa} qrUri={qrUri} />
        </Card>

        <Card>
          <CardHeader
            title="Where you are signed in"
            subtitle="Every browser holding a session for your account. Sign out anything you do not recognise."
          />
          <SessionsCard sessions={sessions} />
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
