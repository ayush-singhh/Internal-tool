import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  createCheckoutSession, createPortalSession, form, getPrice, getSubscription, verifySignature,
} from "../src/lib/stripe.ts";

const encoded = (value: unknown) =>
  new URLSearchParams(form(value) as [string, string][]).toString();

test("nested objects and arrays flatten to Stripe's bracket notation", () => {
  assert.equal(
    encoded({
      mode: "subscription",
      line_items: [{ price: "price_123", quantity: 1 }],
      subscription_data: { trial_period_days: 14 },
    }),
    "mode=subscription" +
      "&line_items%5B0%5D%5Bprice%5D=price_123" +
      "&line_items%5B0%5D%5Bquantity%5D=1" +
      "&subscription_data%5Btrial_period_days%5D=14",
  );
});

test("null and undefined are dropped rather than sent as those words", () => {
  // Stripe reads the literal string "null" as a value, so a dropped key and a null key
  // are very different requests.
  assert.deepEqual(form({ customer: null, customer_email: "a@b.com", trial: undefined }), [
    ["customer_email", "a@b.com"],
  ]);
});

test("booleans and numbers survive as Stripe spells them", () => {
  assert.equal(encoded({ allow_promotion_codes: true, quantity: 1 }),
    "allow_promotion_codes=true&quantity=1");
});

const SECRET = "whsec_a_test_endpoint_secret";
const at = (now: Date) => Math.floor(now.getTime() / 1000);
const sign = (body: string, seconds: number, secret = SECRET) =>
  `t=${seconds},v1=${createHmac("sha256", secret).update(`${seconds}.${body}`, "utf8").digest("hex")}`;

const BODY = '{"id":"evt_1","type":"customer.subscription.updated"}';

test("a signature Stripe would have produced is accepted", () => {
  const now = new Date();
  assert.deepEqual(verifySignature(BODY, sign(BODY, at(now)), SECRET, now), { ok: true });
});

test("a signature over different bytes is refused", () => {
  const now = new Date();
  const verdict = verifySignature('{"id":"evt_2"}', sign(BODY, at(now)), SECRET, now);
  assert.equal(verdict.ok, false);
});

test("a signature from the wrong secret is refused", () => {
  const now = new Date();
  const verdict = verifySignature(BODY, sign(BODY, at(now), "whsec_someone_elses"), SECRET, now);
  assert.equal(verdict.ok, false);
});

test("a timestamp outside the five-minute tolerance is refused, so a capture cannot be replayed", () => {
  const now = new Date();
  const hourAgo = at(now) - 3600;
  const verdict = verifySignature(BODY, sign(BODY, hourAgo), SECRET, now);
  assert.equal(verdict.ok, false);
  assert.match((verdict as { reason: string }).reason, /tolerance/i);
});

test("a missing or malformed header is refused rather than throwing", () => {
  const now = new Date();
  assert.equal(verifySignature(BODY, null, SECRET, now).ok, false);
  assert.equal(verifySignature(BODY, "nonsense", SECRET, now).ok, false);
  assert.equal(verifySignature(BODY, "t=abc,v1=deadbeef", SECRET, now).ok, false);
});

test("one matching v1 among several is enough, which is how a secret is rotated", () => {
  const now = new Date();
  const good = sign(BODY, at(now));
  const stale = createHmac("sha256", "whsec_old").update(`${at(now)}.${BODY}`, "utf8").digest("hex");
  assert.deepEqual(verifySignature(BODY, `${good},v1=${stale}`, SECRET, now), { ok: true });
});

test("a v1 of the wrong length is refused without throwing on the length compare", () => {
  const now = new Date();
  assert.equal(verifySignature(BODY, `t=${at(now)},v1=short`, SECRET, now).ok, false);
});

process.env.STRIPE_SECRET_KEY = "sk_test_pretend";

