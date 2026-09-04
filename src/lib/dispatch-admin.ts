import "server-only";
import { all, get, run } from "./db.ts";
import type { Org } from "./tenant-db.ts";

/**
 * Drivers and brokers — the two reference lists a load is built from.
 *
 * Split from `load-write.ts` because they are managed on their own screens and have their
 * own rule: a dispatcher may **add** a broker the shipped hundred is missing, and only an
 * administrator may **correct** one. That split is what stops a misspelling becoming a
 * second permanent broker, and it is enforced by two separate permissions rather than by
 * which page renders which button.
 */

export type DriverRow = {
  id: number;
  carrier_id: number | null;
  name: string;
  phone: string | null;
  email: string | null;
  truck_number: string | null;
  cdl_number: string | null;
  cdl_expires_on: string | null;
  active: number;
  notes: string | null;
  created_at: string;
  carrier_name: string | null;
  open_loads: number;
};

export type BrokerRow = {
  id: number;
  name: string;
  mc_number: string | null;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  seeded: number;
  active: number;
  /** Do Not Use. Distinct from `active` — see migration 21 and `setBrokerDnu` below. */
  dnu: number;
  dnu_reason: string | null;
  dnu_at: string | null;
  dnu_by: number | null;
  dnu_by_name: string | null;
  load_count: number;
};

export type Result = { ok: true; id: number } | { ok: false; error: string };

/** Digits only, to ten. Doc 2 is explicit: the previous form accepted letters and symbols. */
export function phoneDigits(raw: string | null | undefined): { value: string | null; digits: string | null } {
  const digits = (raw ?? "").replace(/\D/g, "").slice(0, 10);
  if (!digits) return { value: null, digits: null };
  const formatted =
    digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : digits;
  return { value: formatted, digits };
}

export function listDrivers(org: Org): DriverRow[] {
  return all<DriverRow>(
    `SELECT d.*, c.legal_name AS carrier_name,
            (SELECT COUNT(*) FROM loads l
              WHERE l.organization_id = d.organization_id AND l.driver_id = d.id
                AND l.status NOT IN ('delivered', 'invoiced', 'paid', 'closed')) AS open_loads
       FROM drivers d
       LEFT JOIN carriers c ON c.organization_id = d.organization_id AND c.id = d.carrier_id
      WHERE d.organization_id = ?
      ORDER BY d.active DESC, d.name`,
    [org.id],
  );
}

export function saveDriver(
  org: Org,
  input: {
    id?: number | null;
    name: string;
    carrierId?: number | null;
    phone?: string | null;
    email?: string | null;
    truckNumber?: string | null;
    cdlNumber?: string | null;
    cdlExpiresOn?: string | null;
    notes?: string | null;
  },
): Result {
  const name = input.name.trim().slice(0, 120);
  if (!name) return { ok: false, error: "A driver needs a name." };
  if (input.carrierId && !get("SELECT 1 FROM carriers WHERE organization_id = ? AND id = ?", [org.id, input.carrierId])) {
    return { ok: false, error: "Unknown carrier." };
  }

  const phone = phoneDigits(input.phone);
  const now = new Date().toISOString();
  const fields = [
    name, input.carrierId ?? null, phone.value, phone.digits,
    input.email?.trim().toLowerCase() || null,
    input.truckNumber?.trim() || null, input.cdlNumber?.trim() || null,
    input.cdlExpiresOn || null, input.notes?.trim() || null,
  ];

  if (input.id) {
    if (!get("SELECT 1 FROM drivers WHERE organization_id = ? AND id = ?", [org.id, input.id])) {
      return { ok: false, error: "Unknown driver." };
    }
    run(
      `UPDATE drivers SET name = ?, carrier_id = ?, phone = ?, phone_digits = ?, email = ?,
              truck_number = ?, cdl_number = ?, cdl_expires_on = ?, notes = ?, updated_at = ?
        WHERE organization_id = ? AND id = ?`,
      [...fields, now, org.id, input.id],
    );
    return { ok: true, id: input.id };
  }

  run(
    `INSERT INTO drivers (organization_id, name, carrier_id, phone, phone_digits, email,
                          truck_number, cdl_number, cdl_expires_on, notes, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [org.id, ...fields, now, now],
  );
  return { ok: true, id: get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id };
}

/** Deactivating keeps the driver on every load they ever ran. Nothing here deletes one. */
export function setDriverActive(org: Org, id: number, active: boolean): Result {
  if (!get("SELECT 1 FROM drivers WHERE organization_id = ? AND id = ?", [org.id, id])) {
    return { ok: false, error: "Unknown driver." };
  }
  if (!active) {
    const open = get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM loads
        WHERE organization_id = ? AND driver_id = ?
          AND status NOT IN ('delivered', 'invoiced', 'paid', 'closed')`,
      [org.id, id],
    )!.n;
    if (open > 0) {
      return { ok: false, error: `This driver is still on ${open} open load${open === 1 ? "" : "s"}.` };
    }
  }
  run("UPDATE drivers SET active = ?, updated_at = ? WHERE organization_id = ? AND id = ?",
    [active ? 1 : 0, new Date().toISOString(), org.id, id]);
  return { ok: true, id };
}

