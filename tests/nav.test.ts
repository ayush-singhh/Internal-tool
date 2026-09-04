/**
 * The sidebar is a security surface, not decoration.
 *
 * Before this, `AppShell` filtered on a hardcoded list of four administration hrefs,
 * which meant every role that was not an administrator still got Carriers, Dispatch,
 * Invoices and Reports — including `sales`, whose whole definition in `constants.ts`
 * is that it sees no carrier, no load and no rate. These cases pin the three panels.
 */
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DB = path.join(tmpdir(), `carrier-hub-nav-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;

let visibleNav: typeof import("../src/lib/nav.ts")["visibleNav"];
let ROLES: typeof import("../src/lib/constants.ts")["ROLES"];

before(async () => {
  ({ visibleNav } = await import("../src/lib/nav.ts"));
  ({ ROLES } = await import("../src/lib/constants.ts"));
  process.on("exit", () => {
    for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
  });
});

const asRole = (role: string, active = 1) => ({
  id: 1,
  organization_id: 1,
  name: "Test User",
  email: "t@x.test",
  role: role as never,
  active,
});

/** Every href the sidebar would render for this role, groups flattened. */
const hrefs = (role: string, active = 1) =>
  visibleNav(asRole(role, active)).flatMap((g) => g.items.map((i) => i.href));

test("an administrator sees every section, Administration included", () => {
  const seen = hrefs(ROLES.ADMIN);
  for (const href of ["/", "/alerts", "/tasks", "/announcements", "/communication", "/calendar",
                      "/leads", "/carriers", "/loads", "/invoices", "/reports", "/team",
                      "/settings", "/import", "/audit"]) {
    assert.ok(seen.includes(href), `admin should see ${href}`);
  }
});

/**
 * Alerts, Tasks and Announcements are on all three of the client's panels, so they are
 * the one part of the sidebar that must survive every filter. Alerts in particular has no
 * `action` at all — it composes only what the reader may already see.
 */
test("the personal cluster reaches every role, including one that can see nothing else", () => {
  for (const role of [ROLES.OWNER, ROLES.ADMIN, ROLES.DISPATCHER, ROLES.ACCOUNT_MANAGER,
                      ROLES.SALES, ROLES.VIEWER]) {
    const seen = hrefs(role);
    for (const href of ["/", "/alerts", "/tasks", "/announcements", "/communication"]) {
      assert.ok(seen.includes(href), `${role} should see ${href}`);
    }
  }
});

test("platform support gets no task list, noticeboard or channels either", () => {
  const seen = hrefs(ROLES.SUPPORT);
  for (const href of ["/tasks", "/announcements", "/communication"]) {
    assert.ok(!seen.includes(href), `support must not see ${href}`);
  }
});

test("an owner sees the same sidebar as an administrator", () => {
  assert.deepEqual(hrefs(ROLES.OWNER), hrefs(ROLES.ADMIN));
});

test("a dispatcher gets carriers and dispatch but no Administration and no pipeline", () => {
  const seen = hrefs(ROLES.DISPATCHER);
  for (const href of ["/", "/carriers", "/loads", "/drivers", "/brokers", "/invoices",
                      "/reports", "/activity", "/calendar"]) {
    assert.ok(seen.includes(href), `dispatcher should see ${href}`);
  }
  // The supplied Dispatcher menu has no Lead Management on it, and leads are refused
  // rather than merely unlisted — see permissions.ts.
  for (const href of ["/leads", "/team", "/settings", "/import", "/audit"]) {
    assert.ok(!seen.includes(href), `dispatcher must not see ${href}`);
  }
});

test("sales sees leads and its own activity — no carrier, load or invoice", () => {
  assert.deepEqual(hrefs(ROLES.SALES), [
    "/", "/alerts", "/tasks", "/announcements", "/communication", "/leads", "/activity",
  ]);
});

test("a viewer reads the book but reaches neither the pipeline nor an administration page", () => {
  const seen = hrefs(ROLES.VIEWER);
  assert.ok(seen.includes("/carriers"));
  assert.ok(seen.includes("/reports"));
  // `/calendar` too: the supplied spec puts the Planning Calendar on the Admin and
  // Dispatcher menus only, so a viewer is refused rather than quietly included.
  for (const href of ["/leads", "/calendar", "/team", "/settings", "/import", "/audit"]) {
    assert.ok(!seen.includes(href), `viewer must not see ${href}`);
  }
});

test("the calendar follows the spec's menus — administrators and dispatch, nobody else", () => {
  for (const role of [ROLES.OWNER, ROLES.ADMIN, ROLES.DISPATCHER]) {
    assert.ok(hrefs(role).includes("/calendar"), `${role} should see /calendar`);
  }
  for (const role of [ROLES.ACCOUNT_MANAGER, ROLES.SALES, ROLES.VIEWER, ROLES.SUPPORT]) {
    assert.ok(!hrefs(role).includes("/calendar"), `${role} must not see /calendar`);
  }
});

test("platform support gets nothing inside a tenant, not even the carrier list", () => {
  assert.deepEqual(hrefs(ROLES.SUPPORT), ["/", "/activity"]);
});

test("a deactivated administrator loses every gated item", () => {
  assert.deepEqual(hrefs(ROLES.ADMIN, 0), ["/", "/activity"]);
});

/**
 * The defect itself, kept executable. `AppShell` used to filter on this deny-list, so the
 * rule was "not an administrator ⇒ sees everything except these four". Reconstructing it
 * here shows what `sales` was actually served, and that the permission-gated nav does not
 * agree with it — the assertion BUGS.md's 2026-09-04 entry cites as its guard.
 */
test("regression: the old admin-href deny-list served sales the carrier and load pages", () => {
  const ADMIN_ONLY = ["/team", "/audit", "/settings", "/import"];
  const underOldRule = hrefs(ROLES.ADMIN).filter((href) => !ADMIN_ONLY.includes(href));

  for (const leaked of ["/carriers", "/active", "/loads", "/brokers", "/invoices", "/reports"]) {
    assert.ok(underOldRule.includes(leaked), `the old rule showed sales ${leaked}`);
  }
  assert.notDeepEqual(underOldRule, hrefs(ROLES.SALES));
  assert.deepEqual(hrefs(ROLES.SALES), [
    "/", "/alerts", "/tasks", "/announcements", "/communication", "/leads", "/activity",
  ]);
});

test("a group with no visible items is dropped rather than rendered empty", () => {
  const groups = visibleNav(asRole(ROLES.SALES));
  assert.ok(groups.every((g) => g.items.length > 0));
  assert.ok(!groups.some((g) => g.heading === "Administration"));
  assert.ok(!groups.some((g) => g.heading === "Carriers"));
});
