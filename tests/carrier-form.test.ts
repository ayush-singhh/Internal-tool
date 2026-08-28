import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const DB = path.join(tmpdir(), `carrier-hub-form-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let form: typeof import("../src/lib/carrier-form.ts");
let write: typeof import("../src/lib/carrier-write.ts");
let carriers: typeof import("../src/lib/carriers.ts");
let allowed: import("../src/lib/carrier-form.ts").AllowedIds;
let userId: number;
let statusActive: number;
let pctLoad: number;

const fd = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};

before(async () => {
  db = await import("../src/lib/db.ts");
  form = await import("../src/lib/carrier-form.ts");
  write = await import("../src/lib/carrier-write.ts");
  carriers = await import("../src/lib/carriers.ts");

  const now = new Date().toISOString();
  db.run(
    `INSERT INTO users (name, email, password_hash, role, active, created_at, updated_at)
     VALUES ('Form Tester', 'form@x.test', 'x', 'dispatcher', 1, ?, ?)`,
    [now, now],
  );
  userId = db.get<{ id: number }>("SELECT id FROM users WHERE email = 'form@x.test'")!.id;
  statusActive = db.get<{ id: number }>(
    "SELECT id FROM lookups WHERE kind='status' AND value='active'",
  )!.id;
  pctLoad = db.get<{ id: number }>(
    "SELECT id FROM lookups WHERE kind='pricing_type' AND value='percentage_per_load'",
  )!.id;
  allowed = form.allowedIds();
});

after(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB}${suffix}`, { force: true });
});

test("a realistic submission becomes a correct carrier record", () => {
  const { input, errors } = form.parseCarrierForm(
    fd({
      legal_name: "  Northbound Freight LLC  ",
      owner_name: "Elena Petrov",
      phone: "(555) 240-1188",
      email: "Dispatch@Northbound.COM",
      address: "1200 Depot Rd, Memphis, TN 38103",
      status_id: String(statusActive),
      dispatcher_id: String(userId),
      mc_number: "MC-874512",
      usdot: "3 100 447",
      truck_count: "14",
      born_date: "2021-06-01",
      onboarding_date: "2024-02-15",
      first_load_date: "2024-03-01",
      pricing_type_id: String(pctLoad),
      percentage: "12.5%",
    }),
    allowed,
  );

  assert.deepEqual(errors, {}, "no validation errors");
  assert.equal(input.legal_name, "Northbound Freight LLC", "trimmed");
  assert.equal(input.email, "dispatch@northbound.com", "lowercased");
  assert.equal(input.mc_number, "874512", "MC unwrapped to digits");
  assert.equal(input.usdot, "3100447", "USDOT spaces stripped");
  assert.equal(input.phone, "(555) 240-1188", "typed formatting preserved");
  assert.equal(input.phone_digits, "5552401188", "digits derived for search");
  assert.equal(input.percentage, 12.5);
  assert.equal(input.truck_count, 14);

  const id = write.createCarrier(input, userId);
  const row = carriers.getCarrier(id)!;
  assert.equal(row.legal_name, "Northbound Freight LLC");
  assert.equal(row.mc_number, "874512");
  assert.equal(row.percentage, 12.5);
  assert.equal(row.dispatcher_name, "Form Tester");
});

test("the same carrier is then found by every documented search term", () => {
  const byName = carriers.listCarriers({ q: "northbound" });
  const byMc = carriers.listCarriers({ q: "874512" });
  const byDot = carriers.listCarriers({ q: "3100447" });
  const byEmail = carriers.listCarriers({ q: "northbound.com" });
  const byAddress = carriers.listCarriers({ q: "Depot Rd" });
  const byOwner = carriers.listCarriers({ q: "Petrov" });
  const byPhoneFormatted = carriers.listCarriers({ q: "(555) 240-1188" });
  const byPhoneDigits = carriers.listCarriers({ q: "5552401188" });

  for (const [label, result] of Object.entries({
    byName, byMc, byDot, byEmail, byAddress, byOwner, byPhoneFormatted, byPhoneDigits,
  })) {
    assert.equal(result.total, 1, `${label} found the carrier`);
  }
});

test("a missing legal name and a bad status are both reported", () => {
  const { errors } = form.parseCarrierForm(
    fd({ legal_name: "   ", status_id: "999999" }),
    allowed,
  );
  assert.equal(errors.legal_name, "Legal name is required.");
  assert.equal(errors.status_id, "Select a valid status.");
});

test("an out-of-order first load date is rejected", () => {
  const { errors } = form.parseCarrierForm(
    fd({
      legal_name: "Backwards Freight",
      status_id: String(statusActive),
      onboarding_date: "2024-05-01",
      first_load_date: "2024-04-01",
    }),
    allowed,
  );
  assert.equal(errors.first_load_date, "First load date cannot be before the onboarding date.");
});

test("a dispatcher id belonging to nobody is rejected", () => {
  const { errors } = form.parseCarrierForm(
    fd({ legal_name: "Ghost Assign", status_id: String(statusActive), dispatcher_id: "424242" }),
    allowed,
  );
  assert.equal(errors.dispatcher_id, "Select a valid dispatcher.");
});

test("failed submissions are echoed back so nothing is retyped", () => {
  const values = form.echoValues(
    fd({ legal_name: "Half Typed LLC", mc_number: "abc", email: "", note: "call back" }),
  );
  assert.equal(values.legal_name, "Half Typed LLC");
  assert.equal(values.mc_number, "abc", "the invalid value comes back for correction");
  assert.equal(values.note, "call back");
  assert.ok(!("email" in values), "blank fields are omitted");
});

test("an edit that only touches one field leaves the rest of the record intact", () => {
  const { input } = form.parseCarrierForm(
    fd({
      legal_name: "Edit Target LLC",
      status_id: String(statusActive),
      mc_number: "551122",
      owner_name: "Original Owner",
      truck_count: "9",
    }),
    allowed,
  );
  const id = write.createCarrier(input, userId);

  write.updateCarrier(id, { truck_count: 11 }, userId);

  const row = carriers.getCarrier(id)!;
  assert.equal(row.truck_count, 11);
  assert.equal(row.owner_name, "Original Owner");
  assert.equal(row.mc_number, "551122");
  assert.equal(row.legal_name, "Edit Target LLC");
});
