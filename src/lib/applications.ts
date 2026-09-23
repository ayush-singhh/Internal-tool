import "server-only";
import { all, get, run, transaction } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import { createCarrier } from "./carrier-write.ts";
import { recordActivity } from "./activity.ts";
import { idOf } from "./lookups.ts";
import { STATUS } from "./constants.ts";

/**
 * Carrier applications — the staging table between the public onboarding portal and the
 * carrier database.
 *
 * Nothing here writes a carrier by itself. `AI Rules.md` §2 opens with "never invent
 * carrier records", and a public form feeding `carriers` directly is precisely what that
 * forbids. Instead an application accumulates what the carrier typed, and a staff member
 * converts it — the shape `convertLead()` already uses, for the same reason. After
 * conversion the application survives, read-only, as the record of how that carrier
 * arrived.
 */

export const APPLICATION_STATUS = {
  DRAFT: "draft",
  SUBMITTED: "submitted",
  CONVERTED: "converted",
  REJECTED: "rejected",
} as const;

export type ApplicationStatus = (typeof APPLICATION_STATUS)[keyof typeof APPLICATION_STATUS];

/** The states in which a carrier is still working through the portal. The partial unique
 *  index in migration 25 covers exactly these. */
const OPEN: ApplicationStatus[] = [APPLICATION_STATUS.DRAFT, APPLICATION_STATUS.SUBMITTED];

export type ApplicationRow = {
  id: number;
  organization_id: number;
  usdot: string;
  legal_name: string;
  dba_name: string | null;
  operating_state: string | null;
  allowed_to_operate: number | null;
  name_source: "fmcsa" | "manual";
  phone: string;
  phone_digits: string;
  email: string;
  status: ApplicationStatus;
  step: string;
  review_notes: string | null;
  rejected_reason: string | null;
  converted_carrier_id: number | null;
  converted_at: string | null;
  converted_by: number | null;
  created_at: string;
  updated_at: string;
  submitted_at: string | null;
};

export type ApplicationInput = {
  usdot: string;
  legal_name: string;
  dba_name?: string | null;
  operating_state?: string | null;
  allowed_to_operate?: boolean | null;
  name_source: "fmcsa" | "manual";
  phone: string;
  phone_digits: string;
  email: string;
};

/** Only the fields the portal may revise while a draft is open. Status, conversion and
 *  timestamps are not among them — they are decided here, never posted. */
export type ApplicationPatch = Partial<{
  legal_name: string;
  dba_name: string | null;
  email: string;
  step: string;
  review_notes: string | null;
}>;

export type Result = { ok: true; id: number } | { ok: false; error: string };

export function getApplication(org: Org, id: number): ApplicationRow | undefined {
  return get<ApplicationRow>(
    "SELECT * FROM carrier_applications WHERE organization_id = ? AND id = ?",
    [org.id, id],
  );
}

/** The open application for a verified phone number — how a returning carrier is found. */
export function applicationForPhone(org: Org, phoneDigits: string): ApplicationRow | undefined {
  return get<ApplicationRow>(
    `SELECT * FROM carrier_applications
      WHERE organization_id = ? AND phone_digits = ? AND status IN (?, ?)
      ORDER BY id DESC LIMIT 1`,
    [org.id, phoneDigits, ...OPEN],
  );
}

/** Oldest first: the one that has been waiting longest is the one going cold. */
export function listApplications(org: Org, status?: ApplicationStatus): ApplicationRow[] {
  if (status) {
    return all<ApplicationRow>(
      `SELECT * FROM carrier_applications
        WHERE organization_id = ? AND status = ? ORDER BY created_at ASC, id ASC`,
      [org.id, status],
    );
  }
  return all<ApplicationRow>(
    "SELECT * FROM carrier_applications WHERE organization_id = ? ORDER BY created_at ASC, id ASC",
    [org.id],
  );
}

/**
 * Opens an application, or resumes the one this carrier already has.
 *
 * **The caller must have verified `phone_digits` by OTP before calling this.** A USDOT
 * number is public information: if knowing one were enough to resume, anybody could read
 * a competitor's onboarding. The phone is the thing that proves it is the same carrier,
 * so an open application reached from a different number is refused rather than joined.
 */
export function openApplication(org: Org, input: ApplicationInput): Result {
  const existing = get<ApplicationRow>(
    `SELECT * FROM carrier_applications
      WHERE organization_id = ? AND usdot = ? AND status IN (?, ?)`,
    [org.id, input.usdot, ...OPEN],
  );

  if (existing) {
    if (existing.phone_digits !== input.phone_digits) {
      return {
        ok: false,
        error:
          "An application for this USDOT number is already in progress. If that is you, " +
          "continue from the number you started with.",
      };
    }
    return { ok: true, id: existing.id };
  }

  const now = new Date().toISOString();
  return transaction(() => {
    run(
      `INSERT INTO carrier_applications
         (organization_id, usdot, legal_name, dba_name, operating_state, allowed_to_operate,
          name_source, phone, phone_digits, email, status, step, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'account', ?, ?)`,
      [
        org.id, input.usdot, input.legal_name, input.dba_name ?? null,
        input.operating_state ?? null,
        input.allowed_to_operate === null || input.allowed_to_operate === undefined
          ? null
          : Number(input.allowed_to_operate),
        input.name_source, input.phone, input.phone_digits, input.email,
        APPLICATION_STATUS.DRAFT, now, now,
      ],
    );
    return { ok: true, id: get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id };
  });
}

