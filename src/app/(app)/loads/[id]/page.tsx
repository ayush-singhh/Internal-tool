import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { getLoad, loadStops, nextStatuses, rpm } from "@/lib/loads";
import { assignDriverAction, setExceptionAction, setStatusAction } from "@/lib/load-actions";
import { loadFormOptions } from "@/lib/form-options";
import { formatDate } from "@/lib/format";
import {
  LOAD_EXCEPTION_LABELS, LOAD_STATUS, LOAD_STATUS_LABELS, LOAD_STATUS_TONE,
  type LoadException,
} from "@/lib/constants";
import { Badge, Card, CardHeader, Field, PageHeader } from "@/components/ui";
import { documentsConfigured, listLoadDocuments } from "@/lib/documents";
import { DocumentManager } from "@/components/document-manager";

export const metadata: Metadata = { title: "Load" };

const money = (n: number | null) =>
  n === null ? null : n.toLocaleString("en-US", { style: "currency", currency: "USD" });

export default async function LoadPage(props: PageProps<"/loads/[id]">) {
  const { user, org } = await requireOrg();
  if (!can(user, "load:view")) redirect("/");

  const id = Number((await props.params).id);
  if (!Number.isInteger(id)) notFound();
  const load = getLoad(org, id);
  if (!load) notFound();

  const showRates = can(user, "load:rate");
  const mayManage = can(user, "load:manage");
  const mayClose = can(user, "load:close");
  const stops = loadStops(org, id);
  const r = rpm(load);
  const options = loadFormOptions(org);
  const documents = listLoadDocuments(org, id);
  // Global Constraint: no upload UI at all when DOCUMENTS_S3_URL is unset — not a
  // disabled/dead button, the form simply isn't in the tree.
  const canUploadDocuments = mayManage && documentsConfigured();

  // Invoiced and Closed are the invoicing end of the flow, so a dispatcher is offered
  // nothing past Delivered. The action re-checks this; hiding the button is only manners.
  const offered = nextStatuses(load.status).filter((s) =>
    s === LOAD_STATUS.INVOICED || s === LOAD_STATUS.CLOSED ? mayClose : mayManage,
  );

  return (
    <>
      <PageHeader
        title={load.load_number || `Load #${load.id}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={LOAD_STATUS_TONE[load.status]}>{LOAD_STATUS_LABELS[load.status]}</Badge>
            {load.exception && (
              <Badge tone="red">{LOAD_EXCEPTION_LABELS[load.exception as LoadException]}</Badge>
            )}
            <span className="text-ink-500">{load.carrier_name}</span>
          </span>
        }
        actions={
          <Link href="/loads" className="rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50">
            All loads
          </Link>
        }
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader title="Route" subtitle={`${load.pickup_count} pickup${load.pickup_count === 1 ? "" : "s"} · ${load.delivery_count} deliver${load.delivery_count === 1 ? "y" : "ies"}`} />
            <ol className="space-y-3">
              {stops.map((s) => (
                <li key={s.id} className="flex gap-3">
                  <span
                    className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                      s.kind === "pickup" ? "bg-brand-500" : "bg-green-500"
                    }`}
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink-900">
                      {s.city}
                      {s.state ? `, ${s.state}` : ""}
                      <span className="ml-2 text-xs font-normal uppercase tracking-wide text-ink-400">
                        {s.kind} {s.sequence}
                      </span>
                    </p>
                    {s.address && <p className="text-xs text-ink-500">{s.address}</p>}
                    {s.scheduled_at && (
                      <p className="text-xs text-ink-400">Scheduled {formatDate(s.scheduled_at.slice(0, 10))}</p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </Card>

          <Card>
            <CardHeader title="Freight" />
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
              <Field label="Commodity">{load.commodity}</Field>
              <Field label="Weight" mono>{load.weight_lbs ? `${load.weight_lbs.toLocaleString()} lbs` : null}</Field>
              <Field label="Temperature" mono>{load.temperature_f === null ? null : `${load.temperature_f}°F`}</Field>
              <Field label="Deadhead" mono>{load.deadhead_miles === null ? null : `${load.deadhead_miles} mi`}</Field>
              <Field label="Loaded" mono>{load.loaded_miles === null ? null : `${load.loaded_miles} mi`}</Field>
              <Field label="Total Miles" mono>
                {load.loaded_miles === null && load.deadhead_miles === null
                  ? null
                  : `${(load.loaded_miles ?? 0) + (load.deadhead_miles ?? 0)} mi`}
              </Field>
            </dl>
            {load.special_instructions && (
              <p className="mt-4 rounded-lg bg-paper-50 px-3.5 py-3 text-sm text-ink-700">
                {load.special_instructions}
              </p>
            )}
          </Card>

          {showRates && (
            <Card>
              <CardHeader
                title="Rate"
                subtitle="Rate per mile is calculated, never typed. Loaded uses freight miles; total includes the empty run."
              />
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
                <Field label="Rate" mono>{money(load.rate)}</Field>
                <Field label="Loaded Miles RPM" mono>{r.loaded === null ? null : `$${r.loaded.toFixed(2)}`}</Field>
                <Field label="Total Miles RPM" mono>{r.total === null ? null : `$${r.total.toFixed(2)}`}</Field>
              </dl>
            </Card>
          )}
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Status" />
            <dl className="mb-4 grid gap-y-2">
              <Field label="Picked up">{formatDate(load.picked_up_at?.slice(0, 10) ?? null)}</Field>
              <Field label="Delivered">{formatDate(load.delivered_at?.slice(0, 10) ?? null)}</Field>
            </dl>
            {offered.length > 0 ? (
              <form action={setStatusAction} className="flex flex-wrap gap-2">
                <input type="hidden" name="id" value={load.id} />
                {offered.map((s) => (
                  <button
                    key={s}
                    name="to"
                    value={s}
                    className="rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-700"
                  >
                    Mark {LOAD_STATUS_LABELS[s]}
                  </button>
                ))}
              </form>
            ) : (
              <p className="text-sm text-ink-500">
                {load.status === LOAD_STATUS.DELIVERED && !mayClose
                  ? "Invoicing takes it from here."
                  : "Nothing further to do."}
              </p>
            )}
          </Card>

          <Card>
            <CardHeader title="Driver" />
            {mayManage ? (
              <form action={assignDriverAction} className="space-y-3">
                <input type="hidden" name="id" value={load.id} />
                <select name="driver_id" defaultValue={load.driver_id ?? ""} className="field w-full" aria-label="Assign driver">
                  <option value="">Unassigned</option>
                  {options.drivers.map((d) => (
                    <option key={d.id} value={d.id}>{d.label}</option>
                  ))}
                </select>
                <button className="w-full rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-sm font-semibold text-ink-700 hover:bg-ink-50">
                  Save driver
                </button>
              </form>
            ) : (
              <p className="text-sm text-ink-800">{load.driver_name ?? "Unassigned"}</p>
            )}
          </Card>

          {mayManage && (
            <Card>
              <CardHeader title="Exception" subtitle="Sits beside the status — it never replaces it." />
              <form action={setExceptionAction} className="space-y-3">
                <input type="hidden" name="id" value={load.id} />
                <select name="exception" defaultValue={load.exception ?? ""} className="field w-full" aria-label="Exception flag">
                  <option value="">None</option>
                  {Object.entries(LOAD_EXCEPTION_LABELS).map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
                <button className="w-full rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-sm font-semibold text-ink-700 hover:bg-ink-50">
                  Save flag
                </button>
              </form>
            </Card>
          )}

          <Card>
            <CardHeader title="Record" />
            <dl className="grid gap-y-2">
              <Field label="Brokerage">{load.broker_name}</Field>
              <Field label="Dispatcher">{load.dispatcher_name}</Field>
              <Field label="Created">{formatDate(load.created_at.slice(0, 10))}</Field>
            </dl>
          </Card>
        </div>
      </div>

      <Card className="mt-5">
        <CardHeader
          title="Documents"
          subtitle="Rate confirmations, bills of lading, proofs of delivery — attached here, never removed."
        />
        <DocumentManager loadId={load.id} documents={documents} canUpload={canUploadDocuments} />
      </Card>
    </>
  );
}
