import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { form, verifySignature } from "../src/lib/stripe.ts";

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
