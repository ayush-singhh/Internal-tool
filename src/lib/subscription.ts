import "server-only";
import { get, run, systemQuery } from "./db.ts";
import { ORG_STATUS, type OrgStatus } from "./constants.ts";
import type { OrgBilling } from "./entitlement.ts";
import {
  createCheckoutSession, createPortalSession, getPrice, getSubscription, verifySignature,
  type Fetcher, type StripePrice, type StripeSubscription,
} from "./stripe.ts";
import { appUrl } from "./mailer.ts";

/** The trial we sell. Stripe holds the card from day one and charges on day 15. */
export const TRIAL_DAYS = 14;

export type OrgBillingRow = OrgBilling & {
  id: number;
  name: string;
  stripe_customer_id: string | null;
};

/**
 * `organizations` is a global table, not a tenant one — it is not in TENANT_TABLES, so
 * the isolation guard does not fire on it. `systemQuery` here is documentation of that
 * fact, the same way scripts/set-billing-status.ts uses it.
 */
export function orgBilling(orgId: number): OrgBillingRow {
  return systemQuery(() =>
    get<OrgBillingRow>(
      `SELECT id, name, status, billing_mode, plan, stripe_customer_id,
              stripe_subscription_id, trial_ends_at, current_period_end
         FROM organizations WHERE id = ?`,
      [orgId],
    ),
  )!;
}

/** The only translation between Stripe's vocabulary and ours. */
const STATUS: Record<string, OrgStatus> = {
  trialing: ORG_STATUS.TRIAL,
  active: ORG_STATUS.ACTIVE,
  past_due: ORG_STATUS.PAST_DUE,
  incomplete: ORG_STATUS.PAST_DUE,
  canceled: ORG_STATUS.SUSPENDED,
  unpaid: ORG_STATUS.SUSPENDED,
  incomplete_expired: ORG_STATUS.SUSPENDED,
  paused: ORG_STATUS.SUSPENDED,
};

/** Anything Stripe adds that we have not mapped is treated as not-paying. Fail closed. */
export function statusFor(stripeStatus: string): OrgStatus {
  return STATUS[stripeStatus] ?? ORG_STATUS.SUSPENDED;
}

/** Null for a price that is neither of ours — an old price still attached to a
 *  long-standing customer. The page says "Custom plan" rather than guessing. */
export function planFor(priceId: string | null): string | null {
  if (!priceId) return null;
  if (priceId === process.env.STRIPE_PRICE_MONTHLY) return "monthly";
  if (priceId === process.env.STRIPE_PRICE_YEARLY) return "yearly";
  return null;
}

const iso = (seconds: number | null | undefined) =>
  typeof seconds === "number" ? new Date(seconds * 1000).toISOString() : null;

/**
 * Mirrors a Stripe subscription onto an organisation. Absolute values, never deltas, so
 * applying the same subscription twice is indistinguishable from applying it once.
 *
 * Deliberately does NOT write `billing_mode`. A comped organisation stays comped whatever
 * Stripe says, so no webhook can ever start paywalling a grandfathered tenant; moving one
 * onto billing is a person running scripts/set-billing-status.ts.
 */
export function applySubscription(orgId: number, sub: StripeSubscription): void {
  const item = sub.items?.data?.[0];
  systemQuery(() =>
    run(
      `UPDATE organizations
          SET status = ?, stripe_customer_id = ?, stripe_subscription_id = ?,
              plan = ?, trial_ends_at = ?, current_period_end = ?
        WHERE id = ?`,
      [
        statusFor(sub.status),
        typeof sub.customer === "string" ? sub.customer : null,
        sub.id,
        planFor(item?.price?.id ?? null),
        iso(sub.trial_end),
        // Newer Stripe API versions moved this onto the subscription item; older ones
        // keep it on the subscription. Read both so an upgrade does not silently null it.
        iso(item?.current_period_end ?? sub.current_period_end),
        orgId,
      ],
    ),
  );
}

export function orgIdForCustomer(customerId: string): number | null {
  return (
    systemQuery(() =>
      get<{ id: number }>("SELECT id FROM organizations WHERE stripe_customer_id = ?", [customerId]),
    )?.id ?? null
  );
}

export function alreadySeen(eventId: string): boolean {
  return systemQuery(() => !!get("SELECT 1 FROM stripe_events WHERE id = ?", [eventId]));
}

export function recordEvent(eventId: string, type: string): void {
  systemQuery(() =>
    run("INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)",
      [eventId, type, new Date().toISOString()]),
  );
}

export type StripeEvent = { id: string; type: string; data: { object: Record<string, unknown> } };

/**
 * Applies one verified event and says what happened, for the log.
 *
 * The event is recorded as handled only after the work succeeds. Recording first would
 * mean a handler that threw — a Stripe timeout, a locked database — swallowed Stripe's
 * retry of the very event it failed on. Applying twice is harmless because
 * `applySubscription` writes absolute values.
 */
