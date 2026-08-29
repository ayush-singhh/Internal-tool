import "server-only";
import { all, get, run } from "./db.ts";

/**
 * Login throttling.
 *
 * Two independent limits, because they defend against different things:
 *
 *   - **per email** — stops someone grinding passwords against one known account.
 *   - **per IP**, with a higher ceiling — stops one machine spraying many accounts,
 *     which a per-email limit alone never sees.
 *
 * Keeping them separate matters: a per-email lock is also a denial-of-service against
 * the real owner, so its window is short and a successful sign-in clears it immediately.
 * The IP limit is the one that has to be generous, since a whole dispatch office can
 * share a single outbound address.
 *
 * ponytail: counted in SQLite, not an in-memory map — it survives a restart, and it
 * still works if this is ever run as more than one process. Swap in Redis only if the
 * table's write volume ever actually matters.
 */
export type ThrottleRule = { max: number; windowMinutes: number };

export const RULES: Record<"email" | "ip", ThrottleRule> = {
  email: { max: 5, windowMinutes: 15 },
  ip: { max: 30, windowMinutes: 15 },
};

/** Creating organisations is an unauthenticated write, so it gets its own limit. Three an
 *  hour is far above what a real person needs and far below what makes a spam run worth
 *  starting. */
export const SIGNUP_RULE: ThrottleRule = { max: 3, windowMinutes: 60 };

/** Asking for a reset link is unauthenticated too, and it puts mail in somebody else's
 *  inbox — so it is limited per address as well as per host. Someone must not be able to
 *  bury a person in reset mail, or use ours to send it. */
/** A whole-book CSV per person, twenty an hour. Far above anyone working, far below a
 *  script quietly pulling the customer list on a loop. */
export const EXPORT_RULE: ThrottleRule = { max: 20, windowMinutes: 60 };

export const RESET_RULE: Record<"email" | "ip", ThrottleRule> = {
  email: { max: 3, windowMinutes: 60 },
  ip: { max: 10, windowMinutes: 60 },
};

export type ThrottleVerdict =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number; scope: "email" | "ip" };

function windowStart(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function failuresSince(identifier: string, since: string): { count: number; oldest: string | null } {
  const row = get<{ count: number; oldest: string | null }>(
    `SELECT COUNT(*) AS count, MIN(attempted_at) AS oldest
       FROM login_attempts
      WHERE identifier = ? AND succeeded = 0 AND attempted_at >= ?`,
    [identifier, since],
  );
  return { count: row?.count ?? 0, oldest: row?.oldest ?? null };
}

/** Checked before a password is ever verified, so a locked account costs no argon2 work. */
export function checkLogin(email: string, ip: string | null): ThrottleVerdict {
  const checks: [scope: "email" | "ip", identifier: string, rule: ThrottleRule][] = [
    ["email", `email:${email.trim().toLowerCase()}`, RULES.email],
  ];
  if (ip) checks.push(["ip", `ip:${ip}`, RULES.ip]);

  for (const [scope, identifier, rule] of checks) {
    const { count, oldest } = failuresSince(identifier, windowStart(rule.windowMinutes));
    if (count >= rule.max && oldest) {
      const unlocksAt = new Date(oldest).getTime() + rule.windowMinutes * 60_000;
      const retryAfterSeconds = Math.max(1, Math.ceil((unlocksAt - Date.now()) / 1000));
      return { allowed: false, retryAfterSeconds, scope };
    }
  }
  return { allowed: true };
}

export function recordAttempt(email: string, ip: string | null, succeeded: boolean): void {
  const now = new Date().toISOString();
  const key = `email:${email.trim().toLowerCase()}`;

  run("INSERT INTO login_attempts (identifier, succeeded, attempted_at) VALUES (?, ?, ?)", [
    key, succeeded ? 1 : 0, now,
  ]);
  if (ip) {
    run("INSERT INTO login_attempts (identifier, succeeded, attempted_at) VALUES (?, ?, ?)", [
      `ip:${ip}`, succeeded ? 1 : 0, now,
    ]);
  }

  if (succeeded) {
    // Getting in proves you are the owner, so the account's own lock is released at once.
    // The IP counter is left alone — one valid login should not clear a spray from that host.
    run("DELETE FROM login_attempts WHERE identifier = ? AND succeeded = 0", [key]);
  }

  // Opportunistic cleanup so the table cannot grow without bound.
  if (Math.random() < 0.02) {
    run("DELETE FROM login_attempts WHERE attempted_at < ?", [windowStart(24 * 60)]);
  }
}

/**
 * The limit for an unauthenticated action that is not a sign-in — creating an
 * organisation, asking for a reset link. Counted in the same table under a key of its
 * own, and filtered back out of `recentFailures()`, because they are not failed sign-ins
 * and showing them to an administrator as some would be a lie.
 *
 * `scope` only decides which sentence `describeLockout` writes.
 */
export function checkBurst(
  key: string,
  rule: ThrottleRule,
  scope: "email" | "ip" = "ip",
): ThrottleVerdict {
  const { count, oldest } = failuresSince(key, windowStart(rule.windowMinutes));
  if (count < rule.max || !oldest) return { allowed: true };
  const unlocksAt = new Date(oldest).getTime() + rule.windowMinutes * 60_000;
  return {
    allowed: false,
    retryAfterSeconds: Math.max(1, Math.ceil((unlocksAt - Date.now()) / 1000)),
    scope,
  };
}

export function recordBurst(key: string): void {
  run("INSERT INTO login_attempts (identifier, succeeded, attempted_at) VALUES (?, 0, ?)", [
    key, new Date().toISOString(),
  ]);
}

/** "a minute" / "7 minutes" — shared so every limit tells someone the same thing. */
export function retryInWords(verdict: Extract<ThrottleVerdict, { allowed: false }>): string {
  const minutes = Math.ceil(verdict.retryAfterSeconds / 60);
  return minutes <= 1 ? "a minute" : `${minutes} minutes`;
}

export function describeLockout(verdict: Extract<ThrottleVerdict, { allowed: false }>): string {
  const wait = retryInWords(verdict);
  return verdict.scope === "email"
    ? `Too many failed sign-in attempts for this account. Try again in ${wait}.`
    : `Too many failed sign-in attempts from this network. Try again in ${wait}.`;
}

/** Shown to an administrator on the Team page. */
export function recentFailures(limit = 20) {
  return all<{ identifier: string; attempts: number; last: string }>(
    `SELECT identifier, COUNT(*) AS attempts, MAX(attempted_at) AS last
       FROM login_attempts
      WHERE succeeded = 0 AND attempted_at >= ? AND (identifier LIKE 'email:%' OR identifier LIKE 'ip:%')
      GROUP BY identifier
      ORDER BY attempts DESC, last DESC
      LIMIT ?`,
    [windowStart(24 * 60), limit],
  );
}
