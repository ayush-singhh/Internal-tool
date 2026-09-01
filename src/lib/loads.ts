import "server-only";
import { all, get } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import {
  LOAD_STATUS, LOAD_STATUS_ORDER, STOP_KIND,
  type LoadStatus, type LoadException, type StopKind,
} from "./constants.ts";

/**
 * Reading loads.
 *
 * Same shape as `carriers.ts`: every function takes an `Org` from the session and threads
 * it into the SQL explicitly, so the tenant predicate is visible at each call site rather
 * than hidden in a builder. The fail-closed guard in db.ts is what makes that safe.
 */

export type LoadRow = {
  id: number;
  load_number: string | null;
  carrier_id: number;
  driver_id: number | null;
  broker_id: number | null;
  dispatcher_id: number | null;
  status: LoadStatus;
  exception: LoadException | null;
  commodity: string | null;
  weight_lbs: number | null;
  temperature_f: number | null;
  deadhead_miles: number | null;
  loaded_miles: number | null;
  rate: number | null;
  special_instructions: string | null;
  picked_up_at: string | null;
  delivered_at: string | null;
  status_changed_at: string | null;
  created_at: string;
  updated_at: string;
  /** Joined for display. */
  carrier_name: string;
  driver_name: string | null;
  broker_name: string | null;
  dispatcher_name: string | null;
  /** First pickup and last delivery, so a list row can show a route without loading stops. */
  origin: string | null;
  destination: string | null;
  pickup_count: number;
  delivery_count: number;
};

export type LoadStop = {
  id: number;
  load_id: number;
  kind: StopKind;
  sequence: number;
  city: string | null;
  state: string | null;
  address: string | null;
  scheduled_at: string | null;
  arrived_at: string | null;
  notes: string | null;
};

/**
 * Rate per mile, both ways.
 *
 *   Loaded  = rate ÷ loaded miles                      — what the freight itself paid
 *   Total   = rate ÷ (deadhead + loaded)               — what the truck actually earned
 *
 * Returns null rather than Infinity or NaN when the divisor is missing or zero: a load
 * with no miles recorded has no rate per mile, and "∞/mi" on a dispatch board is worse
 * than an empty cell. **Never shown to a driver** — that is a permission decision made by
 * the caller, but it is the reason this is computed rather than stored.
 */
export function rpm(load: Pick<LoadRow, "rate" | "loaded_miles" | "deadhead_miles">): {
  loaded: number | null;
  total: number | null;
} {
  const rate = load.rate;
  if (rate === null || rate === undefined) return { loaded: null, total: null };
  const loadedMiles = load.loaded_miles ?? 0;
  const totalMiles = loadedMiles + (load.deadhead_miles ?? 0);
  return {
    loaded: loadedMiles > 0 ? rate / loadedMiles : null,
    total: totalMiles > 0 ? rate / totalMiles : null,
  };
}

/** The statuses a load may move to next. Forward only, one step at a time. */
export function nextStatuses(current: LoadStatus): LoadStatus[] {
  const i = LOAD_STATUS_ORDER.indexOf(current);
  return i >= 0 && i < LOAD_STATUS_ORDER.length - 1 ? [LOAD_STATUS_ORDER[i + 1]!] : [];
}

export type LoadFilters = {
  q?: string;
  status?: LoadStatus[];
  exception?: LoadException[];
  carrier?: number[];
  driver?: number[];
  broker?: number[];
  dispatcher?: number[];
  /** Loads still being worked: everything before Delivered. */
  openOnly?: boolean;
};

export type LoadSort = "created_at" | "load_number" | "status" | "carrier" | "rate" | "delivered_at";
export type LoadListOptions = { sort?: LoadSort; dir?: "asc" | "desc"; page?: number; pageSize?: number };

const SORT_SQL: Record<LoadSort, string> = {
  created_at: "l.created_at",
  load_number: "l.load_number",
  status: "l.status",
  carrier: "c.legal_name",
  rate: "l.rate",
  delivered_at: "l.delivered_at",
};

