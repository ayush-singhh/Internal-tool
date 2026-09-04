import "server-only";
import { get, run, transaction } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import {
  LOAD_STATUS, LOAD_STATUS_LABELS, LOAD_STATUS_ORDER, MAX_STOPS_PER_KIND, STOP_KIND,
  type LoadException, type LoadStatus, type StopKind,
} from "./constants.ts";
import { nextStatuses } from "./loads.ts";
import { brokerDnuReason } from "./dispatch-admin.ts";

/**
 * Writing loads.
 *
 * Split from `loads.ts` for the same reason `carrier-write.ts` is split from
 * `carriers.ts`: reads and writes have different rules, and the write rules are the ones
 * worth testing directly.
 *
 * Two invariants live here rather than in the UI, because a Server Action is reachable
 * without ever loading a page:
 *
 *   - status moves **forward, one step at a time** (see `setStatus`)
 *   - a load may not be dispatched without a driver (see `setStatus` again)
 */

export type StopInput = {
  kind: StopKind;
  city?: string | null;
  state?: string | null;
  address?: string | null;
  scheduledAt?: string | null;
  notes?: string | null;
};

export type LoadInput = {
  loadNumber?: string | null;
  carrierId: number;
  driverId?: number | null;
  brokerId?: number | null;
  dispatcherId?: number | null;
  commodity?: string | null;
  weightLbs?: number | null;
  temperatureF?: number | null;
  deadheadMiles?: number | null;
  loadedMiles?: number | null;
  rate?: number | null;
  specialInstructions?: string | null;
  /** Pickups and deliveries, in the order the driver runs them. */
  stops?: StopInput[];
};

export type LoadResult = { ok: true; id: number } | { ok: false; error: string };

/** Stops are numbered per kind, so pickup 1..n and delivery 1..n are independent. */
function writeStops(org: Org, loadId: number, stops: StopInput[]): void {
  const counters: Record<string, number> = { [STOP_KIND.PICKUP]: 0, [STOP_KIND.DELIVERY]: 0 };
  for (const stop of stops) {
    const sequence = ++counters[stop.kind]!;
    run(
      `INSERT INTO load_stops (organization_id, load_id, kind, sequence, city, state, address, scheduled_at, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        org.id, loadId, stop.kind, sequence,
        stop.city?.trim() || null, stop.state?.trim() || null, stop.address?.trim() || null,
        stop.scheduledAt || null, stop.notes?.trim() || null,
      ],
    );
  }
}

function checkStops(stops: StopInput[]): string | null {
  const pickups = stops.filter((s) => s.kind === STOP_KIND.PICKUP).length;
  const deliveries = stops.filter((s) => s.kind === STOP_KIND.DELIVERY).length;
  if (pickups === 0) return "A load needs at least one pickup.";
  if (deliveries === 0) return "A load needs at least one delivery.";
  if (pickups > MAX_STOPS_PER_KIND) return `A load can have at most ${MAX_STOPS_PER_KIND} pickups.`;
  if (deliveries > MAX_STOPS_PER_KIND) return `A load can have at most ${MAX_STOPS_PER_KIND} deliveries.`;
  return null;
}

/** Confirms a referenced row belongs to this organisation. The composite foreign keys
 *  would refuse it anyway; this turns a database error into a sentence. */
function belongs(org: Org, table: "carriers" | "drivers" | "brokers", id: number | null | undefined): boolean {
  if (id === null || id === undefined) return true;
  return Boolean(get(`SELECT 1 FROM ${table} WHERE organization_id = ? AND id = ?`, [org.id, id]));
}

export function createLoad(org: Org, input: LoadInput, userId: number | null): LoadResult {
  const stops = input.stops ?? [];
  const stopError = checkStops(stops);
  if (stopError) return { ok: false, error: stopError };

  if (!belongs(org, "carriers", input.carrierId)) return { ok: false, error: "Unknown carrier." };
  if (!belongs(org, "drivers", input.driverId)) return { ok: false, error: "Unknown driver." };
  if (!belongs(org, "brokers", input.brokerId)) return { ok: false, error: "Unknown broker." };

  // The Do Not Use list, enforced where it actually costs money rather than only in the
  // picker. Existing loads keep whichever broker they were booked with — flagging one
  // today does not rewrite what was already run — so this guards creation and nothing else,
  // which is also the only place a load's broker is ever set.
  if (input.brokerId) {
    const refused = brokerDnuReason(org, input.brokerId);
    if (refused) return { ok: false, error: refused };
  }

  const now = new Date().toISOString();
  // A driver at creation means the load is already Assigned; without one it is Created.
  // The status is derived rather than asked for, so the two can never disagree.
  const status: LoadStatus = input.driverId ? LOAD_STATUS.ASSIGNED : LOAD_STATUS.CREATED;

  return transaction(() => {
    run(
      `INSERT INTO loads (organization_id, load_number, carrier_id, driver_id, broker_id,
                          dispatcher_id, status, commodity, weight_lbs, temperature_f,
                          deadhead_miles, loaded_miles, rate, special_instructions,
                          status_changed_at, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        org.id, input.loadNumber?.trim() || null, input.carrierId, input.driverId ?? null,
        input.brokerId ?? null, input.dispatcherId ?? userId ?? null, status,
        input.commodity?.trim() || null, input.weightLbs ?? null, input.temperatureF ?? null,
        input.deadheadMiles ?? null, input.loadedMiles ?? null, input.rate ?? null,
        input.specialInstructions?.trim() || null, now, now, now, userId, userId,
      ],
    );
    const id = get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
    writeStops(org, id, stops);
    return { ok: true as const, id };
  });
}