export function listBrokers(org: Org): BrokerRow[] {
  return all<BrokerRow>(
    `SELECT b.*, u.name AS dnu_by_name,
            (SELECT COUNT(*) FROM loads l
              WHERE l.organization_id = b.organization_id AND l.broker_id = b.id) AS load_count
       FROM brokers b
       LEFT JOIN users u ON u.organization_id = b.organization_id AND u.id = b.dnu_by
      WHERE b.organization_id = ?
      ORDER BY b.dnu DESC, b.active DESC, b.name`,
    [org.id],
  );
}

/**
 * The Do Not Use list.
 *
 * A DNU broker is not retired — it stays on the list, at the top, carrying its reason,
 * because the point is that the next person about to book them learns why not. Retiring
 * (`active = 0`) is the opposite act: tidying something nobody needs to think about.
 *
 * A reason is required. "Do not use" without one is an argument waiting to happen at 3am,
 * and the person who knew why has gone home.
 */
export function setBrokerDnu(
  org: Org,
  id: number,
  input: { dnu: boolean; reason?: string | null },
  userId: number | null,
): Result {
  if (!get("SELECT 1 FROM brokers WHERE organization_id = ? AND id = ?", [org.id, id])) {
    return { ok: false, error: "Unknown broker." };
  }

  if (!input.dnu) {
    // Clearing wipes the reason with it: a stale reason on a broker that is fine again
    // reads as though the flag is still on.
    run(
      `UPDATE brokers SET dnu = 0, dnu_reason = NULL, dnu_at = NULL, dnu_by = NULL
        WHERE organization_id = ? AND id = ?`,
      [org.id, id],
    );
    return { ok: true, id };
  }

  const reason = (input.reason ?? "").trim().slice(0, 500);
  if (!reason) return { ok: false, error: "Say why this broker must not be used." };

  run(
    `UPDATE brokers SET dnu = 1, dnu_reason = ?, dnu_at = ?, dnu_by = ?
      WHERE organization_id = ? AND id = ?`,
    [reason, new Date().toISOString(), userId, org.id, id],
  );
  return { ok: true, id };
}

/** The reason a broker must not be booked, or null if they may be. Used by the load
 *  write path to refuse with a sentence rather than a silent absence. */
export function brokerDnuReason(org: Org, id: number): string | null {
  const row = get<{ name: string; dnu: number; dnu_reason: string | null }>(
    "SELECT name, dnu, dnu_reason FROM brokers WHERE organization_id = ? AND id = ?",
    [org.id, id],
  );
  if (!row || !row.dnu) return null;
  return `${row.name} is on the Do Not Use list${row.dnu_reason ? `: ${row.dnu_reason}` : "."}`;
}

/** Adding one. Open to dispatchers — the shipped list will always be missing somebody. */
export function addBroker(org: Org, name: string, userId: number | null): Result {
  const clean = name.trim().slice(0, 160);
  if (!clean) return { ok: false, error: "A broker needs a name." };
  const existing = get<{ id: number; name: string }>(
    "SELECT id, name FROM brokers WHERE organization_id = ? AND lower(name) = lower(?)",
    [org.id, clean],
  );
  // Matched case-insensitively so "coyote logistics" does not become a second Coyote.
  if (existing) return { ok: false, error: `${existing.name} is already on the list.` };

  run(
    `INSERT INTO brokers (organization_id, name, seeded, active, created_at, created_by)
     VALUES (?, ?, 0, 1, ?, ?)`,
    [org.id, clean, new Date().toISOString(), userId],
  );
  return { ok: true, id: get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id };
}

/** Correcting or retiring one. Administrators only. */
export function updateBroker(
  org: Org,
  id: number,
  input: { name?: string; mcNumber?: string | null; contactName?: string | null; phone?: string | null; email?: string | null; active?: boolean },
): Result {
  if (!get("SELECT 1 FROM brokers WHERE organization_id = ? AND id = ?", [org.id, id])) {
    return { ok: false, error: "Unknown broker." };
  }
  const sets: string[] = [];
  const params: unknown[] = [];

  if (input.name !== undefined) {
    const clean = input.name.trim().slice(0, 160);
    if (!clean) return { ok: false, error: "A broker needs a name." };
    const clash = get<{ id: number }>(
      "SELECT id FROM brokers WHERE organization_id = ? AND lower(name) = lower(?) AND id != ?",
      [org.id, clean, id],
    );
    if (clash) return { ok: false, error: "Another broker already uses that name." };
    sets.push("name = ?"); params.push(clean);
  }
  if (input.mcNumber !== undefined) { sets.push("mc_number = ?"); params.push((input.mcNumber ?? "").replace(/\D/g, "").slice(0, 10) || null); }
  if (input.contactName !== undefined) { sets.push("contact_name = ?"); params.push(input.contactName?.trim() || null); }
  if (input.phone !== undefined) { sets.push("phone = ?"); params.push(phoneDigits(input.phone).value); }
  if (input.email !== undefined) { sets.push("email = ?"); params.push(input.email?.trim().toLowerCase() || null); }
  if (input.active !== undefined) { sets.push("active = ?"); params.push(input.active ? 1 : 0); }

  if (sets.length === 0) return { ok: true, id };
  run(`UPDATE brokers SET ${sets.join(", ")} WHERE organization_id = ? AND id = ?`, [...params, org.id, id]);
  return { ok: true, id };
}
