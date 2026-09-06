import type { Metadata } from "next";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { entitlement } from "@/lib/entitlement";
import { orgBilling, planPrices, TRIAL_DAYS } from "@/lib/subscription";
import { openPortalAction, startCheckoutAction } from "@/lib/subscription-actions";
import { formatDate } from "@/lib/format";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import type { StripePrice } from "@/lib/stripe";

export const metadata: Metadata = { title: "Subscription" };

/** Stripe quotes in minor units. Whole amounts lose the ".00" — nobody writes $499.00. */
function money(price: StripePrice): string {
  if (price.unit_amount === null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: price.currency.toUpperCase(),
    minimumFractionDigits: price.unit_amount % 100 === 0 ? 0 : 2,
  }).format(price.unit_amount / 100);
}

function PlanCard({
  plan, price, label, hint, disabled,
}: {
  plan: "monthly" | "yearly";
  price: StripePrice | null;
  label: string;
  hint: string;
  disabled: boolean;
}) {
  if (!price) return null;
  return (
    <Card>
      <CardHeader title={label} subtitle={hint} />
      <p className="tnum text-2xl font-semibold text-ink-900">
        {money(price)}
        <span className="ml-1 text-sm font-normal text-ink-500">
          /{price.recurring?.interval ?? "period"}
        </span>
      </p>
      <form action={startCheckoutAction} className="mt-4">
        <input type="hidden" name="plan" value={plan} />
        <button
          type="submit"
          disabled={disabled}
          className="w-full rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Start {TRIAL_DAYS}-day free trial
        </button>
      </form>
    </Card>
  );
}

export default async function SubscriptionPage() {
  // Every page under (app) calls this itself. The layout's call is defence in depth,
  // never the boundary: Next renders a layout and its page concurrently, so a layout that
  // refuses does not stop the page running. See the comment on requireSupport in auth.ts.
  const { user, org } = await requireOrg();
  // Viewing is deliberately ungated, so that a dispatcher who finds the application
  // read-only can read what happened and who to ask, rather than meeting a blank 403.
  // Acting is not: both Server Actions re-check this for themselves.
  const mayManage = can(user, "settings:manage");

  const billing = orgBilling(org.id);
  const state = entitlement(billing);
  const prices = await planPrices();
  const subscribed = billing.stripe_subscription_id !== null;

  return (
    <>
      <PageHeader
        title="Subscription"
        subtitle="What this organisation pays for Carrier Hub."
      />

      <div className="space-y-5">
        {state.notice && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm font-medium text-amber-800">
            {state.notice}
            {state.until && ` (${formatDate(state.until)})`}
          </p>
        )}

        {billing.billing_mode === "comped" && (
          <Card className="border-dashed">
            <CardHeader
              title="Not billed"
              subtitle="This organisation is not charged for Carrier Hub, and no card is held for it."
            />
          </Card>
        )}

        {prices.error && (
          <p className="rounded-lg border border-line bg-ink-50 px-3.5 py-3 text-sm text-ink-600">
            Prices could not be loaded from Stripe just now. Existing subscriptions are
            unaffected.
          </p>
        )}

        {!subscribed && billing.billing_mode !== "comped" && (
          <section aria-label="Plans" className="grid gap-3 sm:grid-cols-2">
            <PlanCard
              plan="monthly" price={prices.monthly} label="Monthly"
              hint="One price for the whole company, billed every month."
              disabled={!mayManage}
            />
            <PlanCard
              plan="yearly" price={prices.yearly} label="Yearly"
              hint="One price for the whole company, billed once a year."
              disabled={!mayManage}
            />
          </section>
        )}

        {subscribed && (
          <Card>
            <CardHeader
              title={
                billing.plan
                  ? `${billing.plan[0]!.toUpperCase()}${billing.plan.slice(1)} plan`
                  : "Custom plan"
              }
              subtitle={
                billing.current_period_end
                  ? `Renews ${formatDate(billing.current_period_end)}.`
                  : "Managed in Stripe."
              }
            />
            <form action={openPortalAction}>
              <button
                type="submit"
                disabled={!mayManage}
                className="rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-sm font-medium text-ink-700 transition hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Manage billing
              </button>
            </form>
            <p className="mt-2 text-xs text-ink-500">
              Cards, plan changes, invoices and cancellation are all handled by Stripe.
            </p>
          </Card>
        )}

        {!mayManage && (
          <p className="text-sm text-ink-500">
            Only an owner or an administrator can change the subscription.
          </p>
        )}
      </div>
    </>
  );
}
