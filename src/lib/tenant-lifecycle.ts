import "server-only";
import { all, get, run, systemQuery, transaction } from "./db.ts";
import { ROLES } from "./constants.ts";
import { LATEST_VERSION } from "./migrations.ts";

/**
 * Getting an organisation's data out, and getting the organisation gone.
 *
 * Creating a tenant had three routes and ending one had none, which is a strange shape for
 * something sold to companies: "send us our data" and "delete us" are asked before a
 * contract is signed, not after, and the answer was hand-written SQL.
 *
 * Out of band by design, like `support-user.ts` and `set-billing-status.ts` — `/support`
 * is read-only by construction and does not get an exception for the most destructive
 * operation in the product.
 *
 * **Deletion requires an export.** Not politeness: `support_access_log` and `audit_log`
 * are append-only records that outlive the accounts they name, and removing an
 * organisation removes its rows from both. The export file is what the record becomes, so
 * `deleteOrganization` refuses to run without one having been written first.
 */

/** Secrets are never exported. A credential in a file on somebody's laptop is a worse
 *  problem than the one the export was meant to solve, and nothing downstream needs them:
 *  this is an archive and a data-subject deliverable, not a restore image. */
const REDACTED = ["password_hash", "mfa_secret"] as const;

/** Tenant-owned tables, in the order a reader would want them. */
export const OWNED = [
  "users", "lookups", "app_settings", "leads", "carriers", "carrier_notes",
  "carrier_activity", "offboarding_records", "saved_filters", "audit_log",
  "drivers", "brokers", "load_documents", "load_adjustments", "invoices",
  "invoice_lines", "loads", "load_stops",
] as const;

export type TenantExport = {
  exportedAt: string;
  schemaVersion: number;
  note: string;
  organization: Record<string, unknown>;
  tables: Record<string, Record<string, unknown>[]>;
  counts: Record<string, number>;
};

export function organizationByRef(ref: string): { id: number; name: string; slug: string } | undefined {
  return systemQuery(() =>
    get<{ id: number; name: string; slug: string }>(
      "SELECT id, name, slug FROM organizations WHERE slug = ? OR id = ?",
      [ref, Number.isInteger(Number(ref)) ? Number(ref) : -1],
    ),
  );
}

/** Everything this organisation owns, secrets stripped. */
export function exportOrganization(orgId: number): TenantExport {
  const organization = systemQuery(() =>
    get<Record<string, unknown>>("SELECT * FROM organizations WHERE id = ?", [orgId]),
  );
  if (!organization) throw new Error(`No organisation with id ${orgId}.`);

  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const table of OWNED) {
    // `rowid`, not `id`: app_settings is keyed on (organization_id, key) and has no `id`
    // column at all. Every table here is a rowid table, so this orders all of them.
    tables[table] = all<Record<string, unknown>>(
      `SELECT * FROM ${table} WHERE organization_id = ? ORDER BY rowid`,
      [orgId],
    ).map((row) => {
      for (const key of REDACTED) if (key in row) row[key] = null;
      return row;
    });
  }

  // The platform's own record of who looked inside this tenant. Included because deleting
  // the organisation deletes these rows, and this file is where that record goes to live.
  tables.support_access_log = systemQuery(() =>
    all<Record<string, unknown>>(
      `SELECT l.*, u.email AS viewed_by
         FROM support_access_log l LEFT JOIN users u ON u.id = l.user_id
        WHERE l.organization_id = ? ORDER BY l.rowid`,
      [orgId],
    ),
  );

  return {
    exportedAt: new Date().toISOString(),
    schemaVersion: LATEST_VERSION,
    note: `Password hashes and two-factor secrets are deliberately excluded (${REDACTED.join(", ")}).`,
    organization,
    tables,
    counts: Object.fromEntries(Object.entries(tables).map(([t, rows]) => [t, rows.length])),
  };
}

export type DeletionPlan = { table: string; rows: number }[];

/** What deleting this organisation would remove. Shown before anything happens, because
 *  the number of carriers about to disappear is the one fact worth reading twice. */
