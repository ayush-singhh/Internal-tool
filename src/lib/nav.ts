import "server-only";
import { get } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import { idsOf } from "./lookups.ts";
import { STATUS, OFFBOARDING_STATUSES, LOAD_STATUS, LOAD_STATUS_ORDER } from "./constants.ts";

/** Counts shown as badges in the sidebar, so the rail doubles as a workload summary. */
export function navCounts(org: Org) {
  const active = idsOf(org, "status", [STATUS.ACTIVE]);
  const upcoming = idsOf(org, "status", [STATUS.ABOUT_TO_BE_ACTIVE]);
  const investigating = idsOf(org, "status", [STATUS.PENDING_INVESTIGATION]);
  const exited = idsOf(org, "status", OFFBOARDING_STATUSES);

  const count = (ids: number[]) =>
    ids.length === 0
      ? 0
      : get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM carriers WHERE organization_id = ? AND status_id IN (${ids.map(() => "?").join(",")})`,
          [org.id, ...ids],
        )!.n;

  // Loads still being worked — everything before Delivered. The badge is a workload
  // figure, so a delivered load has stopped being work.
  const open = LOAD_STATUS_ORDER.slice(0, LOAD_STATUS_ORDER.indexOf(LOAD_STATUS.DELIVERED));

  return {
    carriers: get<{ n: number }>("SELECT COUNT(*) AS n FROM carriers WHERE organization_id = ?", [org.id])!.n,
    loads: get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM loads WHERE organization_id = ? AND status IN (${open.map(() => "?").join(",")})`,
      [org.id, ...open],
    )!.n,
    active: count(active),
    onboarding: count(upcoming),
    investigations: count(investigating),
    offboarded: count(exited),
  };
}

export type NavCounts = ReturnType<typeof navCounts>;
