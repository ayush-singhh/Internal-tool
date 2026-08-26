import "server-only";
import { get } from "./db.ts";
import { idsOf } from "./lookups.ts";
import { STATUS, OFFBOARDING_STATUSES } from "./constants.ts";

/** Counts shown as badges in the sidebar, so the rail doubles as a workload summary. */
export function navCounts() {
  const active = idsOf("status", [STATUS.ACTIVE]);
  const upcoming = idsOf("status", [STATUS.ABOUT_TO_BE_ACTIVE]);
  const investigating = idsOf("status", [STATUS.PENDING_INVESTIGATION]);
  const exited = idsOf("status", OFFBOARDING_STATUSES);

  const count = (ids: number[]) =>
    ids.length === 0
      ? 0
      : get<{ n: number }>(
          `SELECT COUNT(*) AS n FROM carriers WHERE status_id IN (${ids.map(() => "?").join(",")})`,
          ids,
        )!.n;

  return {
    carriers: get<{ n: number }>("SELECT COUNT(*) AS n FROM carriers")!.n,
    active: count(active),
    onboarding: count(upcoming),
    investigations: count(investigating),
    offboarded: count(exited),
  };
}

export type NavCounts = ReturnType<typeof navCounts>;
