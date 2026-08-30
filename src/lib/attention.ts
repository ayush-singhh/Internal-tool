import "server-only";
import { all, getSettings } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import { idOf, idsOf } from "./lookups.ts";
import { STATUS } from "./constants.ts";
import type { Tone } from "./constants.ts";

export type AttentionItem = {
  id: number;
  legal_name: string;
  detail: string | null;
};

export type AttentionRule = {
  key: string;
  label: string;
  description: string;
  tone: Tone;
  count: number;
  items: AttentionItem[];
  href?: string;
};

const SAMPLE = 5;

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}

function daysAheadIso(days: number): string {
  return new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
}

const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * The work queue. Every rule is a plain query against current data — nothing is
 * precomputed or cached, so an item leaves the queue the moment it is resolved.
 * Thresholds come from Settings.
 */
export function needsAttention(org: Org): AttentionRule[] {
  const settings = getSettings(org.id);
  const num = (key: string, fallback: number) => {
    const n = Number(settings[key]);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const staleUpcoming = num("about_to_be_active_days", 14);
  const staleFirstLoad = num("missing_first_load_days", 21);
  const staleInvestigation = num("investigation_stale_days", 7);
  const insuranceWarning = num("insurance_expiry_days", 30);

  const upcomingId = idOf(org, "status", STATUS.ABOUT_TO_BE_ACTIVE);
  const investigationId = idOf(org, "status", STATUS.PENDING_INVESTIGATION);
  const activeId = idOf(org, "status", STATUS.ACTIVE);
  const signedId = idOf(org, "agreement_status", "signed");
  const notRequiredId = idOf(org, "agreement_status", "not_required");
  const notPitchedId = idOf(org, "pricing_type", "not_yet_pitched");
  const notSetInvoiceId = idOf(org, "invoice_mode", "not_set");
  const liveIds = idsOf(org, "status", [STATUS.ACTIVE, STATUS.ABOUT_TO_BE_ACTIVE]);

  const query = (sql: string, params: unknown[] = []) =>
    all<AttentionItem>(sql, params);

  const rules: (AttentionRule | null)[] = [
    upcomingId === undefined ? null : rule({
      key: "stale_upcoming",
      label: "About to be active too long",
      description: `Marked About to Be Active for more than ${staleUpcoming} days`,
      tone: "amber",
      href: `/carriers?status=${upcomingId}`,
      items: query(
        `SELECT id, legal_name,
                'Waiting since ' || COALESCE(substr(status_changed_at, 1, 10), 'unknown') AS detail
           FROM carriers
          WHERE organization_id = ? AND status_id = ? AND substr(status_changed_at, 1, 10) <= ?
          ORDER BY status_changed_at`,
        [org.id, upcomingId, daysAgoIso(staleUpcoming)],
      ),
    }),

    investigationId === undefined ? null : rule({
      key: "stale_investigation",
      label: "Investigation unresolved",
      description: `Pending Investigation for more than ${staleInvestigation} days`,
      tone: "red",
      href: `/investigations`,
      items: query(
        `SELECT id, legal_name,
                'Open since ' || COALESCE(substr(status_changed_at, 1, 10), 'unknown') AS detail
           FROM carriers
          WHERE organization_id = ? AND status_id = ? AND substr(status_changed_at, 1, 10) <= ?
          ORDER BY status_changed_at`,
        [org.id, investigationId, daysAgoIso(staleInvestigation)],
      ),
    }),

    rule({
      key: "agreement_unsigned",
      label: "Agreement not signed",
      description: "Active or onboarding carriers without a signed agreement",
      tone: "amber",
      items:
        liveIds.length === 0
          ? []
          : query(
              `SELECT c.id, c.legal_name, COALESCE(l.label, 'No agreement recorded') AS detail
                 FROM carriers c LEFT JOIN lookups l ON l.id = c.agreement_status_id
                WHERE c.organization_id = ? AND c.status_id IN (${liveIds.map(() => "?").join(",")})
                  AND (c.agreement_status_id IS NULL
                       OR (c.agreement_status_id != ? AND c.agreement_status_id != ?))
                ORDER BY c.legal_name`,
              [org.id, ...liveIds, signedId ?? -1, notRequiredId ?? -1],
            ),
    }),

    notPitchedId === undefined ? null : rule({
      key: "not_pitched",
      label: "Plan not pitched",
      description: "No pricing has been proposed yet",
      tone: "blue",
      href: `/carriers?pricing=${notPitchedId}`,
      items: query(
        `SELECT id, legal_name, NULL AS detail
           FROM carriers WHERE organization_id = ? AND pricing_type_id = ? ORDER BY legal_name`,
        [org.id, notPitchedId],
      ),
    }),

    activeId === undefined ? null : rule({
      key: "missing_first_load",
      label: "Missing first load date",
      description: `Onboarded more than ${staleFirstLoad} days ago with no first load recorded`,
      tone: "amber",
      items: query(
        `SELECT id, legal_name,
                'Onboarded ' || COALESCE(onboarding_date, 'unknown') AS detail
           FROM carriers
          WHERE organization_id = ? AND first_load_date IS NULL
            AND onboarding_date IS NOT NULL AND onboarding_date <= ?
            AND status_id = ?
          ORDER BY onboarding_date`,
        [org.id, daysAgoIso(staleFirstLoad), activeId],
      ),
    }),

    rule({
      key: "missing_identifiers",
      label: "Missing MC or USDOT",
      description: "A carrier we cannot verify against federal records",
      tone: "red",
      items: query(
        `SELECT id, legal_name,
                CASE WHEN mc_number IS NULL AND usdot IS NULL THEN 'Both missing'
                     WHEN mc_number IS NULL THEN 'MC missing'
                     ELSE 'USDOT missing' END AS detail
           FROM carriers
          WHERE organization_id = ? AND (mc_number IS NULL OR usdot IS NULL)
          ORDER BY legal_name`,
        [org.id],
      ),
    }),

    rule({
      key: "missing_billing",
      label: "Missing billing information",
      description: "Active carriers with no invoice collection mode set",
      tone: "blue",
      items:
        activeId === undefined
          ? []
          : query(
              `SELECT id, legal_name, NULL AS detail
                 FROM carriers
                WHERE organization_id = ? AND status_id = ?
                  AND (invoice_mode_id IS NULL OR invoice_mode_id = ?)
                ORDER BY legal_name`,
              [org.id, activeId, notSetInvoiceId ?? -1],
            ),
    }),

    // Insurance, in two rules rather than one, because they ask for different things: a
    // lapsed certificate means stop giving that carrier loads, a lapsing one means chase
    // the broker this week. Scoped to live carriers — an offboarded carrier's expired
    // certificate is not work.
    //
    // ponytail: no rule for carriers with *no* expiry recorded. Every existing carrier has
    // NULL the day this ships, so it would bury the queue under a few hundred rows that
    // say nothing. Add one once customers have backfilled.
    rule({
      key: "insurance_expired",
      label: "Insurance expired",
      description: "Live carriers whose certificate of insurance has lapsed",
      tone: "red",
      items:
        liveIds.length === 0
          ? []
          : query(
              `SELECT id, legal_name,
                      'Expired ' || insurance_expires_on
                        || COALESCE(' · ' || insurance_provider, '') AS detail
                 FROM carriers
                WHERE organization_id = ? AND status_id IN (${liveIds.map(() => "?").join(",")})
                  AND insurance_expires_on IS NOT NULL AND insurance_expires_on < ?
                ORDER BY insurance_expires_on`,
              [org.id, ...liveIds, todayIso()],
            ),
    }),

    rule({
      key: "insurance_expiring",
      label: "Insurance expiring soon",
      description: `Certificate of insurance expiring within ${insuranceWarning} days`,
      tone: "amber",
      items:
        liveIds.length === 0
          ? []
          : query(
              `SELECT id, legal_name,
                      'Expires ' || insurance_expires_on
                        || COALESCE(' · ' || insurance_provider, '') AS detail
                 FROM carriers
                WHERE organization_id = ? AND status_id IN (${liveIds.map(() => "?").join(",")})
                  AND insurance_expires_on IS NOT NULL
                  AND insurance_expires_on >= ? AND insurance_expires_on <= ?
                ORDER BY insurance_expires_on`,
              [org.id, ...liveIds, todayIso(), daysAheadIso(insuranceWarning)],
            ),
    }),

    rule({
      key: "flagged_import",
      label: "Flagged during import",
      description: "Spreadsheet values preserved but not matched to a known option",
      tone: "purple",
      items: query(
        `SELECT id, legal_name, NULL AS detail
           FROM carriers WHERE organization_id = ? AND review_flags IS NOT NULL ORDER BY legal_name`,
        [org.id],
      ),
    }),
  ];

  return rules
    .filter((r): r is AttentionRule => r !== null && r.count > 0)
    .sort((a, b) => b.count - a.count);
}

function rule(input: Omit<AttentionRule, "count"> & { items: AttentionItem[] }): AttentionRule {
  return { ...input, count: input.items.length, items: input.items.slice(0, SAMPLE) };
}

export function attentionTotal(rules: AttentionRule[]): number {
  return rules.reduce((sum, r) => sum + r.count, 0);
}
