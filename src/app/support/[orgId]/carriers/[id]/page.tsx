import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSupport } from "@/lib/auth";
import { carrierActivity, carrierNotes } from "@/lib/activity";
import { decorate, getCarrier } from "@/lib/carriers";
import { formatDate, formatPhone, relativeTime } from "@/lib/format";
import { getOffboarding } from "@/lib/offboarding";
import { recordAccess, tenant, tenantHandle } from "@/lib/support";
import { Badge, Card, CardHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Carrier", robots: { index: false } };

function Row({ label, value }: { label: string; value: string | number | null | undefined }) {
  return (
    <div className="flex gap-3 py-1.5">
      <dt className="w-44 shrink-0 text-xs uppercase tracking-wide text-ink-500">{label}</dt>
      <dd className="text-sm text-ink-800">{value === null || value === undefined || value === "" ? "—" : value}</dd>
    </div>
  );
}

export default async function SupportCarrierPage(
  props: PageProps<"/support/[orgId]/carriers/[id]">,
) {
  const user = await requireSupport();
  const params = await props.params;
  const orgId = Number(params.orgId);
  const carrierId = Number(params.id);
  const summary = Number.isInteger(orgId) ? tenant(orgId) : undefined;
  if (!summary || !Number.isInteger(carrierId)) notFound();

  recordAccess(user.id, orgId, `/support/${orgId}/carriers/${carrierId}`);

  const org = tenantHandle(orgId);
  const carrier = getCarrier(org, carrierId);
  if (!carrier) notFound();

  const d = decorate(org, carrier);
  const notes = carrierNotes(org, carrierId);
  const activity = carrierActivity(org, carrierId, 30);
  const exit = getOffboarding(org, carrierId);

  return (
    <div className="space-y-5">
      <div>
        <Link href={`/support/${orgId}`} className="text-xs text-ink-500 underline hover:text-ink-800">
          ← {summary.name}
        </Link>
        <h1 className="mt-2 flex flex-wrap items-center gap-3 text-xl font-semibold tracking-tight text-ink-900">
          {carrier.legal_name}
          <Badge tone={d.statusTone}>{d.status?.label ?? "—"}</Badge>
        </h1>
      </div>

      <Card>
        <CardHeader title="Record" />
        <dl className="divide-y divide-line">
          <Row label="Serial" value={carrier.serial} />
          <Row label="Owner" value={carrier.owner_name} />
          <Row label="Phone" value={formatPhone(carrier.phone)} />
          <Row label="Email" value={carrier.email} />
          <Row label="Address" value={carrier.address} />
          <Row label="MC / USDOT" value={`${carrier.mc_number ?? "—"} / ${carrier.usdot ?? "—"}`} />
          <Row label="Trailer" value={`${d.trailerType?.label ?? "—"} ${carrier.trailer_size ?? ""}`} />
          <Row label="Trucks" value={carrier.truck_count} />
          <Row label="Onboarded" value={formatDate(carrier.onboarding_date)} />
          <Row label="First load" value={formatDate(carrier.first_load_date)} />
          <Row label="Plan" value={d.plan?.label} />
          <Row label="Pricing" value={d.pricingType?.label} />
          <Row label="Agreement" value={d.agreementStatus?.label} />
          <Row label="Subscription" value={d.subscription?.label} />
        </dl>
      </Card>

      {exit && (
        <Card>
          <CardHeader title="Offboarding" />
          <dl className="divide-y divide-line">
            <Row label="Offboarded" value={formatDate(exit.offboarded_on)} />
            <Row label="Last load" value={formatDate(exit.last_load_date)} />
            <Row label="Outstanding" value={exit.outstanding_balance} />
            <Row label="Notes" value={exit.notes} />
          </dl>
        </Card>
      )}

      <Card>
        <CardHeader title={`Notes (${notes.length})`} />
        {notes.length === 0 ? (
          <p className="text-sm text-ink-500">None.</p>
        ) : (
          <ul className="divide-y divide-line">
            {notes.map((n) => (
              <li key={n.id} className="py-2.5">
                <p className="text-sm text-ink-800">{n.body}</p>
                <p className="mt-1 text-xs text-ink-400">
                  {n.user_name ?? "Unknown"} · {relativeTime(n.created_at)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Recent activity" />
        <ul className="divide-y divide-line">
          {activity.map((a) => (
            <li key={a.id} className="flex flex-wrap items-baseline gap-2 py-2 text-sm">
              <span className="text-ink-800">{a.summary}</span>
              <span className="ml-auto text-xs text-ink-400">{relativeTime(a.created_at)}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