const SELECT = `
  SELECT l.*,
         c.legal_name AS carrier_name,
         d.name       AS driver_name,
         b.name       AS broker_name,
         u.name       AS dispatcher_name,
         (SELECT s.city || CASE WHEN s.state IS NULL THEN '' ELSE ', ' || s.state END
            FROM load_stops s
           WHERE s.organization_id = l.organization_id AND s.load_id = l.id AND s.kind = 'pickup'
           ORDER BY s.sequence LIMIT 1) AS origin,
         (SELECT s.city || CASE WHEN s.state IS NULL THEN '' ELSE ', ' || s.state END
            FROM load_stops s
           WHERE s.organization_id = l.organization_id AND s.load_id = l.id AND s.kind = 'delivery'
           ORDER BY s.sequence DESC LIMIT 1) AS destination,
         (SELECT COUNT(*) FROM load_stops s
           WHERE s.organization_id = l.organization_id AND s.load_id = l.id AND s.kind = 'pickup') AS pickup_count,
         (SELECT COUNT(*) FROM load_stops s
           WHERE s.organization_id = l.organization_id AND s.load_id = l.id AND s.kind = 'delivery') AS delivery_count
    FROM loads l
    JOIN carriers c ON c.organization_id = l.organization_id AND c.id = l.carrier_id
    LEFT JOIN drivers d ON d.organization_id = l.organization_id AND d.id = l.driver_id
    LEFT JOIN brokers b ON b.organization_id = l.organization_id AND b.id = l.broker_id
    LEFT JOIN users   u ON u.organization_id = l.organization_id AND u.id = l.dispatcher_id`;

function buildWhere(org: Org, f: LoadFilters): { sql: string; params: unknown[] } {
  const clauses = ["l.organization_id = ?"];
  const params: unknown[] = [org.id];

  const inList = (column: string, values?: (number | string)[]) => {
    if (!values || values.length === 0) return;
    clauses.push(`${column} IN (${values.map(() => "?").join(",")})`);
    params.push(...values);
  };
  inList("l.status", f.status);
  inList("l.exception", f.exception);
  inList("l.carrier_id", f.carrier);
  inList("l.driver_id", f.driver);
  inList("l.broker_id", f.broker);
  inList("l.dispatcher_id", f.dispatcher);

  if (f.openOnly) {
    const open = LOAD_STATUS_ORDER.slice(0, LOAD_STATUS_ORDER.indexOf(LOAD_STATUS.DELIVERED));
    clauses.push(`l.status IN (${open.map(() => "?").join(",")})`);
    params.push(...open);
  }

  const q = f.q?.trim();
  if (q) {
    const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
    const fields = ["l.load_number", "l.commodity", "c.legal_name", "d.name", "b.name"];
    clauses.push(`(${fields.map((x) => `${x} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    params.push(...fields.map(() => like));
  }

  return { sql: `WHERE ${clauses.join(" AND ")}`, params };
}

export function listLoads(org: Org, filters: LoadFilters = {}, opts: LoadListOptions = {}) {
  const { sql: where, params } = buildWhere(org, filters);

  const total = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM loads l
       JOIN carriers c ON c.organization_id = l.organization_id AND c.id = l.carrier_id
       LEFT JOIN drivers d ON d.organization_id = l.organization_id AND d.id = l.driver_id
       LEFT JOIN brokers b ON b.organization_id = l.organization_id AND b.id = l.broker_id
       ${where}`,
    params,
  )!.n;

  const pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 200);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(opts.page ?? 1, 1), pages);
  const sort = SORT_SQL[opts.sort ?? "created_at"];
  const dir = opts.dir === "asc" ? "ASC" : "DESC";

  const rows = all<LoadRow>(
    `${SELECT} ${where} ORDER BY ${sort} IS NULL, ${sort} ${dir}, l.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize],
  );
  return { rows, total, page, pageSize, pages };
}

export function getLoad(org: Org, id: number): LoadRow | undefined {
  return get<LoadRow>(`${SELECT} WHERE l.organization_id = ? AND l.id = ?`, [org.id, id]);
}

/** Both kinds in one call, pickups first, each in its own order. */
export function loadStops(org: Org, loadId: number): LoadStop[] {
  return all<LoadStop>(
    `SELECT * FROM load_stops
      WHERE organization_id = ? AND load_id = ?
      ORDER BY CASE kind WHEN ? THEN 0 ELSE 1 END, sequence`,
    [org.id, loadId, STOP_KIND.PICKUP],
  );
}

/** Live workload per driver, for assignment decisions. */
export function openLoadsByDriver(org: Org): { driver_id: number; name: string; n: number }[] {
  const open = LOAD_STATUS_ORDER.slice(0, LOAD_STATUS_ORDER.indexOf(LOAD_STATUS.DELIVERED));
  return all<{ driver_id: number; name: string; n: number }>(
    `SELECT d.id AS driver_id, d.name AS name, COUNT(l.id) AS n
       FROM drivers d
       LEFT JOIN loads l ON l.organization_id = d.organization_id AND l.driver_id = d.id
                        AND l.status IN (${open.map(() => "?").join(",")})
      WHERE d.organization_id = ? AND d.active = 1
      GROUP BY d.id ORDER BY n DESC, d.name`,
    [...open, org.id],
  );
}
