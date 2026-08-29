/**
 * Seeds a demo organisation so the UI can be exercised without touching real data.
 *
 *   npm run seed:demo                          → rebuilds data/demo.db from scratch
 *   npm run dev:demo                           → runs the app against data/demo.db
 *   CARRIER_DB_PATH=/data/carrier-hub.db npm run seed:demo   → adds the demo org to a
 *                                                              deployment (see DEPLOY.md)
 *
 * Everything it writes belongs to one organisation of its own, so on a deployment it sits
 * alongside real tenants without touching them — the same isolation every customer gets.
 * Real carrier records only ever arrive through the Import screen or the Add Carrier form.
 */
import { rmSync } from "node:fs";

const DEMO_PATH = process.env.CARRIER_DB_PATH ?? "data/demo.db";
// Only the throwaway demo database is rebuilt from nothing. Pointed at a real deployment
// it adds an organisation rather than deleting one.
if (DEMO_PATH === "data/demo.db") {
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${DEMO_PATH}${suffix}`, { force: true });
  }
}
process.env.CARRIER_DB_PATH = DEMO_PATH;

const { all, run, get, transaction, systemQuery } = await import("../src/lib/db.ts");
const { hashPassword } = await import("../src/lib/password.ts");
const { createOrganization } = await import("../src/lib/provision.ts");

const now = new Date().toISOString();
const ORG_NAME = "Demo Dispatch Co";
const OWNER_EMAIL = "dana@demo.local";
const PASSWORD = "demo1234";

// One organisation of its own, created the way every other organisation is created.
const existing = systemQuery(() =>
  get<{ id: number }>("SELECT id FROM organizations WHERE name = ?", [ORG_NAME]),
);
if (existing) {
  console.error(`"${ORG_NAME}" already exists in ${DEMO_PATH}. Remove it first, or seed a fresh database.`);
  process.exit(1);
}
const { orgId, ownerId } = createOrganization({
  orgName: ORG_NAME,
  ownerName: "Dana Whitfield",
  ownerEmail: OWNER_EMAIL,
  passwordHash: hashPassword(PASSWORD),
});
// The owner is an admin of their own organisation and has nobody to confirm them.
run("UPDATE users SET role = 'admin' WHERE organization_id = ? AND id = ?", [orgId, ownerId]);

const lookupId = (kind: string, value: string) =>
  get<{ id: number }>(
    "SELECT id FROM lookups WHERE organization_id = ? AND kind = ? AND value = ?",
    [orgId, kind, value],
  )!.id;

const TEAM: [name: string, email: string, role: string][] = [
  ["Marcus Reed", "marcus@demo.local", "dispatcher"],
  ["Priya Nair", "priya@demo.local", "dispatcher"],
  ["Tom Alvarez", "tom@demo.local", "dispatcher"],
  ["Renee Castille", "renee@demo.local", "account_manager"],
  ["Yusuf Demir", "yusuf@demo.local", "account_manager"],
  ["Helen Brooks", "helen@demo.local", "viewer"],
];
const password = hashPassword(PASSWORD);
for (const [name, email, role] of TEAM) {
  run(
    `INSERT INTO users (organization_id, name, email, password_hash, role, active,
                        email_verified_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    [orgId, name, email, password, role, now, now, now],
  );
}
const users = all<{ id: number; name: string; role: string }>(
  "SELECT id, name, role FROM users WHERE organization_id = ?",
  [orgId],
);
const dispatchers = users.filter((u) => u.role === "dispatcher").map((u) => u.id);
const managers = users.filter((u) => u.role === "account_manager").map((u) => u.id);
const adminId = ownerId;

