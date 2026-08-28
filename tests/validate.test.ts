import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkDateOrder, choice, date, decimal, digitsOnly, email, integer,
  percentage, phone, required, str, type FieldErrors,
} from "../src/lib/validate.ts";

const fresh = (): FieldErrors => ({});

test("MC and USDOT accept digits and unwrap common formatting", () => {
  let e = fresh();
  assert.equal(digitsOnly("123456", "mc", "MC", e), "123456");
  assert.equal(digitsOnly("MC-123456", "mc", "MC", e), "123456");
  assert.equal(digitsOnly(" 12 34 56 ", "mc", "MC", e), "123456");
  assert.deepEqual(e, {});

  e = fresh();
  assert.equal(digitsOnly("abc", "mc", "MC", e), null);
  assert.equal(e.mc, "MC must be a number.");

  e = fresh();
  assert.equal(digitsOnly("1".repeat(11), "mc", "MC", e, 10), null);
  assert.equal(e.mc, "MC is too long.");

  assert.equal(digitsOnly("", "mc", "MC", fresh()), null, "blank stays blank, no error");
});

test("email is validated and normalised", () => {
  const e = fresh();
  assert.equal(email("Dispatch@Carrier.COM", "email", e), "dispatch@carrier.com");
  assert.deepEqual(e, {});

  const bad = fresh();
  assert.equal(email("not-an-email", "email", bad), null);
  assert.equal(bad.email, "Enter a valid email address.");
  assert.equal(email("a@b", "email", fresh()), null, "needs a TLD");
});

test("phone keeps what was typed and derives digits for search", () => {
  const e = fresh();
  assert.deepEqual(phone("(555) 123-4567", "phone", e), {
    value: "(555) 123-4567", digits: "5551234567",
  });
  assert.deepEqual(e, {});

  const short = fresh();
  assert.deepEqual(phone("12345", "phone", short), { value: "12345", digits: null });
  assert.equal(short.phone, "Enter a phone number with 7–15 digits.");
});

test("percentage is bounded to 0–100", () => {
  assert.equal(percentage("12.5", "pct", fresh()), 12.5);
  assert.equal(percentage("12.5%", "pct", fresh()), 12.5, "a typed % sign is tolerated");
  assert.equal(percentage("0", "pct", fresh()), 0);
  assert.equal(percentage("100", "pct", fresh()), 100);

  const over = fresh();
  assert.equal(percentage("101", "pct", over), null);
  assert.equal(over.pct, "Percentage cannot be more than 100.");

  const under = fresh();
  assert.equal(percentage("-1", "pct", under), null);
  assert.equal(under.pct, "Percentage cannot be less than 0.");
});

test("money accepts pasted spreadsheet formatting", () => {
  assert.equal(decimal("$1,200.50", "rate", "Rate", fresh()), 1200.5);
  assert.equal(decimal("1200", "rate", "Rate", fresh()), 1200);
  const e = fresh();
  assert.equal(decimal("lots", "rate", "Rate", e), null);
  assert.equal(e.rate, "Rate must be a number.");
});

test("truck count must be a non-negative whole number", () => {
  assert.equal(integer("12", "n", "Trucks", fresh(), { min: 0 }), 12);
  const frac = fresh();
  assert.equal(integer("2.5", "n", "Trucks", frac, { min: 0 }), null);
  assert.equal(frac.n, "Trucks must be a whole number.");
  const neg = fresh();
  assert.equal(integer("-1", "n", "Trucks", neg, { min: 0 }), null);
  assert.equal(neg.n, "Trucks cannot be less than 0.");
});

test("dates must be real calendar dates", () => {
  assert.equal(date("2025-03-04", "d", "Date", fresh()), "2025-03-04");
  assert.equal(date("2024-02-29", "d", "Date", fresh()), "2024-02-29", "leap day is real");

  const impossible = fresh();
  assert.equal(date("2025-02-31", "d", "Date", impossible), null);
  assert.equal(impossible.d, "Date is not a real date.");

  const nonLeap = fresh();
  assert.equal(date("2025-02-29", "d", "Date", nonLeap), null);

  const shape = fresh();
  assert.equal(date("03/04/2025", "d", "Date", shape), null);
  assert.equal(shape.d, "Date must be a valid date.");
});

test("milestone dates must run in order", () => {
  const e = fresh();
  checkDateOrder("2025-03-01", "2025-02-01", "first_load", "First load is too early.", e);
  assert.equal(e.first_load, "First load is too early.");

  const ok = fresh();
  checkDateOrder("2025-03-01", "2025-03-01", "first_load", "nope", ok);
  checkDateOrder(null, "2025-01-01", "first_load", "nope", ok);
  checkDateOrder("2025-01-01", null, "first_load", "nope", ok);
  assert.deepEqual(ok, {}, "same day and missing dates are fine");
});

test("dropdown values must be one of the offered ids", () => {
  const allowed = new Set([1, 2, 3]);
  assert.equal(choice("2", "status", "Status", allowed, fresh()), 2);

  const spoofed = fresh();
  assert.equal(choice("99", "status", "Status", allowed, spoofed), null);
  assert.equal(spoofed.status, "Select a valid status.");

  const injected = fresh();
  assert.equal(choice("1; DROP TABLE carriers", "status", "Status", allowed, injected), null);
  assert.ok(injected.status);

  const missing = fresh();
  assert.equal(choice("", "status", "Status", allowed, missing, true), null);
  assert.equal(missing.status, "Status is required.");
  assert.deepEqual(choice("", "status", "Status", allowed, fresh(), false), null);
});

test("required text is trimmed and enforced", () => {
  const e = fresh();
  assert.equal(required("  Ironline Freight  ", "legal_name", "Legal name", e), "Ironline Freight");
  const blank = fresh();
  assert.equal(required("   ", "legal_name", "Legal name", blank), null);
  assert.equal(blank.legal_name, "Legal name is required.");
});

test("str caps length and treats blank as absent", () => {
  assert.equal(str("  hello  "), "hello");
  assert.equal(str("   "), null);
  assert.equal(str(null), null);
  assert.equal(str("x".repeat(300), 255)!.length, 255);
});
