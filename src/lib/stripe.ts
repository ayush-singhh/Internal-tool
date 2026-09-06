import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Just enough of Stripe's REST API to sell a subscription.
 *
 * ponytail: ~120 lines of `fetch` and `node:crypto` rather than the `stripe` package,
 * which is several megabytes to make four calls. The same reasoning as `s3.ts`: the
 * protocol is documented, frozen and testable, so this is checked rather than hoped at.
 *
 * Transport only. Nothing here knows what a trial or an organisation is.
 */

/**
 * Stripe's form encoding: nested objects and arrays become bracketed keys, so
 * `{ line_items: [{ price: "p" }] }` is `line_items[0][price]=p`.
 *
 * Null and undefined are dropped rather than stringified — Stripe reads the literal
 * "null" as a value, so sending it is a different request from omitting the key.
 */
export function form(value: unknown, prefix = ""): string[][] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((v, i) => form(v, `${prefix}[${i}]`));
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      form(v, prefix ? `${prefix}[${k}]` : k),
    );
  }
  return [[prefix, String(value)]];
}

/** Stripe's own default. Outside it, a captured request is refused rather than replayed. */
const TOLERANCE_SECONDS = 300;

/**
 * Verifies a `Stripe-Signature` header against the raw request body.
 *
 * The body must be the bytes Stripe sent — parsing and re-serialising JSON produces a
 * different string and therefore a different HMAC, which is the classic way this check
 * is written so that it never passes.
 *
 * Returns a verdict rather than throwing: the caller turns it into a 400, and a webhook
 * endpoint that throws on malformed input is a webhook endpoint that 500s all day.
 */
export function verifySignature(
  rawBody: string,
  header: string | null,
  secret: string,
  now = new Date(),
): { ok: true } | { ok: false; reason: string } {
  if (!header) return { ok: false, reason: "No Stripe-Signature header." };

  const parts = header.split(",").map((p) => p.trim());
  const timestamp = parts.find((p) => p.startsWith("t="))?.slice(2);
  if (!timestamp || !/^\d+$/.test(timestamp)) {
    return { ok: false, reason: "Malformed Stripe-Signature header." };
  }

  const age = Math.abs(Math.floor(now.getTime() / 1000) - Number(timestamp));
  if (age > TOLERANCE_SECONDS) {
    return { ok: false, reason: "Signature timestamp is outside the tolerance." };
  }

  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex"),
    "utf8",
  );
  // Every v1 in the header, not just the first: Stripe sends one per active secret while
  // an endpoint secret is being rotated, and only one of them is ours.
  const matched = parts
    .filter((p) => p.startsWith("v1="))
    .map((p) => Buffer.from(p.slice(3), "utf8"))
    .some((candidate) =>
      candidate.length === expected.length && timingSafeEqual(candidate, expected),
    );

  return matched ? { ok: true } : { ok: false, reason: "Signature does not match." };
}

const API = "https://api.stripe.com";

/** Injected so tests never reach the network, the way `startSignup` takes its `Mailer`. */
export type Fetcher = typeof fetch;

function secretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not set — this deployment cannot talk to Stripe.");
  }
  return key;
}

export async function request<T>(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${secretKey()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  if (body) init.body = new URLSearchParams(form(body) as [string, string][]).toString();

  const response = await fetcher(`${API}${path}`, init);
  const text = await response.text();
  if (!response.ok) {
    // Stripe answers { error: { message } }. A proxy in front of it may answer HTML.
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) detail = parsed.error.message;
    } catch {
      /* not JSON — the raw text is the best thing we have */
    }
    throw new Error(`Stripe ${method} ${path} failed (${response.status}): ${detail}`);
  }
  return JSON.parse(text) as T;
}

export type StripeSubscription = {
  id: string;
  status: string;
  customer: string | null;
  trial_end: number | null;
  /** Present on older API versions. Newer ones carry it per item — read both. */
  current_period_end?: number | null;
  items: { data: { price: { id: string }; current_period_end?: number | null }[] };
};

export type StripePrice = {
  id: string;
  unit_amount: number | null;
  currency: string;
  recurring: { interval: string } | null;
};

export function getSubscription(id: string, fetcher?: Fetcher): Promise<StripeSubscription> {
  return request("GET", `/v1/subscriptions/${encodeURIComponent(id)}`, undefined, fetcher);
}

export function getPrice(id: string, fetcher?: Fetcher): Promise<StripePrice> {
  return request("GET", `/v1/prices/${encodeURIComponent(id)}`, undefined, fetcher);
}

export function createCheckoutSession(
  input: {
    priceId: string;
    orgId: number;
    customerId: string | null;
    customerEmail: string | null;
    trialDays: number;
    successUrl: string;
    cancelUrl: string;
  },
  fetcher?: Fetcher,
): Promise<{ id: string; url: string }> {
  return request("POST", "/v1/checkout/sessions", {
    mode: "subscription",
    line_items: [{ price: input.priceId, quantity: 1 }],
    // How the webhook finds the organisation on the very first event, before any
    // customer id has been stored against it.
    client_reference_id: String(input.orgId),
    // A known customer is reused; a new one is created by Stripe from the address. Never
    // both, or the same person ends up as two customers with two payment histories.
    customer: input.customerId,
    customer_email: input.customerId ? null : input.customerEmail,
    subscription_data: { trial_period_days: input.trialDays },
    // The card is collected now and charged on day 15. Without this Stripe may skip
    // collection on a trialling subscription, which is not the product we sold.
    payment_method_collection: "always",
    allow_promotion_codes: true,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  }, fetcher);
}

export function createPortalSession(
  customerId: string,
  returnUrl: string,
  fetcher?: Fetcher,
): Promise<{ url: string }> {
  return request("POST", "/v1/billing_portal/sessions", {
    customer: customerId,
    return_url: returnUrl,
  }, fetcher);
}