export async function handleEvent(event: StripeEvent, fetcher?: Fetcher): Promise<string> {
  if (alreadySeen(event.id)) return `duplicate ${event.id} (${event.type})`;

  const object = event.data.object;
  let subscriptionId: string | null = null;
  let orgId: number | null = null;

  if (event.type === "checkout.session.completed") {
    subscriptionId = typeof object.subscription === "string" ? object.subscription : null;
    // Set when the session was created — the only way to find the organisation before any
    // customer id has been stored against it.
    const reference = object.client_reference_id;
    orgId = typeof reference === "string" && /^\d+$/.test(reference) ? Number(reference) : null;
  } else {
    subscriptionId = typeof object.id === "string" ? object.id : null;
  }
  if (orgId === null && typeof object.customer === "string") {
    orgId = orgIdForCustomer(object.customer);
  }
  if (!subscriptionId) {
    recordEvent(event.id, event.type);
    return `${event.type}: no subscription on the event`;
  }

  // Read the subscription back rather than trusting the event's copy of it. Stripe does
  // not guarantee delivery order, so the event that arrives last is not necessarily the
  // one that happened last; reading the current state makes ordering irrelevant.
  const subscription = await getSubscription(subscriptionId, fetcher);
  if (orgId === null && typeof subscription.customer === "string") {
    orgId = orgIdForCustomer(subscription.customer);
  }
  if (orgId === null) {
    // Recorded and accepted. Returning an error would make Stripe retry an event that can
    // never succeed, for days.
    recordEvent(event.id, event.type);
    return `${event.type}: no organisation for ${subscriptionId}`;
  }

  applySubscription(orgId, subscription);
  recordEvent(event.id, event.type);
  return `${event.type}: organisation ${orgId} -> ${statusFor(subscription.status)}`;
}

/**
 * One verified Stripe delivery, from raw request to response.
 *
 * Lives here rather than in the route file so it is a plain function a test can call with
 * a `Request`, no HTTP server and no build step.
 */
export async function handleWebhookRequest(
  request: Request,
  fetcher?: Fetcher,
): Promise<Response> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return new Response("Billing is not configured here.", { status: 503 });

  // Read the body as text before anything parses it: JSON that has been parsed and
  // re-serialised is different bytes, and therefore a different HMAC.
  const raw = await request.text();
  const verdict = verifySignature(raw, request.headers.get("stripe-signature"), secret);
  if (!verdict.ok) return new Response(verdict.reason, { status: 400 });

  let event: StripeEvent;
  try {
    event = JSON.parse(raw) as StripeEvent;
  } catch {
    return new Response("Body is not JSON.", { status: 400 });
  }
  if (!event?.id || !event?.type || !event?.data?.object) {
    return new Response("Not a Stripe event.", { status: 400 });
  }

  try {
    console.log(`[stripe] ${await handleEvent(event, fetcher)}`);
  } catch (error) {
    // A 500 is the request to deliver it again, which is right for a transient failure.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[stripe] ${event.id} (${event.type}) failed: ${message}`);
    return new Response("Handler failed.", { status: 500 });
  }
  return new Response("ok");
}

/**
 * The two prices, as Stripe currently states them.
 *
 * Fetched rather than configured, so the number on the button and the number on the card
 * statement cannot drift apart — no amount appears anywhere in this codebase. Memoised
 * for ten minutes because the page renders on every request and a price changes about
 * once a year.
 */
const priceCache = new Map<string, { at: number; price: StripePrice }>();
const PRICE_TTL_MS = 10 * 60_000;

async function cachedPrice(id: string | undefined, fetcher?: Fetcher): Promise<StripePrice | null> {
  if (!id) return null;
  const hit = priceCache.get(id);
  if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.price;
  const price = await getPrice(id, fetcher);
  priceCache.set(id, { at: Date.now(), price });
  return price;
}

export async function planPrices(fetcher?: Fetcher): Promise<{
  monthly: StripePrice | null;
  yearly: StripePrice | null;
  error: string | null;
}> {
  try {
    const [monthly, yearly] = await Promise.all([
      cachedPrice(process.env.STRIPE_PRICE_MONTHLY, fetcher),
      cachedPrice(process.env.STRIPE_PRICE_YEARLY, fetcher),
    ]);
    return { monthly, yearly, error: null };
  } catch (error) {
    // A Stripe outage must not take the page down with it — somebody arriving here to
    // fix their card still needs the "Manage billing" button to render.
    return {
      monthly: null, yearly: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Returns the Stripe-hosted URL to send the customer to. */
export async function startCheckout(
  orgId: number,
  plan: "monthly" | "yearly",
  email: string,
  fetcher?: Fetcher,
): Promise<string> {
  const variable = plan === "yearly" ? "STRIPE_PRICE_YEARLY" : "STRIPE_PRICE_MONTHLY";
  const priceId = process.env[variable];
  if (!priceId) throw new Error(`${variable} is not set — no price to subscribe to.`);

  const org = orgBilling(orgId);
  const session = await createCheckoutSession({
    priceId,
    orgId,
    customerId: org.stripe_customer_id,
    customerEmail: org.stripe_customer_id ? null : email,
    trialDays: TRIAL_DAYS,
    // A hint for the page's copy only. Payment is never believed from a query string —
    // only the webhook writes billing state.
    successUrl: `${appUrl()}/subscription?checkout=success`,
    cancelUrl: `${appUrl()}/subscription?checkout=cancelled`,
  }, fetcher);
  return session.url;
}

/** Card changes, plan changes, invoices and cancellation are all Stripe's screens. */
export async function openPortal(orgId: number, fetcher?: Fetcher): Promise<string> {
  const org = orgBilling(orgId);
  if (!org.stripe_customer_id) {
    throw new Error("This organisation has no Stripe customer yet — start a subscription first.");
  }
  const session = await createPortalSession(
    org.stripe_customer_id, `${appUrl()}/subscription`, fetcher);
  return session.url;
}
