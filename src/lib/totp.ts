import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * RFC 6238 time-based one-time passwords.
 *
 * ponytail: ~40 lines of `node:crypto` rather than an otplib dependency. TOTP is an
 * HMAC, a counter and a modulo; the algorithm is frozen by the RFC and the test below
 * pins it to the RFC's own vector, so there is nothing here to keep up to date.
 *
 * Deliberately pure — no database, no session, no clock of its own beyond an injectable
 * `now`. The replay rule (a step is accepted once) needs storage, so it lives in mfa.ts.
 */
const DIGITS = 6;
const STEP_SECONDS = 30;
/** One step either side: the RFC's allowance for drift between a phone and this server. */
const DRIFT_STEPS = 1;
const SECRET_BYTES = 20; // 160 bits, the size RFC 4226 specifies for HMAC-SHA1.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32, unpadded — the only encoding authenticator apps accept. */
export function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** A new secret, as hex. Hex is what the database stores; base32 is a display form. */
export function generateSecret(): string {
  return randomBytes(SECRET_BYTES).toString("hex");
}

/** The secret as an authenticator app shows it, in the groups of four people read aloud. */
export function secretForDisplay(secretHex: string): string {
  return base32(Buffer.from(secretHex, "hex")).replace(/(.{4})/g, "$1 ").trim();
}

/** The `otpauth://` URI that goes into the QR code. */
export function otpauthUri(secretHex: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: base32(Buffer.from(secretHex, "hex")),
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params}`;
}

export function currentStep(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / STEP_SECONDS);
}

export function codeAt(secretHex: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", Buffer.from(secretHex, "hex")).update(counter).digest();
  // Dynamic truncation, RFC 4226 §5.3: the low nibble of the last byte picks the offset.
  const offset = mac[mac.length - 1]! & 0x0f;
  const truncated = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(truncated % 10 ** DIGITS).padStart(DIGITS, "0");
}

/**
 * The step the submitted code matched, or null. The caller must reject a step it has
 * already accepted — that, not this function, is what stops a code being replayed.
 */
export function matchStep(
  secretHex: string,
  submitted: string,
  nowMs: number = Date.now(),
): number | null {
  const digits = submitted.replace(/\D/g, "");
  if (digits.length !== DIGITS) return null;
  const now = currentStep(nowMs);
  for (let offset = -DRIFT_STEPS; offset <= DRIFT_STEPS; offset++) {
    if (equal(codeAt(secretHex, now + offset), digits)) return now + offset;
  }
  return null;
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
