/**
 * Dispatch invoices.
 *
 * computeDispatchFee is pure and gets its own no-database slice; createInvoice and
 * setInvoiceStatus need a real database and are added once invoice-write.ts exists.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";

let inv: typeof import("../src/lib/invoices.ts");

before(async () => {
  inv = await import("../src/lib/invoices.ts");
});

test("computeDispatchFee: percentage of Final Load Amount", () => {
  const result = inv.computeDispatchFee({ pricingType: "percentage_per_load", rate: null, percentage: 10 }, 3920);
  assert.deepEqual(result, { ok: true, basis: "percentage", rateValue: 10, amount: 392 });
});

test("computeDispatchFee: flat fee ignores Final Load Amount", () => {
  const result = inv.computeDispatchFee({ pricingType: "flat_per_load", rate: 75, percentage: null }, 3920);
  assert.deepEqual(result, { ok: true, basis: "flat", rateValue: 75, amount: 75 });
});

test("computeDispatchFee: missing configuration is an error, not a guess", () => {
  assert.equal(inv.computeDispatchFee({ pricingType: "percentage_per_load", rate: null, percentage: null }, 100).ok, false);
  assert.equal(inv.computeDispatchFee({ pricingType: "flat_per_load", rate: null, percentage: null }, 100).ok, false);
});

test("computeDispatchFee: an unsupported pricing type refuses rather than guessing", () => {
  for (const pricingType of ["fixed_monthly", "fixed_weekly", "custom", "not_yet_pitched", null]) {
    const result = inv.computeDispatchFee({ pricingType, rate: 100, percentage: 10 }, 1000);
    assert.equal(result.ok, false);
  }
});

test("computeDispatchFee rounds to the cent", () => {
  const result = inv.computeDispatchFee({ pricingType: "percentage_per_load", rate: null, percentage: 12.5 }, 333.33);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.amount, 41.67);
});
