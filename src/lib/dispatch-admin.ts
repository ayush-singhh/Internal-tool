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
                AND l.status NOT IN ('delivered', 'invoiced', 'closed')) AS open_loads
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
          AND status NOT IN ('delivered', 'invoiced', 'closed')`,
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
    `SELECT b.*,
            (SELECT COUNT(*) FROM loads l
              WHERE l.organization_id = b.organization_id AND l.broker_id = b.id) AS load_count
       FROM brokers b
      WHERE b.organization_id = ?
      ORDER BY b.active DESC, b.name`,
    [org.id],
  );
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
