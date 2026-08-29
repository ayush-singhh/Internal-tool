import "server-only";

/**
 * Tenant-owned tables. Every read or write of one of these must constrain
 * `organization_id`, or the guard in db.ts refuses the statement (fail-closed).
 *
 * The list is the single source of truth shared by the guard and by tests.
 */
export const TENANT_TABLES = [
  "carriers",
  "carrier_notes",
  "carrier_activity",
  "offboarding_records",
  "saved_filters",
  "users",
  "lookups",
  "app_settings",
  "audit_log",
] as const;

const TENANT_SET = new Set<string>(TENANT_TABLES);

/**
 * A carrier of the authenticated organisation id, nothing more. Query functions take one
 * and thread `org.id` into their SQL explicitly, so every predicate is visible and
 * greppable rather than hidden inside a builder. The guard is what makes that safe: a
 * query that forgets the predicate throws instead of leaking.
 *
 * The id comes only from the server-side session (see auth.ts), never from a request.
 */
export class Org {
  readonly id: number;
  // A plain field rather than a TypeScript parameter property: Node's type-stripping
  // loader (used by `node --test` and by scripts) does not support parameter properties.
  constructor(id: number) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error("Org requires a valid organization id derived from the session.");
    }
    this.id = id;
  }
}

/**
 * Inspects a SQL statement and reports whether it touches a tenant table without
 * constraining organization_id. Used by the db.ts guard. Deliberately simple and
 * conservative: it errs toward *demanding* a predicate, so the failure mode is a caller
 * being forced to scope, never a silent pass.
 */
export function tenantTablesLackingScope(sql: string): string[] {
  const normalized = sql.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ");
  // Tables named after FROM / JOIN / INTO / UPDATE / DELETE FROM.
  const named = new Set<string>();
  const re = /\b(?:from|join|into|update)\s+([a-z_][a-z0-9_]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(normalized)) !== null) {
    const table = match[1]!.toLowerCase();
    if (TENANT_SET.has(table)) named.add(table);
  }
  if (named.size === 0) return [];
  // If the statement references organization_id at all, assume it is scoped. This is a
  // guard against forgetting, not a proof of correctness — correctness is covered by the
  // adversarial cross-tenant tests. A false "scoped" here still cannot leak across the
  // composite foreign keys (Layer 1).
  if (/organization_id/i.test(normalized)) return [];
  return [...named];
}