// Deterministic pseudo-random so repeated seeds produce the same demo book.
let seedState = 20250826;
const rnd = () => ((seedState = (seedState * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const chance = (p: number) => rnd() < p;
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

const NAMES_A = ["Ironline", "Sierra Ridge", "Blue Corridor", "Cardinal", "Pinehurst", "Vantage",
  "Northbound", "Copper Creek", "Halcyon", "Redstone", "Granite Bay", "Lakeshore", "Silverpeak",
  "Meridian", "Foxhollow", "Cobalt", "Stonebridge", "Riverbend", "Ashford", "Tallgrass",
  "Windrow", "Beacon Hill", "Junction", "Ridgeway", "Overland", "Kestrel", "Broadleaf",
  "Sandhill", "Willowbrook", "Hightower", "Cedarline", "Marlowe", "Fairmont", "Dunbar"];
const NAMES_B = ["Freight", "Logistics", "Transport", "Carriers", "Trucking", "Haulage", "Express"];
const SUFFIX = ["LLC", "Inc.", "Co.", "LLC", "Transport LLC"];
const FIRST = ["Andre", "Bianca", "Curtis", "Dmitri", "Elena", "Farrah", "Gerald", "Hana",
  "Ivan", "Jolene", "Karim", "Lucia", "Miles", "Nadia", "Omar", "Paula", "Quinn", "Rosa",
  "Sergei", "Tanya", "Ulises", "Vera", "Wes", "Ximena", "Yosef", "Zara"];
const LAST = ["Okafor", "Mbeki", "Ferreira", "Kowalski", "Nguyen", "Petrov", "Salazar", "Bauer",
  "Castellanos", "Dumont", "Ellison", "Fontaine", "Gagnon", "Haddad", "Ishikawa", "Jovanovic"];
const CITIES: [string, string][] = [["Dallas","TX"],["Chicago","IL"],["Atlanta","GA"],
  ["Phoenix","AZ"],["Columbus","OH"],["Fresno","CA"],["Memphis","TN"],["Charlotte","NC"],
  ["Kansas City","MO"],["Denver","CO"],["Newark","NJ"],["Laredo","TX"],["Salt Lake City","UT"]];
const STREETS = ["Industrial Pkwy", "Commerce Dr", "Depot Rd", "Terminal Way", "Freight Ln",
  "Logistics Blvd", "Warehouse Ct", "Yard St"];

const STATUS_MIX: [string, number][] = [
  ["active", 0.52], ["about_to_be_active", 0.13], ["pending_investigation", 0.07],
  ["inactive", 0.13], ["suspended", 0.05], ["blacklisted", 0.04], ["carrier_back_off", 0.06],
];
function pickStatus(): string {
  let r = rnd();
  for (const [value, weight] of STATUS_MIX) {
    if ((r -= weight) <= 0) return value;
  }
  return "active";
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}

const OFFBOARD_STATUSES = ["inactive", "suspended", "blacklisted", "carrier_back_off"];
const INSERT_CARRIER = `
  INSERT INTO carriers (
    organization_id, serial, legal_name, owner_name, phone, phone_digits, email, address,
    status_id, dispatcher_id, account_manager_id, mc_number, usdot,
    trailer_type_id, trailer_size, truck_count,
    born_date, onboarding_date, first_load_date, onboarding_type_id, lead_source_id,
    plan_id, pricing_type_id, rate, percentage, billing_frequency_id,
    subscription_id, agreement_status_id, invoice_mode_id,
    status_changed_at, review_flags, created_at, updated_at, created_by, updated_by
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

const TRAILERS = ["dry_van","reefer","flatbed","step_deck","power_only","box_truck","hotshot","car_hauler","mixed"];
const SOURCES = ["cold_call","referral","website","social_media","email_campaign","walk_in","partner","other"];
const OTYPES = ["direct","referral","agency","reactivation"];
const PLANS = ["custom","royal","imperial","fleetcore","other"];
const INVOICE = ["factoring","direct_ach","wire","check","quickpay","not_set"];
const AGREEMENTS = ["signed","sent","pending","not_required","expired"];
const SUBS = ["active","paused","cancelled","none"];

let created = 0;
transaction(() => {
for (let i = 1; i <= 46; i++) {
  const status = pickStatus();
  const offboarded = OFFBOARD_STATUSES.includes(status);
  const onboardDays = int(20, 900);
  const legal = `${pick(NAMES_A)} ${pick(NAMES_B)} ${pick(SUFFIX)}`;
  const [city, state] = pick(CITIES);
  const phoneDigits = `${int(200, 989)}${int(200, 989)}${String(int(0, 9999)).padStart(4, "0")}`;
  const pricingType = status === "about_to_be_active" && chance(0.5)
    ? "not_yet_pitched"
    : pick(["percentage_per_load","fixed_monthly","fixed_weekly","custom","percentage_per_load"]);
  const pct = pricingType === "percentage_per_load" ? int(6, 18) : null;
  const rate = pricingType === "fixed_monthly" ? int(600, 2400)
    : pricingType === "fixed_weekly" ? int(180, 700) : null;
  const freq = pricingType === "percentage_per_load" ? "per_load"
    : pricingType === "fixed_monthly" ? "monthly"
    : pricingType === "fixed_weekly" ? "weekly" : "other";
  const firstLoad = status === "about_to_be_active"
    ? (chance(0.35) ? isoDaysAgo(onboardDays - int(2, 10)) : null)
    : isoDaysAgo(Math.max(1, onboardDays - int(2, 20)));

  run(INSERT_CARRIER, [
    orgId,
    `CH-${String(1000 + i)}`,
    legal,
    `${pick(FIRST)} ${pick(LAST)}`,
    phoneDigits, phoneDigits,
    chance(0.9) ? `dispatch@${legal.split(" ")[0]!.toLowerCase()}.example` : null,
    `${int(100, 9800)} ${pick(STREETS)}, ${city}, ${state} ${int(10000, 99999)}`,
    lookupId("status", status),
    pick(dispatchers),
    chance(0.85) ? pick(managers) : null,
    chance(0.94) ? String(int(100000, 1600000)) : null,
    chance(0.9) ? String(int(1000000, 4200000)) : null,
    lookupId("trailer_type", pick(TRAILERS)),
    pick(["53'", "48'", "26'", "40'", "Mixed"]),
    int(1, 34),
    isoDaysAgo(onboardDays + int(30, 400)),
    isoDaysAgo(onboardDays),
    firstLoad,
    lookupId("onboarding_type", pick(OTYPES)),
    lookupId("lead_source", pick(SOURCES)),
    lookupId("plan", pick(PLANS)),
    lookupId("pricing_type", pricingType),
    rate, pct,
    lookupId("billing_frequency", freq),
    lookupId("subscription", offboarded ? pick(["cancelled","none"]) : pick(SUBS)),
    lookupId("agreement_status", pick(AGREEMENTS)),
    lookupId("invoice_mode", pick(INVOICE)),
    isoDaysAgo(int(1, 90)),
    chance(0.08) ? JSON.stringify(["Imported value did not match a known option"]) : null,
    now, now, adminId, adminId,
  ]);
  created++;

  const carrierId = get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
  run(
    `INSERT INTO carrier_activity (organization_id, carrier_id, user_id, type, summary, created_at)
     VALUES (?, ?, ?, 'created', 'Carrier record created', ?)`,
    [orgId, carrierId, adminId, now],
  );

  if (offboarded) {
    run(
      `INSERT INTO offboarding_records (organization_id, carrier_id, offboarded_on, reason_id,
         category_id, final_status_id, handled_by, last_load_date, outstanding_balance,
         subscription_cancelled, agreement_closed, can_return, notes, created_at, created_by)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        orgId, carrierId, isoDaysAgo(int(1, 120)),
        lookupId("offboard_reason", pick(["rates_too_low","went_to_competitor","ceased_operations",
          "insurance_lapse","no_longer_responsive","payment_dispute","authority_revoked"])),
        lookupId("offboard_category", pick(["voluntary","involuntary","compliance","non_payment","inactivity"])),
        lookupId("final_status", pick(["closed_good_standing","closed_balance_due","terminated","do_not_reengage"])),
        pick([adminId, ...managers]),
        isoDaysAgo(int(5, 200)),
        chance(0.3) ? int(200, 6000) : 0,
        chance(0.8) ? 1 : 0, chance(0.7) ? 1 : 0,
        status === "blacklisted" ? 0 : chance(0.7) ? 1 : 0,
        "Demo offboarding record.",
        now, adminId,
      ],
    );
  }
}

});

console.log(`Demo organisation "${ORG_NAME}" ready in ${DEMO_PATH}`);
console.log(`  ${created} carriers, ${TEAM.length + 1} team members`);
console.log(`  Sign in: ${OWNER_EMAIL} / ${PASSWORD} (admin)`);
