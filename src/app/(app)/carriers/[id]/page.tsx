import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getCarrier, decorate, reviewFlags } from "@/lib/carriers";
import { carrierActivity, carrierNotes } from "@/lib/activity";
import { getOffboarding } from "@/lib/offboarding";
import { requireUser } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { OFFBOARDING_STATUSES } from "@/lib/constants";
import { lookup, options as lookupOptions, idsOf } from "@/lib/lookups";
import { all } from "@/lib/db";
import {
  formatDate, formatDateTime, formatMoney, formatPhone, formatPricing, pluralize,
} from "@/lib/format";
import { Badge, Card, CardHeader, Field } from "@/components/ui";
import { Icon } from "@/components/icons";
import { CarrierNotes } from "@/components/carrier-notes";
import { ActivityTimeline } from "@/components/activity-timeline";
import { StatusDialog } from "@/components/status-dialog";

export async function generateMetadata(
  props: PageProps<"/carriers/[id]">,
): Promise<Metadata> {
  const { id } = await props.params;
  const carrier = getCarrier(Number(id));
  return { title: carrier?.legal_name ?? "Carrier" };
}

function Section({
  title,
  subtitle,
  children,
  action,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} action={action} />
      <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">{children}</dl>
    </Card>
  );
}

export default async function CarrierProfilePage(props: PageProps<"/carriers/[id]">) {
  const user = await requireUser();
  const { id } = await props.params;
  const carrierId = Number(id);
  if (!Number.isInteger(carrierId)) notFound();

  const carrier = getCarrier(carrierId);
  if (!carrier) notFound();

  const d = decorate(carrier);
  const flags = reviewFlags(carrier);
  const notes = carrierNotes(carrierId);
  const activity = carrierActivity(carrierId);
  const offboarding = getOffboarding(carrierId);
  const isExited = OFFBOARDING_STATUSES.includes(d.status?.value ?? "");

  const editable = can(user, "carrier:edit", carrier);
  const canOffboard = can(user, "carrier:offboard", carrier);

  const toOptions = (kind: Parameters<typeof lookupOptions>[0]) =>
    lookupOptions(kind).map((l) => ({ id: l.id, label: l.label, value: l.value }));
  const statusOptions = {
    status: toOptions("status"),
    users: all<{ id: number; name: string }>(
      "SELECT id, name FROM users WHERE active = 1 ORDER BY name",
    ).map((u) => ({ id: u.id, label: u.name })),
    offboard_reason: toOptions("offboard_reason"),
    offboard_category: toOptions("offboard_category"),
    final_status: toOptions("final_status"),
  };
  const pricing = formatPricing({
    pricingType: d.pricingType?.label ?? null,
    planName: null,
    rate: carrier.rate,
    percentage: carrier.percentage,
    billingFrequency: d.billingFrequency?.label ?? null,
  });

  return (
    <div className="space-y-5">
      <Link
        href="/carriers"
        className="inline-flex items-center gap-1 text-[0.8rem] font-medium text-ink-500 transition hover:text-ink-900"
      >
        <Icon name="back" className="h-4 w-4" />
        All carriers
      </Link>

      <header className="flex flex-col gap-4 border-b border-line pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[1.5rem] font-semibold tracking-tight text-ink-900">
              {carrier.legal_name}
            </h1>
            {d.status && <Badge tone={d.statusTone} dot>{d.status.label}</Badge>}
          </div>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.82rem] text-ink-500">
            {carrier.serial && <span className="tnum">{carrier.serial}</span>}
            {carrier.owner_name && <span>Owner · {carrier.owner_name}</span>}
            {carrier.mc_number && <span className="tnum">MC {carrier.mc_number}</span>}
            {carrier.usdot && <span className="tnum">USDOT {carrier.usdot}</span>}
            {carrier.truck_count != null && (
              <span className="tnum">{pluralize(carrier.truck_count, "truck")}</span>
            )}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canOffboard && (
            <StatusDialog
              carrierId={carrier.id}
              currentStatusId={carrier.status_id}
              currentStatusLabel={d.status?.label ?? "No status"}
              exitStatusIds={idsOf("status", OFFBOARDING_STATUSES)}
              options={statusOptions}
              currentUserId={user.id}
              existing={offboarding ?? null}
            />
          )}
          {editable && (
            <Link
              href={`/carriers/${carrier.id}/edit`}
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-700"
            >
              <Icon name="edit" className="h-4 w-4" />
              Edit carrier
            </Link>
          )}
        </div>
      </header>

      {flags.length > 0 && (
        <div className="flex gap-2.5 rounded-card border border-amber-200 bg-amber-50 p-3.5">
          <span className="mt-px shrink-0 text-amber-600">
            <Icon name="warning" className="h-4 w-4" />
          </span>
          <div className="text-[0.83rem] text-amber-900">
            <p className="font-semibold">Flagged for review during import</p>
            <ul className="mt-1 list-inside list-disc space-y-0.5 text-amber-800">
              {flags.map((f, i) => <li key={i}>{f}</li>)}
            </ul>
            <p className="mt-1.5 text-xs text-amber-700">
              The original spreadsheet values were preserved exactly. Edit the carrier to
              resolve them.
            </p>
          </div>
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Section title="Overview">
            <Field label="Legal Name">{carrier.legal_name}</Field>
            <Field label="Owner">{carrier.owner_name}</Field>
            <Field label="Status">
              {d.status && <Badge tone={d.statusTone} dot>{d.status.label}</Badge>}
            </Field>
            <Field label="Dispatcher">{carrier.dispatcher_name}</Field>
            <Field label="Account Manager">{carrier.account_manager_name}</Field>
            <Field label="Status Changed">{formatDate(carrier.status_changed_at?.slice(0, 10))}</Field>
          </Section>

          <Section title="Contact">
            <Field label="Phone">
              {carrier.phone ? (
                <a href={`tel:${carrier.phone_digits ?? carrier.phone}`} className="tnum hover:text-brand-700">
                  {formatPhone(carrier.phone)}
                </a>
              ) : null}
            </Field>
            <Field label="Email">
              {carrier.email ? (
                <a href={`mailto:${carrier.email}`} className="hover:text-brand-700">
                  {carrier.email}
                </a>
              ) : null}
            </Field>
            <Field label="Address">{carrier.address}</Field>
          </Section>

          <Section title="Regulatory & Equipment">
            <Field label="MC Number" mono>{carrier.mc_number}</Field>
            <Field label="USDOT" mono>{carrier.usdot}</Field>
            <Field label="Trailer Type">{d.trailerType?.label}</Field>
            <Field label="Trailer Size">{carrier.trailer_size}</Field>
            <Field label="Trucks / Trailers" mono>{carrier.truck_count}</Field>
          </Section>

          <Section title="Onboarding">
            <Field label="Carrier Born Date">{formatDate(carrier.born_date)}</Field>
            <Field label="Onboarding Date">{formatDate(carrier.onboarding_date)}</Field>
            <Field label="Onboarding Type">{d.onboardingType?.label}</Field>
            <Field label="Lead Source">{d.leadSource?.label}</Field>
            <Field label="First Load Date">{formatDate(carrier.first_load_date)}</Field>
          </Section>

          <Section title="Commercial">
            <Field label="Plan">{d.plan?.label}</Field>
            <Field label="Pricing Type">{d.pricingType?.label}</Field>
            <Field label="Pricing">{pricing}</Field>
            <Field label="Rate" mono>{carrier.rate == null ? null : formatMoney(carrier.rate)}</Field>
            <Field label="Percentage" mono>
              {carrier.percentage == null ? null : `${carrier.percentage}%`}
            </Field>
            <Field label="Billing Frequency">{d.billingFrequency?.label}</Field>
            <Field label="Subscription">
              {d.subscription && <Badge tone={d.subscription.tone}>{d.subscription.label}</Badge>}
            </Field>
            <Field label="Agreement Status">
              {d.agreementStatus && (
                <Badge tone={d.agreementStatus.tone}>{d.agreementStatus.label}</Badge>
              )}
            </Field>
            <Field label="Invoice Collection Mode">{d.invoiceMode?.label}</Field>
          </Section>

          {(offboarding || isExited) && (
            <Card className="border-red-200 bg-red-50/30">
              <CardHeader
                title="Offboarding"
                subtitle="This record is retained in full — offboarded carriers are never deleted."
              />
              {offboarding ? (
                <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                  <Field label="Offboarding Date">{formatDate(offboarding.offboarded_on)}</Field>
                  <Field label="Reason">{lookup(offboarding.reason_id)?.label}</Field>
                  <Field label="Category">{lookup(offboarding.category_id)?.label}</Field>
                  <Field label="Handled By">{offboarding.handler_name}</Field>
                  <Field label="Final Status">{lookup(offboarding.final_status_id)?.label}</Field>
                  <Field label="Last Load Date">{formatDate(offboarding.last_load_date)}</Field>
                  <Field label="Outstanding Balance" mono>
                    {offboarding.outstanding_balance == null
                      ? null
                      : formatMoney(offboarding.outstanding_balance)}
                  </Field>
                  <Field label="Subscription Cancelled">
                    {offboarding.subscription_cancelled ? "Yes" : "No"}
                  </Field>
                  <Field label="Agreement Closed">
                    {offboarding.agreement_closed ? "Yes" : "No"}
                  </Field>
                  <Field label="Can Return">
                    <Badge tone={offboarding.can_return ? "green" : "red"}>
                      {offboarding.can_return ? "Yes" : "No"}
                    </Badge>
                  </Field>
                  <div className="sm:col-span-2 lg:col-span-3">
                    <Field label="Offboarding Notes">{offboarding.notes}</Field>
                  </div>
                </dl>
              ) : (
                <p className="text-sm text-ink-600">
                  This carrier has an exit status but no offboarding record yet.
                </p>
              )}
            </Card>
          )}
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader
              title="Internal Notes"
              subtitle={notes.length ? `${notes.length} recorded` : undefined}
            />
            <CarrierNotes
              carrierId={carrier.id}
              notes={notes}
              canWrite={can(user, "note:create")}
            />
          </Card>

          <Card>
            <CardHeader
              title="Activity History"
              subtitle="Automatically recorded — append-only"
            />
            <ActivityTimeline entries={activity} />
          </Card>

          <Card>
            <CardHeader title="Record" />
            <dl className="space-y-3">
              <Field label="Created">{formatDateTime(carrier.created_at)}</Field>
              <Field label="Last Updated">{formatDateTime(carrier.updated_at)}</Field>
            </dl>
          </Card>
        </div>
      </div>
    </div>
  );
}
