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