export function deletionPlan(orgId: number): DeletionPlan {
  const counted = [...OWNED, "support_access_log"];
  return counted.map((table) => ({
    table,
    rows: systemQuery(
      () => get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE organization_id = ?`, [orgId])!.n,
    ),
  }));
}

/**
 * Removes the organisation and everything belonging to it, in one transaction.
 *
 * The order is forced by the schema, not chosen: almost every foreign key here is
 * `NO ACTION`, which blocks rather than cascades, so children go before parents.
 * `carriers` first — that cascade takes notes, activity and offboarding records with it,
 * and it has to happen while their `user_id` references are still valid.
 */
export function deleteOrganization(orgId: number, opts: { exported: boolean }): Record<string, number> {
  if (!opts.exported) {
    throw new Error(
      "Refusing to delete without an export: audit_log and support_access_log rows for " +
        "this organisation go with it, and the export file is where that record survives.",
    );
  }
  const org = systemQuery(() => get<{ id: number }>("SELECT id FROM organizations WHERE id = ?", [orgId]));
  if (!org) throw new Error(`No organisation with id ${orgId}.`);

  // Platform support accounts reach across every tenant. Deleting the organisation they
  // happen to live in would take the platform's own staff with it.
  const support = get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM users WHERE organization_id = ? AND role = ?",
    [orgId, ROLES.SUPPORT],
  )!.n;
  if (support > 0) {
    throw new Error(
      `This organisation holds ${support} platform support account(s). Move them before ` +
        "deleting it — they are not this customer's users.",
    );
  }

  const removed: Record<string, number> = {};
  const del = (table: string, sql: string, params: unknown[]) => {
    removed[table] = run(sql, params).changes as number;
  };

  return systemQuery(() =>
    transaction(() => {
      // Dispatch first, and in this order: invoices before loads (invoice_lines cascades
      // from invoices), load_adjustments and load_documents before loads (neither
      // cascades — same reasoning as the load_documents fix, BUGS.md 2026-09-02), loads
      // references drivers, brokers, carriers and users so they cannot outlive any of
      // them. load_stops cascades from loads.
      del("invoices", "DELETE FROM invoices WHERE organization_id = ?", [orgId]);
      del("load_adjustments", "DELETE FROM load_adjustments WHERE organization_id = ?", [orgId]);
      del("load_documents", "DELETE FROM load_documents WHERE organization_id = ?", [orgId]);
      del("loads", "DELETE FROM loads WHERE organization_id = ?", [orgId]);
      del("drivers", "DELETE FROM drivers WHERE organization_id = ?", [orgId]);
      del("brokers", "DELETE FROM brokers WHERE organization_id = ?", [orgId]);

      // Before carriers, users and lookups: a lead points at all three (its owner, the
      // carrier it was converted into, its source and trailer type) and none of those
      // references cascades.
      del("leads", "DELETE FROM leads WHERE organization_id = ?", [orgId]);

      // Cascades to carrier_notes, carrier_activity and offboarding_records.
      del("carriers", "DELETE FROM carriers WHERE organization_id = ?", [orgId]);
      del("saved_filters", "DELETE FROM saved_filters WHERE organization_id = ?", [orgId]);
      del("audit_log", "DELETE FROM audit_log WHERE organization_id = ?", [orgId]);
      del("support_access_log", "DELETE FROM support_access_log WHERE organization_id = ?", [orgId]);

      // `issued_by` is NO ACTION and nullable: an administrator here may have issued a
      // reset that outlives them, and it would otherwise block the users delete.
      run(
        `UPDATE password_resets SET issued_by = NULL
          WHERE issued_by IN (SELECT id FROM users WHERE organization_id = ?)`,
        [orgId],
      );
      // Cascades to sessions, password_resets, email_verifications, mfa_recovery_codes.
      del("users", "DELETE FROM users WHERE organization_id = ?", [orgId]);

      del("app_settings", "DELETE FROM app_settings WHERE organization_id = ?", [orgId]);
      del("lookups", "DELETE FROM lookups WHERE organization_id = ?", [orgId]);
      del("organizations", "DELETE FROM organizations WHERE id = ?", [orgId]);

      // Nothing may be left pointing at what was just removed. Inside the transaction, so
      // a violation rolls the whole deletion back rather than leaving a half-gone tenant.
      const violations = all("PRAGMA foreign_key_check");
      if (violations.length > 0) {
        throw new Error(
          `Deleting organisation ${orgId} left ${violations.length} dangling reference(s): ` +
            JSON.stringify(violations.slice(0, 5)),
        );
      }
      return removed;
    }),
  );
}
