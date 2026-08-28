import { hashSync, verifySync } from "@node-rs/argon2";
import { scryptSync, timingSafeEqual } from "node:crypto";

// ponytail: no options object — @node-rs/argon2's defaults already are the OWASP
// argon2id parameters (m=19456, t=2, p=1). Pass options only to raise them deliberately.

/** Key length of the retired scrypt scheme, kept only to verify hashes made before it. */
const LEGACY_KEYLEN = 64;

export function hashPassword(password: string): string {
  return hashSync(password);
}

/**
 * True for a hash made by the retired scrypt scheme. Such hashes still verify, but the
 * caller re-hashes on the next successful login, while it holds the plaintext (auth.ts).
 */
export function needsRehash(stored: string): boolean {
  return !stored.startsWith("$argon2");
}

export function verifyPassword(password: string, stored: string): boolean {
  if (!needsRehash(stored)) {
    // verifySync throws on a malformed hash rather than returning false.
    try {
      return verifySync(stored, password);
    } catch {
      return false;
    }
  }
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const candidate = scryptSync(password, salt, LEGACY_KEYLEN);
  const expected = Buffer.from(hash, "hex");
  if (candidate.length !== expected.length) return false;
  return timingSafeEqual(candidate, expected);
}