export function updateApplication(org: Org, id: number, patch: ApplicationPatch): Result {
  const row = getApplication(org, id);
  if (!row) return { ok: false, error: "Unknown application." };
  if (!OPEN.includes(row.status)) {
    return { ok: false, error: "This application has been closed and can no longer be edited." };
  }

  const keys = Object.keys(patch) as (keyof ApplicationPatch)[];
  if (keys.length === 0) return { ok: true, id };

  // A missing key means "unchanged", never "clear it" (AI Rules §2).
  const now = new Date().toISOString();
  run(
    `UPDATE carrier_applications SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ?
      WHERE organization_id = ? AND id = ?`,
    [...keys.map((k) => patch[k] ?? null), now, org.id, id],
  );
  return { ok: true, id };
}

export function submitApplication(org: Org, id: number): Result {
  const row = getApplication(org, id);
  if (!row) return { ok: false, error: "Unknown application." };
  if (row.status !== APPLICATION_STATUS.DRAFT) {
    return { ok: false, error: "This application has already been submitted." };
  }
  const now = new Date().toISOString();
  run(
    `UPDATE carrier_applications SET status = ?, submitted_at = ?, updated_at = ?
      WHERE organization_id = ? AND id = ?`,
    [APPLICATION_STATUS.SUBMITTED, now, now, org.id, id],
  );
  return { ok: true, id };
}

/** A carrier already on file under this USDOT. Reported to the reviewer, never acted on
 *  automatically — merging two carrier records is a human decision (AI Rules §2). */
export function duplicateCarrierFor(
  org: Org,
  usdot: string,
): { id: number; legal_name: string } | undefined {
  return get<{ id: number; legal_name: string }>(
    "SELECT id, legal_name FROM carriers WHERE organization_id = ? AND usdot = ? LIMIT 1",
    [org.id, usdot],
  );
}

/**
 * Turns a reviewed application into a carrier. The staff act that the whole staging
 * table exists to preserve.
 *
 * The carrier starts at "About to Be Active" — agreed, not yet running — and carries
 * across only what the portal actually collected. Everything else stays null for a
 * human to fill in, because inventing it is the thing AI Rules §2 forbids.
 */
export function convertApplication(org: Org, id: number, userId: number | null): Result {
  const row = getApplication(org, id);
  if (!row) return { ok: false, error: "Unknown application." };
  if (row.converted_carrier_id) {
    return { ok: false, error: "This application has already been converted." };
  }
  if (row.status === APPLICATION_STATUS.REJECTED) {
    return { ok: false, error: "A rejected application cannot be converted." };
  }

  const now = new Date().toISOString();
  const carrierId = transaction(() => {
    const created = createCarrier(
      org,
      {
        legal_name: row.legal_name,
        phone: row.phone,
        phone_digits: row.phone_digits,
        email: row.email,
        usdot: row.usdot,
        status_id: idOf(org, "status", STATUS.ABOUT_TO_BE_ACTIVE) ?? null,
        onboarding_date: now.slice(0, 10),
      },
      userId,
    );
    // So the provenance reads from the carrier's own timeline, not only by querying the
    // applications table backwards.
    recordActivity({
      org,
      carrierId: created,
      userId,
      type: "created",
      summary:
        `Onboarded through the carrier onboarding portal (USDOT ${row.usdot}, ` +
        `phone verified${row.name_source === "fmcsa" ? ", name from FMCSA" : ""})`,
      at: now,
    });
    run(
      `UPDATE carrier_applications
          SET status = ?, converted_carrier_id = ?, converted_at = ?, converted_by = ?,
              updated_at = ?
        WHERE organization_id = ? AND id = ?`,
      [APPLICATION_STATUS.CONVERTED, created, now, userId, now, org.id, id],
    );
    return created;
  });

  return { ok: true, id: carrierId };
}

export function rejectApplication(
  org: Org,
  id: number,
  userId: number | null,
  reason: string,
): Result {
  const row = getApplication(org, id);
  if (!row) return { ok: false, error: "Unknown application." };
  if (row.converted_carrier_id) {
    return { ok: false, error: "This application has already been converted." };
  }
  // A rejection without a reason is one nobody can answer a phone call about.
  const trimmed = reason.trim();
  if (!trimmed) return { ok: false, error: "Give a reason for rejecting this application." };

  const now = new Date().toISOString();
  run(
    `UPDATE carrier_applications
        SET status = ?, rejected_reason = ?, converted_by = ?, updated_at = ?
      WHERE organization_id = ? AND id = ?`,
    [APPLICATION_STATUS.REJECTED, trimmed, userId, now, org.id, id],
  );
  return { ok: true, id };
}
