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

/** Checked before a password is ever verified, so a locked account costs no scrypt work. */
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

export function describeLockout(verdict: Extract<ThrottleVerdict, { allowed: false }>): string {
  const minutes = Math.ceil(verdict.retryAfterSeconds / 60);
  const wait = minutes <= 1 ? "a minute" : `${minutes} minutes`;
  return verdict.scope === "email"
    ? `Too many failed sign-in attempts for this account. Try again in ${wait}.`
    : `Too many failed sign-in attempts from this network. Try again in ${wait}.`;
}

/** Shown to an administrator on the Team page. */
export function recentFailures(limit = 20) {
  return all<{ identifier: string; attempts: number; last: string }>(
    `SELECT identifier, COUNT(*) AS attempts, MAX(attempted_at) AS last
       FROM login_attempts
      WHERE succeeded = 0 AND attempted_at >= ?
      GROUP BY identifier
      ORDER BY attempts DESC, last DESC
      LIMIT ?`,
    [windowStart(24 * 60), limit],
  );
}
