import type { Metadata } from "next";
import Link from "next/link";
import { requireSupport } from "@/lib/auth";
import { listTenants, recentAccess } from "@/lib/support";
import { recentErrors } from "@/lib/errors";
import { lastGoodBackup, recentBackups, type BackupStatus } from "@/lib/backup-log";
import { relativeTime } from "@/lib/format";
import { ORG_STATUS, type OrgStatus, type Tone } from "@/lib/constants";
import { Badge, Card, CardHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Organisations", robots: { index: false } };

/** Only "offsite" is actually safe; the other three are degrees of exposure. */
const BACKUP_TONE: Record<BackupStatus, Tone> = {
  offsite: "green",
  local: "amber",
  degraded: "red",
  failed: "red",
};

const BACKUP_LABEL: Record<BackupStatus, string> = {
  offsite: "Copied off the machine",
  local: "This disk only — BACKUP_S3_URL is not set",
  degraded: "Upload refused — this copy is only on this disk",
  failed: "No backup was produced",
};

const STATUS_TONE: Record<OrgStatus, Tone> = {
  [ORG_STATUS.TRIAL]: "blue",
  [ORG_STATUS.ACTIVE]: "green",
  [ORG_STATUS.PAST_DUE]: "amber",
  [ORG_STATUS.SUSPENDED]: "red",
};

export default async function SupportIndexPage() {
  await requireSupport();
  const tenants = listTenants();
  const log = recentAccess(25);
  const errors = recentErrors(25);
  const backups = recentBackups(10);
  const lastGood = lastGoodBackup();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink-900">Organisations</h1>
        <p className="mt-1 text-sm text-ink-500">
          {tenants.length} on this deployment. Opening one records who looked, at what, and
          when — including this list.
        </p>
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-500">
              <tr>
                <th className="px-4 py-2.5 font-semibold">Organisation</th>
                <th className="px-4 py-2.5 font-semibold">Status</th>
                <th className="px-4 py-2.5 text-right font-semibold">People</th>
                <th className="px-4 py-2.5 text-right font-semibold">Carriers</th>
                <th className="px-4 py-2.5 font-semibold">Last activity</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {tenants.map((t) => (
                <tr key={t.id} className="hover:bg-paper-50">
                  <td className="px-4 py-2.5">
                    <Link href={`/support/${t.id}`} className="font-medium text-brand-700 hover:underline">
                      {t.name}
                    </Link>
                    <span className="ml-2 font-mono text-xs text-ink-400">{t.slug}</span>
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge tone={STATUS_TONE[t.status as OrgStatus] ?? "slate"}>
                      {t.status.replace("_", " ")}
                    </Badge>
                  </td>
                  <td className="tnum px-4 py-2.5 text-right text-ink-700">{t.users}</td>
                  <td className="tnum px-4 py-2.5 text-right text-ink-700">{t.carriers}</td>
                  <td className="px-4 py-2.5 text-ink-500">
                    {t.last_activity ? relativeTime(t.last_activity) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Access record"
          subtitle="Every support view of a customer's data, newest first. Internal — never shown to customers, and nothing in this application deletes from it."
        />
        {log.length === 0 ? (
          <p className="text-sm text-ink-500">Nothing yet.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {log.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-baseline gap-x-2 py-2">
                <span className="font-medium text-ink-800">{entry.user_name}</span>
                <span className="text-ink-500">viewed</span>
                <span className="font-medium text-ink-800">{entry.organization_name}</span>
                <code className="font-mono text-xs text-ink-400">{entry.path}</code>
                <span className="ml-auto text-xs text-ink-400">{relativeTime(entry.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Backups"
          subtitle="One machine, one volume — so this is the whole disaster plan. The date that matters is the last copy that reached off-machine storage, not the last attempt."
        />
        {backups.length === 0 ? (
          <p className="text-sm text-ink-500">
            No backup has run yet. The schedule&rsquo;s first run is a full interval after
            boot, so this is expected on a server started less than {process.env.BACKUP_EVERY_HOURS ?? 24}h ago.
          </p>
        ) : (
          <>
            <p className="mb-3 text-sm">
              {lastGood ? (
                <>
                  Last copy off the machine:{" "}
                  <span className="font-medium text-ink-800">{relativeTime(lastGood.created_at)}</span>
                </>
              ) : (
                <span className="font-medium text-red-700">
                  No backup has ever reached off-machine storage. Losing this volume would
                  lose everything.
                </span>
              )}
            </p>
            <ul className="divide-y divide-line text-sm">
              {backups.map((entry) => (
                <li key={entry.id} className="flex flex-wrap items-baseline gap-2 py-2">
                  <Badge tone={BACKUP_TONE[entry.status]}>{entry.status}</Badge>
                  <span className="text-ink-700">{BACKUP_LABEL[entry.status]}</span>
                  {entry.bytes !== null && (
                    <span className="text-xs text-ink-400">{(entry.bytes / 1024).toFixed(0)} KB</span>
                  )}
                  <span className="ml-auto text-xs text-ink-400">{relativeTime(entry.created_at)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Server errors"
          subtitle="Caught by the server, newest first. A path or organisation is missing when the request failed before either was resolved."
        />
        {errors.length === 0 ? (
          <p className="text-sm text-ink-500">None recorded.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {errors.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-baseline gap-x-2 py-2">
                <span className="font-medium text-ink-800">{entry.message}</span>
                {entry.path && <code className="font-mono text-xs text-ink-400">{entry.path}</code>}
                {entry.digest && <span className="font-mono text-xs text-ink-400">#{entry.digest}</span>}
                <span className="ml-auto text-xs text-ink-400">{relativeTime(entry.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