/**
 * Moves a load one step along the flow.
 *
 * Forward only. Nothing in the product walks a load backwards — a load that was wrongly
 * marked Delivered is corrected by an exception flag and a note, not by pretending it was
 * never delivered, because the timestamps are what an invoice is built from.
 */
export function setStatus(org: Org, id: number, to: LoadStatus, userId: number | null): LoadResult {
  const load = get<{ status: LoadStatus; driver_id: number | null }>(
    "SELECT status, driver_id FROM loads WHERE organization_id = ? AND id = ?",
    [org.id, id],
  );
  if (!load) return { ok: false, error: "Unknown load." };
  if (load.status === to) return { ok: true, id };

  if (!nextStatuses(load.status).includes(to)) {
    const from = LOAD_STATUS_LABELS[load.status];
    return {
      ok: false,
      error:
        LOAD_STATUS_ORDER.indexOf(to) < LOAD_STATUS_ORDER.indexOf(load.status)
          ? `A load cannot go back from ${from} to ${LOAD_STATUS_LABELS[to]}.`
          : `A load goes from ${from} to ${LOAD_STATUS_LABELS[nextStatuses(load.status)[0]!]}, one step at a time.`,
    };
  }
  if (to === LOAD_STATUS.ASSIGNED && !load.driver_id) {
    return { ok: false, error: "Assign a driver before moving this load on." };
  }

  const now = new Date().toISOString();
  const stamp =
    to === LOAD_STATUS.PICKED_UP ? ", picked_up_at = ?"
    : to === LOAD_STATUS.DELIVERED ? ", delivered_at = ?"
    : "";
  run(
    `UPDATE loads SET status = ?, status_changed_at = ?, updated_at = ?, updated_by = ?${stamp}
      WHERE organization_id = ? AND id = ?`,
    stamp
      ? [to, now, now, userId, now, org.id, id]
      : [to, now, now, userId, org.id, id],
  );
  return { ok: true, id };
}

/**
 * Assigning a driver. Doing it on a Created load also advances it to Assigned, because a
 * load with a driver on it is assigned by definition and two facts that must agree are
 * better kept as one.
 */
export function assignDriver(org: Org, id: number, driverId: number | null, userId: number | null): LoadResult {
  const load = get<{ status: LoadStatus }>(
    "SELECT status FROM loads WHERE organization_id = ? AND id = ?", [org.id, id]);
  if (!load) return { ok: false, error: "Unknown load." };
  if (!belongs(org, "drivers", driverId)) return { ok: false, error: "Unknown driver." };
  if (driverId === null && load.status !== LOAD_STATUS.CREATED && load.status !== LOAD_STATUS.ASSIGNED) {
    return { ok: false, error: "This load is already running — it cannot be left without a driver." };
  }

  const now = new Date().toISOString();
  const advance = driverId !== null && load.status === LOAD_STATUS.CREATED;
  const back = driverId === null && load.status === LOAD_STATUS.ASSIGNED;
  const status = advance ? LOAD_STATUS.ASSIGNED : back ? LOAD_STATUS.CREATED : load.status;

  run(
    `UPDATE loads SET driver_id = ?, status = ?, status_changed_at = ?, updated_at = ?, updated_by = ?
      WHERE organization_id = ? AND id = ?`,
    [driverId, status, now, now, userId, org.id, id],
  );
  return { ok: true, id };
}

/**
 * Exception flags sit beside the status. Setting one never changes where the load is in
 * the flow — a delivered load with a deduction is still delivered — and clearing one is
 * passing `null`.
 */
export function setException(
  org: Org, id: number, exception: LoadException | null, userId: number | null,
): LoadResult {
  const load = get("SELECT 1 FROM loads WHERE organization_id = ? AND id = ?", [org.id, id]);
  if (!load) return { ok: false, error: "Unknown load." };
  const now = new Date().toISOString();
  run(
    "UPDATE loads SET exception = ?, updated_at = ?, updated_by = ? WHERE organization_id = ? AND id = ?",
    [exception, now, userId, org.id, id],
  );
  return { ok: true, id };
}

/** Replaces the stop list wholesale. Simpler than diffing, and a stop has no history of
 *  its own worth preserving — the load carries that. */
export function replaceStops(org: Org, id: number, stops: StopInput[]): LoadResult {
  const stopError = checkStops(stops);
  if (stopError) return { ok: false, error: stopError };
  if (!get("SELECT 1 FROM loads WHERE organization_id = ? AND id = ?", [org.id, id])) {
    return { ok: false, error: "Unknown load." };
  }
  return transaction(() => {
    run("DELETE FROM load_stops WHERE organization_id = ? AND load_id = ?", [org.id, id]);
    writeStops(org, id, stops);
    return { ok: true as const, id };
  });
}
