import "server-only";
import { get } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import { idsOf } from "./lookups.ts";
import { can, type Action, type SessionUser } from "./permissions.ts";
import { taskCounts } from "./tasks.ts";
import { unreadCount } from "./announcements.ts";
import { unreadMessages } from "./communication.ts";
import type { IconName } from "../components/icons.tsx";
import {
  STATUS, OFFBOARDING_STATUSES, LOAD_STATUS, LOAD_STATUS_ORDER, LEAD_STATUS_OPEN,
} from "./constants.ts";

/**
 * Counts shown as badges in the sidebar, so the rail doubles as a workload summary.
 *
 * `user` is here because two of these are personal rather than organisational — your open
 * tasks, your unread announcements. Both are deliberately cheap single-row queries: this
 * runs on every page render, so the full alert picture (which re-runs every carrier
 * attention rule) belongs on `/alerts` and not in the rail.
 */
export function navCounts(org: Org, user: SessionUser) {
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

  // Whoever may assign work is watching the whole board; everyone else watches their own.
  // The same test `/tasks` and `alerts.ts` use, so the badge cannot disagree with the page.
  const taskScope = can(user, "task:assign") ? undefined : user.id;

  return {
    tasks: taskCounts(org, taskScope).open,
    announcements: unreadCount(org, user.id),
    messages: unreadMessages(org, user),
    // Open leads only — the badge is a workload figure, and a won or lost lead has
    // stopped being work. Same rule as the loads badge below.
    leads: get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM leads WHERE organization_id = ? AND status IN (${LEAD_STATUS_OPEN.map(() => "?").join(",")})`,
      [org.id, ...LEAD_STATUS_OPEN],
    )!.n,
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

export type NavItem = {
  href: string;
  label: string;
  icon: IconName;
  count?: keyof NavCounts;
  /** Permission that reveals this item. Omitted means every signed-in user sees it. */
  action?: Action;
};
export type NavGroup = { heading?: string; items: NavItem[] };

/**
 * The whole sidebar, with each item naming the permission that reveals it.
 *
 * The three panels the roles see — Admin, Dispatcher, Sales — are not three lists;
 * they are what is left of this one after `can()` runs. That is why a role is never
 * named here: adding one is a change to `permissions.ts` alone, and a role that gains
 * an action gains the page in the same edit. The previous version filtered on a
 * hardcoded list of four admin hrefs, which silently showed every *other* page to
 * every role — including `sales`, which is meant to see no carrier at all.
 */
const NAV_GROUPS: NavGroup[] = [
  {
    // The personal cluster, at the top of all three panels because it is on all three
    // panels in the client's spec.
    //
    // Alerts composes only things the reader may already see, so it cannot leak — but it
    // still names an action rather than naming none. An item that never asks `can()` is
    // precisely the shape of the Phase 16 bug, and without one it appeared in platform
    // support's sidebar, offering a page that composes nothing for them. `task:view` is
    // the honest gate: alerts are for people who have a workspace in this organisation.
    //
    // No badge on it: Tasks and Announcements already show theirs, and a third number
    // that adds up the other two is noise. Computing it would also mean re-running every
    // carrier attention rule on every page render, which is why /alerts owns that work.
    items: [
      { href: "/", label: "Dashboard", icon: "dashboard" },
      { href: "/alerts", label: "Alerts", icon: "warning", action: "task:view" },
      { href: "/tasks", label: "Tasks", icon: "check", count: "tasks", action: "task:view" },
      { href: "/announcements", label: "Announcements", icon: "note", count: "announcements", action: "announcement:view" },
      { href: "/communication", label: "Communication", icon: "chat", count: "messages", action: "message:view" },
    ],
  },
  {
    // The sales rep's whole panel, and the front of the admin's. It sits above Carriers
    // because that is the order the work happens in: a lead becomes a carrier.
    heading: "Sales",
    items: [
      { href: "/leads", label: "Lead Management", icon: "leads", count: "leads", action: "lead:view" },
    ],
  },
  {
    heading: "Carriers",
    items: [
      { href: "/carriers", label: "All Carriers", icon: "carriers", count: "carriers", action: "carrier:view" },
      { href: "/active", label: "Active Carriers", icon: "active", count: "active", action: "carrier:view" },
      { href: "/onboarding", label: "Onboarding", icon: "onboarding", count: "onboarding", action: "carrier:view" },
      { href: "/offboarded", label: "Offboarded / Inactive", icon: "offboarded", count: "offboarded", action: "carrier:view" },
      { href: "/investigations", label: "Investigations", icon: "investigations", count: "investigations", action: "carrier:view" },
    ],
  },
  {
    // Doc 2's order: Carrier Management, then Driver Management, then Load Management.
    heading: "Dispatch",
    items: [
      { href: "/loads", label: "Load Management", icon: "loads", count: "loads", action: "load:view" },
      { href: "/drivers", label: "Drivers", icon: "drivers", action: "load:view" },
      { href: "/brokers", label: "Brokers", icon: "brokers", action: "load:view" },
      { href: "/invoices", label: "Invoices", icon: "note", action: "invoice:view" },
    ],
  },
  {
    heading: "Insights",
    items: [
      { href: "/reports", label: "Reports", icon: "reports", action: "carrier:view" },
      { href: "/activity", label: "My Activity", icon: "history" },
    ],
  },
  {
    heading: "Administration",
    items: [
      { href: "/team", label: "Team", icon: "team", action: "team:manage" },
      { href: "/audit", label: "Audit Log", icon: "history", action: "settings:manage" },
      { href: "/settings", label: "Settings", icon: "settings", action: "settings:manage" },
      { href: "/import", label: "Import Data", icon: "import", action: "import:run" },
    ],
  },
];

/** The sidebar this user is allowed to see. Empty groups drop out entirely. */
export function visibleNav(user: SessionUser): NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.action || can(user, item.action)),
  })).filter((group) => group.items.length > 0);
}
