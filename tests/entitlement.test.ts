import { test } from "node:test";
import assert from "node:assert/strict";
import { DORMANT_AFTER_DAYS, entitlement, type OrgBilling } from "../src/lib/entitlement.ts";

const NOW = new Date("2026-09-06T12:00:00.000Z");
const at = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();

const org = (over: Partial<OrgBilling> = {}): OrgBilling => ({
  status: "active",
  billing_mode: "stripe",
  plan: "monthly",
  stripe_subscription_id: "sub_1",
  trial_ends_at: null,
  current_period_end: at(20),
  ...over,
});

test("a comped organisation keeps full access whatever else the row says", () => {
  for (const status of ["trial", "active", "past_due", "suspended", "nonsense"]) {
    const verdict = entitlement(
      org({ billing_mode: "comped", status, stripe_subscription_id: null,
            trial_ends_at: at(-400), current_period_end: at(-400) }),
      NOW,
    );
    assert.equal(verdict.access, "full", `comped + ${status}`);
    assert.equal(verdict.notice, null, "and is not nagged about it");
  }
});

test("an organisation with no subscription is read-only and told what to do", () => {
  const verdict = entitlement(org({ stripe_subscription_id: null }), NOW);
  assert.equal(verdict.access, "read_only");
  assert.match(verdict.notice!, /trial/i);
});

test("an active subscription grants full access even if the period end has passed", () => {
  // Deliberate: a webhook missed on renewal night must not lock out someone who has just
  // paid. A missed webhook fails open for a payer, which is the correct direction.
  const verdict = entitlement(org({ status: "active", current_period_end: at(-3) }), NOW);
  assert.equal(verdict.access, "full");
  assert.equal(verdict.notice, null);
});

test("a failed payment warns but keeps writing, because Stripe is still retrying", () => {
  const verdict = entitlement(org({ status: "past_due" }), NOW);
  assert.equal(verdict.access, "full");
  assert.match(verdict.notice!, /payment/i);
});

test("a live trial counts down", () => {
  const verdict = entitlement(org({ status: "trial", trial_ends_at: at(5) }), NOW);
  assert.equal(verdict.access, "full");
  assert.match(verdict.notice!, /5 days/);
  assert.equal(verdict.until, at(5));
});

test("the last day of a trial says one day, never zero", () => {
  const verdict = entitlement(org({ status: "trial", trial_ends_at: at(0.2) }), NOW);
  assert.match(verdict.notice!, /1 day\b/);
});

test("an ended trial is read-only, not locked", () => {
  const verdict = entitlement(org({ status: "trial", trial_ends_at: at(-1) }), NOW);
  assert.equal(verdict.access, "read_only");
  assert.match(verdict.notice!, /trial has ended/i);
});

test("a trial that ended long ago goes dormant", () => {
  const verdict = entitlement(
    org({ status: "trial", trial_ends_at: at(-DORMANT_AFTER_DAYS - 1) }), NOW);
  assert.equal(verdict.access, "none");
  assert.match(verdict.notice!, /inactive/i);
});

test("a cancelled subscription is read-only for thirty days from its period end", () => {
  const recent = entitlement(org({ status: "suspended", current_period_end: at(-2) }), NOW);
  assert.equal(recent.access, "read_only");
  const old = entitlement(
    org({ status: "suspended", current_period_end: at(-DORMANT_AFTER_DAYS - 1) }), NOW);
  assert.equal(old.access, "none");
});

test("a lapse with no date on it gets read-only and its thirty days, not instant dormancy", () => {
  const verdict = entitlement(org({ status: "suspended", current_period_end: null }), NOW);
  assert.equal(verdict.access, "read_only");
});

test("an unparseable date is treated as no date rather than crashing the page", () => {
  const verdict = entitlement(org({ status: "trial", trial_ends_at: "not a date" }), NOW);
  assert.equal(verdict.access, "read_only");
});

test("a status nobody recognised fails closed", () => {
  const verdict = entitlement(org({ status: "something_new_from_stripe" }), NOW);
  assert.notEqual(verdict.access, "full");
});
