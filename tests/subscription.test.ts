import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A throwaway database per run — tests never touch data/carrier-hub.db. Set before the
// first import of anything, because db.ts binds CARRIER_DB_PATH when it is first loaded.
const DB = path.join(tmpdir(), `carrier-hub-subscription-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;
process.env.STRIPE_SECRET_KEY = "sk_test_pretend";
process.env.STRIPE_PRICE_MONTHLY = "price_monthly";
process.env.STRIPE_PRICE_YEARLY = "price_yearly";

type Db = typeof import("../src/lib/db.ts");
type Sub = typeof import("../src/lib/subscription.ts");

let db: Db;
let sub: Sub;
let orgId: number;

/** A Stripe subscription object, with the fields the mirror actually reads. */
const stripeSub = (over: Record<string, unknown> = {}) => ({
  id: "sub_1",
  status: "trialing",
  customer: "cus_9",
  trial_end: 1_789_000_000,
  items: { data: [{ price: { id: "price_monthly" }, current_period_end: 1_789_000_000 }] },
  ...over,
});

/** A stub `fetch` that always answers with `body` and counts how often it was asked. */
function stub(body: unknown) {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetcher, calls: () => calls };
}

const event = (type: string, object: Record<string, unknown>, id = `evt_${Math.random()}`) =>
  ({ id, type, data: { object } });

before(async () => {
  db = await import("../src/lib/db.ts");
  sub = await import("../src/lib/subscription.ts");
  orgId = db.get<{ id: number }>("SELECT id FROM organizations LIMIT 1")!.id;
  // The bootstrap org is comped. These tests are about a paying one.
  db.systemQuery(() =>
    db.run("UPDATE organizations SET billing_mode = 'stripe' WHERE id = ?", [orgId]));
});

after(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB}${suffix}`, { force: true });
});

test("Stripe's vocabulary maps onto ORG_STATUS, and an unknown word fails closed", () => {
  assert.equal(sub.statusFor("trialing"), "trial");
  assert.equal(sub.statusFor("active"), "active");
  assert.equal(sub.statusFor("past_due"), "past_due");
  assert.equal(sub.statusFor("incomplete"), "past_due");
  assert.equal(sub.statusFor("canceled"), "suspended");
  assert.equal(sub.statusFor("unpaid"), "suspended");
  assert.equal(sub.statusFor("something_stripe_added_last_week"), "suspended");
});

test("a price is named only when it is one of ours", () => {
  assert.equal(sub.planFor("price_monthly"), "monthly");
  assert.equal(sub.planFor("price_yearly"), "yearly");
  assert.equal(sub.planFor("price_from_2019"), null);
  assert.equal(sub.planFor(null), null);
});

test("a checkout completion links the organisation to its subscription", async () => {
  const { fetcher } = stub(stripeSub());
  const outcome = await sub.handleEvent(
    event("checkout.session.completed", {
      subscription: "sub_1", client_reference_id: String(orgId), customer: "cus_9",
    }),
    fetcher,
  );

  const row = sub.orgBilling(orgId);
  assert.equal(row.stripe_subscription_id, "sub_1");
  assert.equal(row.stripe_customer_id, "cus_9");
  assert.equal(row.status, "trial");
  assert.equal(row.plan, "monthly");
  assert.equal(row.trial_ends_at, new Date(1_789_000_000 * 1000).toISOString());
  assert.match(outcome, /trial/);
});

test("the event body is never trusted — the subscription is read back from Stripe", async () => {
  // The event says the customer is fine. Stripe says they are cancelled. Stripe wins,
  // which is what makes out-of-order delivery harmless.
  const { fetcher } = stub(stripeSub({ status: "canceled" }));
  await sub.handleEvent(
    event("customer.subscription.updated", { id: "sub_1", customer: "cus_9", status: "active" }),
    fetcher,
  );
  assert.equal(sub.orgBilling(orgId).status, "suspended");
});

test("a redelivered event does no work the second time", async () => {
  const { fetcher, calls } = stub(stripeSub({ status: "active" }));
  const twice = event("customer.subscription.updated", { id: "sub_1", customer: "cus_9" }, "evt_same");

  const first = await sub.handleEvent(twice, fetcher);
  const second = await sub.handleEvent(twice, fetcher);

  assert.equal(calls(), 1, "Stripe was asked once, not twice");
  assert.match(second, /duplicate/i);
  assert.doesNotMatch(first, /duplicate/i);
  assert.equal(sub.orgBilling(orgId).status, "active");
});

test("an event for a customer we do not know is reported, not thrown", async () => {
  // Throwing would make Stripe retry an event that can never succeed, for days.
  const { fetcher } = stub(stripeSub({ customer: "cus_stranger" }));
  const outcome = await sub.handleEvent(
    event("customer.subscription.updated", { id: "sub_x", customer: "cus_stranger" }),
    fetcher,
  );
  assert.match(outcome, /no organisation/i);
});

test("a comped organisation stays comped even after it subscribes", async () => {
  // The webhook must never be able to start paywalling a grandfathered tenant. Moving an
  // organisation onto billing is a deliberate act, via scripts/set-billing-status.ts.
  db.systemQuery(() =>
    db.run("UPDATE organizations SET billing_mode = 'comped' WHERE id = ?", [orgId]));
  const { fetcher } = stub(stripeSub({ status: "active" }));
  await sub.handleEvent(
    event("customer.subscription.updated", { id: "sub_1", customer: "cus_9" }), fetcher);

  assert.equal(sub.orgBilling(orgId).billing_mode, "comped");
  db.systemQuery(() =>
    db.run("UPDATE organizations SET billing_mode = 'stripe' WHERE id = ?", [orgId]));
});