/** A stub `fetch` that records the one request made and replies with `body`. */
function stub(body: unknown, status = 200) {
  const seen: { url: string; method: string; body: string; auth: string }[] = [];
  const fetcher = (async (url: string | URL, init: RequestInit) => {
    seen.push({
      url: String(url),
      method: String(init.method),
      body: String(init.body ?? ""),
      auth: String((init.headers as Record<string, string>).Authorization),
    });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

test("a checkout session carries the trial, the price and the organisation reference", async () => {
  const { fetcher, seen } = stub({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" });
  const session = await createCheckoutSession({
    priceId: "price_monthly", orgId: 7, customerId: null, customerEmail: "owner@acme.com",
    trialDays: 14, successUrl: "https://app/x?checkout=success", cancelUrl: "https://app/x",
  }, fetcher);

  assert.equal(session.url, "https://checkout.stripe.com/c/pay/cs_1");
  assert.equal(seen[0]!.url, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(seen[0]!.method, "POST");
  assert.equal(seen[0]!.auth, "Bearer sk_test_pretend");
  assert.match(seen[0]!.body, /subscription_data%5Btrial_period_days%5D=14/);
  assert.match(seen[0]!.body, /client_reference_id=7/);
  assert.match(seen[0]!.body, /line_items%5B0%5D%5Bprice%5D=price_monthly/);
  // The card is taken up front — that is the whole shape of the trial we sold.
  assert.match(seen[0]!.body, /payment_method_collection=always/);
  assert.match(seen[0]!.body, /customer_email=owner%40acme\.com/);
});

test("a known customer is reused rather than sent an email address", async () => {
  const { fetcher, seen } = stub({ id: "cs_2", url: "https://checkout.stripe.com/c/pay/cs_2" });
  await createCheckoutSession({
    priceId: "price_monthly", orgId: 7, customerId: "cus_9", customerEmail: "owner@acme.com",
    trialDays: 14, successUrl: "https://app/x", cancelUrl: "https://app/x",
  }, fetcher);
  assert.match(seen[0]!.body, /customer=cus_9/);
  assert.ok(!seen[0]!.body.includes("customer_email"), "no second identity for the same person");
});

test("a portal session is opened for the customer and returns where it came from", async () => {
  const { fetcher, seen } = stub({ url: "https://billing.stripe.com/p/session/x" });
  const session = await createPortalSession("cus_9", "https://app/subscription", fetcher);
  assert.equal(session.url, "https://billing.stripe.com/p/session/x");
  assert.equal(seen[0]!.url, "https://api.stripe.com/v1/billing_portal/sessions");
  assert.match(seen[0]!.body, /customer=cus_9/);
});

test("a subscription is read back by id", async () => {
  const { fetcher, seen } = stub({ id: "sub_1", status: "trialing", customer: "cus_9",
    trial_end: 1789000000, items: { data: [{ price: { id: "price_monthly" } }] } });
  const sub = await getSubscription("sub_1", fetcher);
  assert.equal(sub.status, "trialing");
  assert.equal(seen[0]!.method, "GET");
  assert.equal(seen[0]!.url, "https://api.stripe.com/v1/subscriptions/sub_1");
});

test("a refusal is thrown with Stripe's own words, not a bare status code", async () => {
  const { fetcher } = stub({ error: { message: "No such price: 'price_nope'" } }, 400);
  await assert.rejects(() => getPrice("price_nope", fetcher), /No such price/);
});

test("a refusal that is not JSON still produces a usable error", async () => {
  const fetcher = (async () => new Response("<html>502 Bad Gateway</html>", { status: 502 })) as
    unknown as typeof fetch;
  await assert.rejects(() => getPrice("price_x", fetcher), /502/);
});

test("no secret key is a clear error naming the variable, not a 401 from Stripe", async () => {
  const saved = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  const { fetcher } = stub({});
  await assert.rejects(() => getPrice("price_x", fetcher), /STRIPE_SECRET_KEY/);
  process.env.STRIPE_SECRET_KEY = saved;
});
