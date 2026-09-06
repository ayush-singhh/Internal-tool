# Stripe Billing (Phase A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the whole Stripe subscription subsystem — trial, Checkout, Customer Portal, webhook, `/subscription` — and attach it to nothing, so the running application behaves exactly as it does today.

**Architecture:** Stripe is the source of truth and we mirror its subscription status into `organizations` on webhook. A pure `entitlement()` function turns those columns into an access decision that nothing yet consults. The Stripe client is hand-rolled REST over `fetch` in the shape of `src/lib/s3.ts`, so no dependency is added.

**Tech Stack:** Next.js 16 App Router, React 19 Server Components, `node:sqlite`, `node:crypto`, `node:test`. No new runtime dependencies — this is a hard constraint, see below.

**Spec:** `docs/superpowers/specs/2026-09-06-stripe-billing-design.md`

## Global Constraints

Copied from `AI Rules.md` and the spec. Every task's requirements implicitly include these.

- **No new runtime dependencies.** The stack is `next` + `react` + `react-dom` and nothing else. No `stripe` npm package. Use `fetch`, `URLSearchParams`, `node:crypto`.
- **All SQL uses bound parameters.** No string interpolation into SQL, ever, including `ORDER BY`.
- **Re-check permission inside every Server Action.** Hiding a button is presentation, never the security boundary.
- **Write logic goes in a plain module; the Server Action is a thin auth wrapper.** `notes.ts` / `note-actions.ts` is the reference pair.
- **Schema changes are migrations only.** Never edit a shipped migration. Never renumber. Assume real customer data.
- **`src/app/api/` is reserved for file downloads** — the webhook is one documented exception and says so in a comment.
- **Tests never touch `data/carrier-hub.db`.** Set `CARRIER_DB_PATH` to a temp file *before* importing anything, which means `await import(...)` inside `before()`.
- **Run tests with** `npm test` (which is `node --conditions=react-server --test "tests/*.test.ts"`). A single file: `node --conditions=react-server --test tests/<name>.test.ts`.
- **Nothing in this plan enforces anything.** No change to `requireOrg()`, to `run()`/`exec()`, to `signup.ts`, to `nav.ts`, or to `instrumentation.ts`. If a task tempts you to add a gate, it belongs to Phase B and is out of scope.
- **Amounts appear in no file.** Prices live in the Stripe dashboard and are fetched.
- Trial length: **14 days**. Dormancy after lapse: **30 days**. Webhook timestamp tolerance: **300 seconds**.

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `src/lib/stripe.ts` | Transport only. Form encoding, Bearer auth, signature verification, four API calls. No business logic, no database. |
| `src/lib/entitlement.ts` | One pure function: billing columns + clock → access decision. No I/O. |
| `src/lib/subscription.ts` | The tenant-facing half: read the billing row, mirror a Stripe subscription into it, dedupe events, handle a webhook request, build Checkout and Portal URLs. |
| `src/lib/subscription-actions.ts` | `"use server"` wrappers over the two things a person can do. Auth checks live here. |
| `src/app/(app)/subscription/page.tsx` | The page. Reads `entitlement()`, renders two plan cards, one button. |
| `src/app/api/stripe/webhook/route.ts` | Three lines of glue. All logic is in `subscription.ts` so it is testable without HTTP. |
| `tests/billing-schema.test.ts` | Migration 24: columns, grandfathering, the events table. |
| `tests/stripe.test.ts` | Form encoding, signature verification, the four calls against a stub fetcher. |
| `tests/entitlement.test.ts` | Every row of the spec's section 5 table. |
| `tests/subscription.test.ts` | Mirroring, idempotency, out-of-order delivery, the webhook request. |

**Modified — exactly three source files, and no others:**

| File | Change |
|---|---|
| `src/lib/migrations.ts` | Append migration 24. |
| `src/lib/db.ts:45` | `seed()` inserts the bootstrap org as `billing_mode = 'comped'`. |
| `scripts/set-billing-status.ts` | Accept `comped` / `stripe`, writing `billing_mode`. |

Plus `Plan.md` and `DEPLOY.md` in Task 8, which are documentation.

---

### Task 1: Migration 24 — the schema, and grandfathering the live tenant

**Files:**
- Modify: `src/lib/migrations.ts` (append to the `MIGRATIONS` array, after the version 23 entry ending at line ~1027)
- Modify: `src/lib/db.ts:45` (the `seed()` organisation insert)
- Modify: `scripts/set-billing-status.ts`
- Test: `tests/billing-schema.test.ts` (create)

**Interfaces:**
- Consumes: `addColumn(db, table, column, ddl)` and `MIGRATIONS`, both already exported from `migrations.ts`.
- Produces: `organizations` gains `stripe_customer_id`, `stripe_subscription_id`, `plan`, `trial_ends_at`, `current_period_end`, `billing_mode`; new table `stripe_events (id, type, received_at)`. `LATEST_VERSION` becomes 24 on its own — it is `Math.max` over the array.

- [ ] **Step 1: Write the failing test**

Create `tests/billing-schema.test.ts`:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Raw DatabaseSync rather than db.ts: this is about what the migration does to a
// database, so nothing may seed or connect on our behalf.
const paths: string[] = [];
const fresh = (label: string) => {
  const p = path.join(tmpdir(), `carrier-hub-billing-${label}-${process.pid}.db`);
  for (const s of ["", "-wal", "-shm"]) rmSync(`${p}${s}`, { force: true });
  paths.push(p);
  return new DatabaseSync(p);
};

let m: typeof import("../src/lib/migrations.ts");
before(async () => { m = await import("../src/lib/migrations.ts"); });
after(() => {
  for (const p of paths) for (const s of ["", "-wal", "-shm"]) rmSync(`${p}${s}`, { force: true });
});

const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

/** Migrates to `version` and no further — an older deployment on the morning of an upgrade. */
function upTo(db: DatabaseSync, version: number): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  for (const migration of m.MIGRATIONS.filter((x) => x.version <= version)) {
    migration.up(db);
    db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)")
      .run(migration.version, migration.name, new Date().toISOString());
  }
}

const addOrg = (db: DatabaseSync, name: string) =>
  db.prepare(
    "INSERT INTO organizations (name, slug, status, created_at) VALUES (?, ?, 'active', ?)",
  ).run(name, name.toLowerCase().replace(/\W+/g, "-"), new Date().toISOString());

const modeOf = (db: DatabaseSync, name: string) =>
  (db.prepare("SELECT billing_mode FROM organizations WHERE name = ?").get(name) as
    { billing_mode: string }).billing_mode;

test("migration 24 adds the billing columns and the event ledger", () => {
  const db = fresh("columns");
  m.migrate(db);
  for (const c of [
    "stripe_customer_id", "stripe_subscription_id", "plan",
    "trial_ends_at", "current_period_end", "billing_mode",
  ]) {
    assert.ok(columns(db, "organizations").includes(c), `organizations.${c} exists`);
  }
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as
    { name: string }[]).map((r) => r.name);
  assert.ok(tables.includes("stripe_events"));
  db.close();
});

test("every organisation that predates billing is comped, and keeps working", () => {
  const db = fresh("grandfather");
  upTo(db, 23);
  addOrg(db, "Live Tenant");
  addOrg(db, "Bootstrap Admin");

  const { applied } = m.migrate(db);
  assert.equal(applied.length, 1, "only migration 24 was pending");
  assert.equal(modeOf(db, "Live Tenant"), "comped");
  assert.equal(modeOf(db, "Bootstrap Admin"), "comped");
  db.close();
});

test("an organisation created after migration 24 is billable by default", () => {
  const db = fresh("default");
  m.migrate(db);
  addOrg(db, "New Signup");
  // Fails closed: a future code path that forgets to say lands in the paying lane
  // rather than becoming free forever.
  assert.equal(modeOf(db, "New Signup"), "stripe");
  db.close();
});

test("re-running the migration does not re-comp a paying organisation", () => {
  const db = fresh("rerun");
  m.migrate(db);
  addOrg(db, "Paying");
  // Simulate a re-application, which the ledger normally prevents: the backfill must be
  // guarded by whether the column was actually just added, not run unconditionally.
  m.MIGRATIONS.find((x) => x.version === 24)!.up(db);
  assert.equal(modeOf(db, "Paying"), "stripe");
  db.close();
});

test("the event ledger refuses a duplicate delivery", () => {
  const db = fresh("events");
  m.migrate(db);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)",
  );
  assert.equal(Number(insert.run("evt_1", "x", "2026-09-06").changes), 1);
  assert.equal(Number(insert.run("evt_1", "x", "2026-09-06").changes), 0, "second delivery is a no-op");
  db.close();
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --conditions=react-server --test tests/billing-schema.test.ts`
Expected: FAIL — `organizations.stripe_customer_id exists` is false, and `stripe_events` is not in `sqlite_master`.

- [ ] **Step 3: Append migration 24**

In `src/lib/migrations.ts`, immediately after the version 23 object and before the `];` that closes `MIGRATIONS`:

```ts
  {
    version: 24,
    name: "billing: Stripe columns on organizations, and the event ledger",
    up: (db) => {
      addColumn(db, "organizations", "stripe_customer_id", "TEXT");
      addColumn(db, "organizations", "stripe_subscription_id", "TEXT");
      addColumn(db, "organizations", "plan", "TEXT");
      addColumn(db, "organizations", "trial_ends_at", "TEXT");
      addColumn(db, "organizations", "current_period_end", "TEXT");

      // The default and the backfill below point in opposite directions on purpose.
      // 'stripe' is the DEFAULT so that an organisation created by some future path that
      // forgets to say fails *into* the paying lane rather than becoming free forever.
      // The one-time UPDATE then grandfathers everything that exists at this instant —
      // the live tenant, the bootstrap admin org, every test fixture — because none of
      // them was ever sold to anybody. A comped organisation never talks to Stripe.
      const had = (db.prepare("PRAGMA table_info(organizations)").all() as { name: string }[])
        .some((c) => c.name === "billing_mode");
      addColumn(db, "organizations", "billing_mode", "TEXT NOT NULL DEFAULT 'stripe'");
      // Guarded on the column having just appeared. Unguarded, a second application of
      // this migration would silently hand free service to every paying customer.
      if (!had) db.exec("UPDATE organizations SET billing_mode = 'comped'");

      // Stripe delivers at least once and in no guaranteed order. The primary key here
      // is the entire deduplication mechanism.
      db.exec(`
        CREATE TABLE IF NOT EXISTS stripe_events (
          id          TEXT PRIMARY KEY,
          type        TEXT NOT NULL,
          received_at TEXT NOT NULL
        )`);
    },
  },
```

- [ ] **Step 4: Make the first-run bootstrap comped**

In `src/lib/db.ts`, in `seed()`, change the organisation insert (currently at line 45):

```ts
  // 'comped': whoever self-hosts this and bootstraps their own organisation is not a
  // Stripe customer of ours, and neither is the admin org of our own deployment.
  database.prepare(
    "INSERT INTO organizations (name, slug, status, billing_mode, created_at) VALUES (?, ?, 'active', 'comped', ?)",
  ).run(orgName, slug, now);
```

- [ ] **Step 5: Teach the manual override about billing mode**

In `scripts/set-billing-status.ts`: extend the doc comment's usage line to
`status is one of: trial, active, past_due, suspended, comped, stripe`, then replace the
validation and update block with:

```ts
const allowed = new Set<string>(Object.values(ORG_STATUS));
// `comped` and `stripe` are not statuses — they are the billing *mode*, the column that
// decides whether an organisation is billed at all. Both are billing standing, which is
// this script's stated job, so they live here rather than in a second script.
const MODES = new Set(["comped", "stripe"]);
if (!allowed.has(newStatus) && !MODES.has(newStatus)) {
  console.error(
    `Unknown value "${newStatus}". Use a status (${[...allowed].join(", ")}) ` +
      `or a billing mode (${[...MODES].join(", ")}).`,
  );
  process.exit(1);
}

const org = systemQuery(() =>
  get<{ id: number; name: string; status: string; billing_mode: string }>(
    /^\d+$/.test(orgRef)
      ? "SELECT id, name, status, billing_mode FROM organizations WHERE id = ?"
      : "SELECT id, name, status, billing_mode FROM organizations WHERE slug = ?",
    [/^\d+$/.test(orgRef) ? Number(orgRef) : orgRef],
  ),
);
if (!org) {
  console.error(`No organisation matches "${orgRef}".`);
  process.exit(1);
}

if (MODES.has(newStatus)) {
  systemQuery(() => run("UPDATE organizations SET billing_mode = ? WHERE id = ?", [newStatus, org.id]));
  console.log(`${org.name}: billing mode ${org.billing_mode} -> ${newStatus}`);
} else {
  systemQuery(() => run("UPDATE organizations SET status = ? WHERE id = ?", [newStatus, org.id]));
  console.log(`${org.name}: ${org.status} -> ${newStatus}`);
}
```

- [ ] **Step 6: Run the tests and make sure they pass**

Run: `node --conditions=react-server --test tests/billing-schema.test.ts`
Expected: PASS, 5 tests.

Then the whole suite, because migration 23→24 moves `LATEST_VERSION` and `migrations.test.ts` asserts on it:
Run: `npm test`
Expected: PASS. If `migrations.test.ts` fails on a hard-coded version number, that is the one legitimate edit to it — it asserts `m.LATEST_VERSION`, which is derived, so it should not.

- [ ] **Step 7: Commit**

```bash
git add src/lib/migrations.ts
git add src/lib/db.ts
git add scripts/set-billing-status.ts
git add tests/billing-schema.test.ts
git commit -m "Migration 24: billing columns, and grandfather every existing tenant"
```

---

### Task 2: `stripe.ts` — form encoding and signature verification

The two pure pieces first, because they need no network and no key. Nothing else in the file yet.

**Files:**
- Create: `src/lib/stripe.ts`
- Test: `tests/stripe.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `form(value: unknown, prefix?: string): string[][]`
  - `verifySignature(rawBody: string, header: string | null, secret: string, now?: Date): { ok: true } | { ok: false; reason: string }`

- [ ] **Step 1: Write the failing test**

Create `tests/stripe.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { form, verifySignature } from "../src/lib/stripe.ts";

const encoded = (value: unknown) =>
  new URLSearchParams(form(value) as [string, string][]).toString();

test("nested objects and arrays flatten to Stripe's bracket notation", () => {
  assert.equal(
    encoded({
      mode: "subscription",
      line_items: [{ price: "price_123", quantity: 1 }],
      subscription_data: { trial_period_days: 14 },
    }),
    "mode=subscription" +
      "&line_items%5B0%5D%5Bprice%5D=price_123" +
      "&line_items%5B0%5D%5Bquantity%5D=1" +
      "&subscription_data%5Btrial_period_days%5D=14",
  );
});

test("null and undefined are dropped rather than sent as those words", () => {
  // Stripe reads the literal string "null" as a value, so a dropped key and a null key
  // are very different requests.
  assert.deepEqual(form({ customer: null, customer_email: "a@b.com", trial: undefined }), [
    ["customer_email", "a@b.com"],
  ]);
});

test("booleans and numbers survive as Stripe spells them", () => {
  assert.equal(encoded({ allow_promotion_codes: true, quantity: 1 }),
    "allow_promotion_codes=true&quantity=1");
});

const SECRET = "whsec_a_test_endpoint_secret";
const at = (now: Date) => Math.floor(now.getTime() / 1000);
const sign = (body: string, seconds: number, secret = SECRET) =>
  `t=${seconds},v1=${createHmac("sha256", secret).update(`${seconds}.${body}`, "utf8").digest("hex")}`;

const BODY = '{"id":"evt_1","type":"customer.subscription.updated"}';

test("a signature Stripe would have produced is accepted", () => {
  const now = new Date();
  assert.deepEqual(verifySignature(BODY, sign(BODY, at(now)), SECRET, now), { ok: true });
});

test("a signature over different bytes is refused", () => {
  const now = new Date();
  const verdict = verifySignature('{"id":"evt_2"}', sign(BODY, at(now)), SECRET, now);
  assert.equal(verdict.ok, false);
});

test("a signature from the wrong secret is refused", () => {
  const now = new Date();
  const verdict = verifySignature(BODY, sign(BODY, at(now), "whsec_someone_elses"), SECRET, now);
  assert.equal(verdict.ok, false);
});

test("a timestamp outside the five-minute tolerance is refused, so a capture cannot be replayed", () => {
  const now = new Date();
  const hourAgo = at(now) - 3600;
  const verdict = verifySignature(BODY, sign(BODY, hourAgo), SECRET, now);
  assert.equal(verdict.ok, false);
  assert.match((verdict as { reason: string }).reason, /tolerance/i);
});

test("a missing or malformed header is refused rather than throwing", () => {
  const now = new Date();
  assert.equal(verifySignature(BODY, null, SECRET, now).ok, false);
  assert.equal(verifySignature(BODY, "nonsense", SECRET, now).ok, false);
  assert.equal(verifySignature(BODY, "t=abc,v1=deadbeef", SECRET, now).ok, false);
});

test("one matching v1 among several is enough, which is how a secret is rotated", () => {
  const now = new Date();
  const good = sign(BODY, at(now));
  const stale = createHmac("sha256", "whsec_old").update(`${at(now)}.${BODY}`, "utf8").digest("hex");
  assert.deepEqual(verifySignature(BODY, `${good},v1=${stale}`, SECRET, now), { ok: true });
});

test("a v1 of the wrong length is refused without throwing on the length compare", () => {
  const now = new Date();
  assert.equal(verifySignature(BODY, `t=${at(now)},v1=short`, SECRET, now).ok, false);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --conditions=react-server --test tests/stripe.test.ts`
Expected: FAIL — cannot find module `../src/lib/stripe.ts`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/lib/stripe.ts`:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Just enough of Stripe's REST API to sell a subscription.
 *
 * ponytail: ~120 lines of `fetch` and `node:crypto` rather than the `stripe` package,
 * which is several megabytes to make four calls. The same reasoning as `s3.ts`: the
 * protocol is documented, frozen and testable, so this is checked rather than hoped at.
 *
 * Transport only. Nothing here knows what a trial or an organisation is.
 */

/**
 * Stripe's form encoding: nested objects and arrays become bracketed keys, so
 * `{ line_items: [{ price: "p" }] }` is `line_items[0][price]=p`.
 *
 * Null and undefined are dropped rather than stringified — Stripe reads the literal
 * "null" as a value, so sending it is a different request from omitting the key.
 */
export function form(value: unknown, prefix = ""): string[][] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((v, i) => form(v, `${prefix}[${i}]`));
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      form(v, prefix ? `${prefix}[${k}]` : k),
    );
  }
  return [[prefix, String(value)]];
}

/** Stripe's own default. Outside it, a captured request is refused rather than replayed. */
const TOLERANCE_SECONDS = 300;

/**
 * Verifies a `Stripe-Signature` header against the raw request body.
 *
 * The body must be the bytes Stripe sent — parsing and re-serialising JSON produces a
 * different string and therefore a different HMAC, which is the classic way this check
 * is written so that it never passes.
 *
 * Returns a verdict rather than throwing: the caller turns it into a 400, and a webhook
 * endpoint that throws on malformed input is a webhook endpoint that 500s all day.
 */
export function verifySignature(
  rawBody: string,
  header: string | null,
  secret: string,
  now = new Date(),
): { ok: true } | { ok: false; reason: string } {
  if (!header) return { ok: false, reason: "No Stripe-Signature header." };

  const parts = header.split(",").map((p) => p.trim());
  const timestamp = parts.find((p) => p.startsWith("t="))?.slice(2);
  if (!timestamp || !/^\d+$/.test(timestamp)) {
    return { ok: false, reason: "Malformed Stripe-Signature header." };
  }

  const age = Math.abs(Math.floor(now.getTime() / 1000) - Number(timestamp));
  if (age > TOLERANCE_SECONDS) {
    return { ok: false, reason: "Signature timestamp is outside the tolerance." };
  }

  const expected = Buffer.from(
    createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex"),
    "utf8",
  );
  // Every v1 in the header, not just the first: Stripe sends one per active secret while
  // an endpoint secret is being rotated, and only one of them is ours.
  const matched = parts
    .filter((p) => p.startsWith("v1="))
    .map((p) => Buffer.from(p.slice(3), "utf8"))
    .some((candidate) =>
      candidate.length === expected.length && timingSafeEqual(candidate, expected),
    );

  return matched ? { ok: true } : { ok: false, reason: "Signature does not match." };
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --conditions=react-server --test tests/stripe.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/stripe.ts
git add tests/stripe.test.ts
git commit -m "Stripe transport: form encoding and webhook signature verification"
```

---

### Task 3: `stripe.ts` — the four API calls

**Files:**
- Modify: `src/lib/stripe.ts` (append)
- Test: `tests/stripe.test.ts` (append)

**Interfaces:**
- Consumes: `form()` from Task 2.
- Produces:
  - `type Fetcher = typeof fetch`
  - `type StripeSubscription = { id: string; status: string; customer: string | null; trial_end: number | null; current_period_end?: number | null; items: { data: { price: { id: string }; current_period_end?: number | null }[] } }`
  - `type StripePrice = { id: string; unit_amount: number | null; currency: string; recurring: { interval: string } | null }`
  - `request<T>(method, path, body?, fetcher?): Promise<T>`
  - `getSubscription(id: string, fetcher?): Promise<StripeSubscription>`
  - `getPrice(id: string, fetcher?): Promise<StripePrice>`
  - `createCheckoutSession(input: { priceId, orgId, customerId, customerEmail, trialDays, successUrl, cancelUrl }, fetcher?): Promise<{ id: string; url: string }>`
  - `createPortalSession(customerId: string, returnUrl: string, fetcher?): Promise<{ url: string }>`

Every call takes an optional `fetcher` defaulting to global `fetch`, the way `startSignup` takes a `Mailer`. That is what keeps the tests off the network.

- [ ] **Step 1: Write the failing test**

Append to `tests/stripe.test.ts`:

```ts
import {
  createCheckoutSession, createPortalSession, getPrice, getSubscription,
} from "../src/lib/stripe.ts";

process.env.STRIPE_SECRET_KEY = "sk_test_pretend";

/** A stub `fetch` that records the one request made and replies with `body`. */
function stub(body: unknown, status = 200) {
  const seen: { url: string; method: string; body: string; auth: string }[] = [];
  const fetcher = (async (url: string | URL, init: RequestInit) => {
    seen.push({
      url: String(url),
      method: String(init.method),
      body: String(init.body ?? ""),
      auth: String((init.headers as Record<string, string>).Authorization),
    });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

test("a checkout session carries the trial, the price and the organisation reference", async () => {
  const { fetcher, seen } = stub({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" });
  const session = await createCheckoutSession({
    priceId: "price_monthly", orgId: 7, customerId: null, customerEmail: "owner@acme.com",
    trialDays: 14, successUrl: "https://app/x?checkout=success", cancelUrl: "https://app/x",
  }, fetcher);

  assert.equal(session.url, "https://checkout.stripe.com/c/pay/cs_1");
  assert.equal(seen[0]!.url, "https://api.stripe.com/v1/checkout/sessions");
  assert.equal(seen[0]!.method, "POST");
  assert.equal(seen[0]!.auth, "Bearer sk_test_pretend");
  assert.match(seen[0]!.body, /subscription_data%5Btrial_period_days%5D=14/);
  assert.match(seen[0]!.body, /client_reference_id=7/);
  assert.match(seen[0]!.body, /line_items%5B0%5D%5Bprice%5D=price_monthly/);
  // The card is taken up front — that is the whole shape of the trial we sold.
  assert.match(seen[0]!.body, /payment_method_collection=always/);
  assert.match(seen[0]!.body, /customer_email=owner%40acme\.com/);
});

test("a known customer is reused rather than sent an email address", async () => {
  const { fetcher, seen } = stub({ id: "cs_2", url: "https://checkout.stripe.com/c/pay/cs_2" });
  await createCheckoutSession({
    priceId: "price_monthly", orgId: 7, customerId: "cus_9", customerEmail: "owner@acme.com",
    trialDays: 14, successUrl: "https://app/x", cancelUrl: "https://app/x",
  }, fetcher);
  assert.match(seen[0]!.body, /customer=cus_9/);
  assert.ok(!seen[0]!.body.includes("customer_email"), "no second identity for the same person");
});

test("a portal session is opened for the customer and returns where it came from", async () => {
  const { fetcher, seen } = stub({ url: "https://billing.stripe.com/p/session/x" });
  const session = await createPortalSession("cus_9", "https://app/subscription", fetcher);
  assert.equal(session.url, "https://billing.stripe.com/p/session/x");
  assert.equal(seen[0]!.url, "https://api.stripe.com/v1/billing_portal/sessions");
  assert.match(seen[0]!.body, /customer=cus_9/);
});

test("a subscription is read back by id", async () => {
  const { fetcher, seen } = stub({ id: "sub_1", status: "trialing", customer: "cus_9",
    trial_end: 1789000000, items: { data: [{ price: { id: "price_monthly" } }] } });
  const sub = await getSubscription("sub_1", fetcher);
  assert.equal(sub.status, "trialing");
  assert.equal(seen[0]!.method, "GET");
  assert.equal(seen[0]!.url, "https://api.stripe.com/v1/subscriptions/sub_1");
});

test("a refusal is thrown with Stripe's own words, not a bare status code", async () => {
  const { fetcher } = stub({ error: { message: "No such price: 'price_nope'" } }, 400);
  await assert.rejects(() => getPrice("price_nope", fetcher), /No such price/);
});

test("a refusal that is not JSON still produces a usable error", async () => {
  const fetcher = (async () => new Response("<html>502 Bad Gateway</html>", { status: 502 })) as
    unknown as typeof fetch;
  await assert.rejects(() => getPrice("price_x", fetcher), /502/);
});

test("no secret key is a clear error naming the variable, not a 401 from Stripe", async () => {
  const saved = process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  const { fetcher } = stub({});
  await assert.rejects(() => getPrice("price_x", fetcher), /STRIPE_SECRET_KEY/);
  process.env.STRIPE_SECRET_KEY = saved;
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --conditions=react-server --test tests/stripe.test.ts`
Expected: FAIL — `createCheckoutSession` is not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/lib/stripe.ts`:

```ts
const API = "https://api.stripe.com";

/** Injected so tests never reach the network, the way `startSignup` takes its `Mailer`. */
export type Fetcher = typeof fetch;

function secretKey(): string {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error("STRIPE_SECRET_KEY is not set — this deployment cannot talk to Stripe.");
  }
  return key;
}

export async function request<T>(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
  fetcher: Fetcher = fetch,
): Promise<T> {
  const init: RequestInit = {
    method,
    headers: {
      Authorization: `Bearer ${secretKey()}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  if (body) init.body = new URLSearchParams(form(body) as [string, string][]).toString();

  const response = await fetcher(`${API}${path}`, init);
  const text = await response.text();
  if (!response.ok) {
    // Stripe answers { error: { message } }. A proxy in front of it may answer HTML.
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as { error?: { message?: string } };
      if (parsed.error?.message) detail = parsed.error.message;
    } catch { /* not JSON — the raw text is the best thing we have */ }
    throw new Error(`Stripe ${method} ${path} failed (${response.status}): ${detail}`);
  }
  return JSON.parse(text) as T;
}

export type StripeSubscription = {
  id: string;
  status: string;
  customer: string | null;
  trial_end: number | null;
  /** Present on older API versions. Newer ones carry it per item — read both. */
  current_period_end?: number | null;
  items: { data: { price: { id: string }; current_period_end?: number | null }[] };
};

export type StripePrice = {
  id: string;
  unit_amount: number | null;
  currency: string;
  recurring: { interval: string } | null;
};

export function getSubscription(id: string, fetcher?: Fetcher): Promise<StripeSubscription> {
  return request("GET", `/v1/subscriptions/${encodeURIComponent(id)}`, undefined, fetcher);
}

export function getPrice(id: string, fetcher?: Fetcher): Promise<StripePrice> {
  return request("GET", `/v1/prices/${encodeURIComponent(id)}`, undefined, fetcher);
}

export function createCheckoutSession(
  input: {
    priceId: string;
    orgId: number;
    customerId: string | null;
    customerEmail: string | null;
    trialDays: number;
    successUrl: string;
    cancelUrl: string;
  },
  fetcher?: Fetcher,
): Promise<{ id: string; url: string }> {
  return request("POST", "/v1/checkout/sessions", {
    mode: "subscription",
    line_items: [{ price: input.priceId, quantity: 1 }],
    // How the webhook finds the organisation on the very first event, before any
    // customer id has been stored against it.
    client_reference_id: String(input.orgId),
    // A known customer is reused; a new one is created by Stripe from the address. Never
    // both, or the same person ends up as two customers with two payment histories.
    customer: input.customerId,
    customer_email: input.customerId ? null : input.customerEmail,
    subscription_data: { trial_period_days: input.trialDays },
    // The card is collected now and charged on day 15. Without this Stripe may skip
    // collection on a trialling subscription, which is not the product we sold.
    payment_method_collection: "always",
    allow_promotion_codes: true,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  }, fetcher);
}

export function createPortalSession(
  customerId: string,
  returnUrl: string,
  fetcher?: Fetcher,
): Promise<{ url: string }> {
  return request("POST", "/v1/billing_portal/sessions", {
    customer: customerId,
    return_url: returnUrl,
  }, fetcher);
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --conditions=react-server --test tests/stripe.test.ts`
Expected: PASS, 17 tests (10 from Task 2, 7 new).

- [ ] **Step 5: Commit**

```bash
git add src/lib/stripe.ts
git add tests/stripe.test.ts
git commit -m "Stripe transport: checkout, portal, subscription and price"
```

---

### Task 4: `entitlement()` — the one place the question is answered

**Files:**
- Create: `src/lib/entitlement.ts`
- Test: `tests/entitlement.test.ts` (create)

**Interfaces:**
- Consumes: `ORG_STATUS` from `src/lib/constants.ts`.
- Produces:
  - `type OrgBilling = { status: string; billing_mode: string; plan: string | null; stripe_subscription_id: string | null; trial_ends_at: string | null; current_period_end: string | null }`
  - `type Access = "full" | "read_only" | "none"`
  - `type Entitlement = { access: Access; notice: string | null; until: string | null }`
  - `entitlement(org: OrgBilling, now?: Date): Entitlement`
  - `const DORMANT_AFTER_DAYS = 30`

No `server-only` import and no database: this file must stay pure so its whole truth table is a unit test.

- [ ] **Step 1: Write the failing test**

Create `tests/entitlement.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DORMANT_AFTER_DAYS, entitlement, type OrgBilling } from "../src/lib/entitlement.ts";

const NOW = new Date("2026-09-06T12:00:00.000Z");
const at = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();

const org = (over: Partial<OrgBilling> = {}): OrgBilling => ({
  status: "active",
  billing_mode: "stripe",
  plan: "monthly",
  stripe_subscription_id: "sub_1",
  trial_ends_at: null,
  current_period_end: at(20),
  ...over,
});

test("a comped organisation keeps full access whatever else the row says", () => {
  for (const status of ["trial", "active", "past_due", "suspended", "nonsense"]) {
    const verdict = entitlement(
      org({ billing_mode: "comped", status, stripe_subscription_id: null,
            trial_ends_at: at(-400), current_period_end: at(-400) }),
      NOW,
    );
    assert.equal(verdict.access, "full", `comped + ${status}`);
    assert.equal(verdict.notice, null, "and is not nagged about it");
  }
});

test("an organisation with no subscription is read-only and told what to do", () => {
  const verdict = entitlement(org({ stripe_subscription_id: null }), NOW);
  assert.equal(verdict.access, "read_only");
  assert.match(verdict.notice!, /trial/i);
});

test("an active subscription grants full access even if the period end has passed", () => {
  // Deliberate: a webhook missed on renewal night must not lock out someone who has just
  // paid. A missed webhook fails open for a payer, which is the correct direction.
  const verdict = entitlement(org({ status: "active", current_period_end: at(-3) }), NOW);
  assert.equal(verdict.access, "full");
  assert.equal(verdict.notice, null);
});

test("a failed payment warns but keeps writing, because Stripe is still retrying", () => {
  const verdict = entitlement(org({ status: "past_due" }), NOW);
  assert.equal(verdict.access, "full");
  assert.match(verdict.notice!, /payment/i);
});

test("a live trial counts down", () => {
  const verdict = entitlement(org({ status: "trial", trial_ends_at: at(5) }), NOW);
  assert.equal(verdict.access, "full");
  assert.match(verdict.notice!, /5 days/);
  assert.equal(verdict.until, at(5));
});

test("the last day of a trial says one day, never zero", () => {
  const verdict = entitlement(org({ status: "trial", trial_ends_at: at(0.2) }), NOW);
  assert.match(verdict.notice!, /1 day\b/);
});

test("an ended trial is read-only, not locked", () => {
  const verdict = entitlement(org({ status: "trial", trial_ends_at: at(-1) }), NOW);
  assert.equal(verdict.access, "read_only");
  assert.match(verdict.notice!, /trial has ended/i);
});

test("a trial that ended long ago goes dormant", () => {
  const verdict = entitlement(
    org({ status: "trial", trial_ends_at: at(-DORMANT_AFTER_DAYS - 1) }), NOW);
  assert.equal(verdict.access, "none");
  assert.match(verdict.notice!, /inactive/i);
});

test("a cancelled subscription is read-only for thirty days from its period end", () => {
  const recent = entitlement(org({ status: "suspended", current_period_end: at(-2) }), NOW);
  assert.equal(recent.access, "read_only");
  const old = entitlement(
    org({ status: "suspended", current_period_end: at(-DORMANT_AFTER_DAYS - 1) }), NOW);
  assert.equal(old.access, "none");
});

test("a lapse with no date on it gets read-only and its thirty days, not instant dormancy", () => {
  const verdict = entitlement(org({ status: "suspended", current_period_end: null }), NOW);
  assert.equal(verdict.access, "read_only");
});

test("an unparseable date is treated as no date rather than crashing the page", () => {
  const verdict = entitlement(org({ status: "trial", trial_ends_at: "not a date" }), NOW);
  assert.equal(verdict.access, "read_only");
});

test("a status nobody recognised fails closed", () => {
  const verdict = entitlement(org({ status: "something_new_from_stripe" }), NOW);
  assert.notEqual(verdict.access, "full");
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --conditions=react-server --test tests/entitlement.test.ts`
Expected: FAIL — cannot find module `../src/lib/entitlement.ts`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/lib/entitlement.ts`:

```ts
import { ORG_STATUS } from "./constants.ts";

/**
 * What an organisation is entitled to, from its billing columns and the clock.
 *
 * Pure on purpose: no database, no request context, no network. It is the single answer
 * the gate, the banner and the subscription page all read, which is what stops the three
 * of them from disagreeing about whether somebody has paid — and it means the whole
 * truth table is a unit test rather than a browser session.
 *
 * Nothing consults this yet. Enforcement is Phase B; see the design doc, section 9.
 */
export type OrgBilling = {
  status: string;
  billing_mode: string;
  plan: string | null;
  stripe_subscription_id: string | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
};

export type Access = "full" | "read_only" | "none";

export type Entitlement = {
  access: Access;
  /** Banner text, or null when there is nothing to say. */
  notice: string | null;
  /** What the `access` runs until, for display. Null when nothing is counting down. */
  until: string | null;
};

/** How long a lapsed organisation keeps read access before the account goes dormant. */
export const DORMANT_AFTER_DAYS = 30;
const DAY = 86_400_000;

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function entitlement(org: OrgBilling, now = new Date()): Entitlement {
  // Grandfathered and internal organisations. Never billed, never nagged, never locked.
  if (org.billing_mode === "comped") return { access: "full", notice: null, until: null };

  // Never subscribed. Checked before status because a brand-new organisation's default
  // status is 'active', which would otherwise read as a paid-up account.
  if (!org.stripe_subscription_id) {
    return { access: "read_only", notice: "Start your free trial to begin.", until: null };
  }

  if (org.status === ORG_STATUS.ACTIVE) {
    // No date check, deliberately. Requiring current_period_end to be in the future would
    // lock out a customer whose renewal webhook we missed — failing closed against
    // somebody who has just paid us. The mirrored status is trusted here; the date is
    // display only.
    return { access: "full", notice: null, until: org.current_period_end };
  }

  if (org.status === ORG_STATUS.PAST_DUE) {
    // Stripe's Smart Retries chase a failed card for up to three weeks. Cutting service
    // on the first decline loses customers over an expired card. When Stripe gives up it
    // moves the subscription to canceled or unpaid, we mirror that as suspended, and
    // access degrades below. The grace period is therefore configured once, in Stripe's
    // dunning settings, rather than duplicated as a constant here.
    return {
      access: "full",
      notice: "Your last payment failed. Update your card to avoid losing access.",
      until: org.current_period_end,
    };
  }

  if (org.status === ORG_STATUS.TRIAL) {
    const ends = parseDate(org.trial_ends_at);
    if (ends && ends > now) {
      const days = Math.max(1, Math.ceil((ends.getTime() - now.getTime()) / DAY));
      return {
        access: "full",
        notice: `Your trial ends in ${days} day${days === 1 ? "" : "s"}.`,
        until: org.trial_ends_at,
      };
    }
    // The one place the mirrored status is not trusted: this is the only transition where
    // trusting it fails *open*, into free service, if the webhook never arrives.
    return lapsed(ends, "Your trial has ended.", now);
  }

  // Suspended, and any status Stripe invents that we have not mapped: fail closed.
  return lapsed(parseDate(org.current_period_end), "Your subscription has ended.", now);
}

/** Read-only for thirty days from `since`, then dormant. An unknown `since` counts from
 *  now, so a missing date buys the full thirty days rather than costing them. */
function lapsed(since: Date | null, ended: string, now: Date): Entitlement {
  const dormantAt = new Date((since ?? now).getTime() + DORMANT_AFTER_DAYS * DAY);
  if (now >= dormantAt) {
    return {
      access: "none",
      notice: "This account is inactive. Subscribe to restore access to your data.",
      until: null,
    };
  }
  return {
    access: "read_only",
    notice: `${ended} Subscribe to start writing again.`,
    until: dormantAt.toISOString(),
  };
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --conditions=react-server --test tests/entitlement.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/entitlement.ts
git add tests/entitlement.test.ts
git commit -m "entitlement(): one pure answer to whether a tenant has paid"
```

---

### Task 5: `subscription.ts` — mirroring Stripe into the organisation

**Files:**
- Create: `src/lib/subscription.ts`
- Test: `tests/subscription.test.ts` (create)

**Interfaces:**
- Consumes: `get`, `run`, `systemQuery` from `db.ts`; `ORG_STATUS` from `constants.ts`; `OrgBilling` from `entitlement.ts`; `getSubscription`, `getPrice`, `createCheckoutSession`, `createPortalSession`, `Fetcher`, `StripeSubscription`, `StripePrice` from `stripe.ts`; `appUrl` from `mailer.ts`.
- Produces:
  - `const TRIAL_DAYS = 14`
  - `type OrgBillingRow = OrgBilling & { id: number; name: string; stripe_customer_id: string | null }`
  - `orgBilling(orgId: number): OrgBillingRow`
  - `statusFor(stripeStatus: string): OrgStatus` (`OrgStatus` from `constants.ts`)
  - `planFor(priceId: string | null): string | null`
  - `applySubscription(orgId: number, sub: StripeSubscription): void`
  - `orgIdForCustomer(customerId: string): number | null`
  - `alreadySeen(eventId: string): boolean`
  - `recordEvent(eventId: string, type: string): void`
  - `type StripeEvent = { id: string; type: string; data: { object: Record<string, unknown> } }`
  - `handleEvent(event: StripeEvent, fetcher?: Fetcher): Promise<string>`

- [ ] **Step 1: Write the failing test**

Create `tests/subscription.test.ts`:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// A throwaway database per run — tests never touch data/carrier-hub.db. Set before the
// first import of anything, because db.ts binds CARRIER_DB_PATH when it is first loaded.
const DB = path.join(tmpdir(), `carrier-hub-subscription-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;
process.env.STRIPE_SECRET_KEY = "sk_test_pretend";
process.env.STRIPE_PRICE_MONTHLY = "price_monthly";
process.env.STRIPE_PRICE_YEARLY = "price_yearly";

type Db = typeof import("../src/lib/db.ts");
type Sub = typeof import("../src/lib/subscription.ts");

let db: Db;
let sub: Sub;
let orgId: number;

/** A Stripe subscription object, with the fields the mirror actually reads. */
const stripeSub = (over: Record<string, unknown> = {}) => ({
  id: "sub_1",
  status: "trialing",
  customer: "cus_9",
  trial_end: 1_789_000_000,
  items: { data: [{ price: { id: "price_monthly" }, current_period_end: 1_789_000_000 }] },
  ...over,
});

/** A stub `fetch` that always answers with `body` and counts how often it was asked. */
function stub(body: unknown) {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetcher, calls: () => calls };
}

const event = (type: string, object: Record<string, unknown>, id = `evt_${Math.random()}`) =>
  ({ id, type, data: { object } });

before(async () => {
  db = await import("../src/lib/db.ts");
  sub = await import("../src/lib/subscription.ts");
  orgId = db.get<{ id: number }>("SELECT id FROM organizations LIMIT 1")!.id;
  // The bootstrap org is comped. These tests are about a paying one.
  db.systemQuery(() =>
    db.run("UPDATE organizations SET billing_mode = 'stripe' WHERE id = ?", [orgId]));
});

after(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${DB}${suffix}`, { force: true });
});

test("Stripe's vocabulary maps onto ORG_STATUS, and an unknown word fails closed", () => {
  assert.equal(sub.statusFor("trialing"), "trial");
  assert.equal(sub.statusFor("active"), "active");
  assert.equal(sub.statusFor("past_due"), "past_due");
  assert.equal(sub.statusFor("incomplete"), "past_due");
  assert.equal(sub.statusFor("canceled"), "suspended");
  assert.equal(sub.statusFor("unpaid"), "suspended");
  assert.equal(sub.statusFor("something_stripe_added_last_week"), "suspended");
});

test("a price is named only when it is one of ours", () => {
  assert.equal(sub.planFor("price_monthly"), "monthly");
  assert.equal(sub.planFor("price_yearly"), "yearly");
  assert.equal(sub.planFor("price_from_2019"), null);
  assert.equal(sub.planFor(null), null);
});

test("a checkout completion links the organisation to its subscription", async () => {
  const { fetcher } = stub(stripeSub());
  const outcome = await sub.handleEvent(
    event("checkout.session.completed", {
      subscription: "sub_1", client_reference_id: String(orgId), customer: "cus_9",
    }),
    fetcher,
  );

  const row = sub.orgBilling(orgId);
  assert.equal(row.stripe_subscription_id, "sub_1");
  assert.equal(row.stripe_customer_id, "cus_9");
  assert.equal(row.status, "trial");
  assert.equal(row.plan, "monthly");
  assert.equal(row.trial_ends_at, new Date(1_789_000_000 * 1000).toISOString());
  assert.match(outcome, /trial/);
});

test("the event body is never trusted — the subscription is read back from Stripe", async () => {
  // The event says the customer is fine. Stripe says they are cancelled. Stripe wins,
  // which is what makes out-of-order delivery harmless.
  const { fetcher } = stub(stripeSub({ status: "canceled" }));
  await sub.handleEvent(
    event("customer.subscription.updated", { id: "sub_1", customer: "cus_9", status: "active" }),
    fetcher,
  );
  assert.equal(sub.orgBilling(orgId).status, "suspended");
});

test("a redelivered event does no work the second time", async () => {
  const { fetcher, calls } = stub(stripeSub({ status: "active" }));
  const twice = event("customer.subscription.updated", { id: "sub_1", customer: "cus_9" }, "evt_same");

  const first = await sub.handleEvent(twice, fetcher);
  const second = await sub.handleEvent(twice, fetcher);

  assert.equal(calls(), 1, "Stripe was asked once, not twice");
  assert.match(second, /duplicate/i);
  assert.notMatch(first, /duplicate/i);
  assert.equal(sub.orgBilling(orgId).status, "active");
});

test("an event for a customer we do not know is reported, not thrown", async () => {
  // Throwing would make Stripe retry an event that can never succeed, for days.
  const { fetcher } = stub(stripeSub({ customer: "cus_stranger" }));
  const outcome = await sub.handleEvent(
    event("customer.subscription.updated", { id: "sub_x", customer: "cus_stranger" }),
    fetcher,
  );
  assert.match(outcome, /no organisation/i);
});

test("a comped organisation stays comped even after it subscribes", async () => {
  // The webhook must never be able to start paywalling a grandfathered tenant. Moving an
  // organisation onto billing is a deliberate act, via scripts/set-billing-status.ts.
  db.systemQuery(() =>
    db.run("UPDATE organizations SET billing_mode = 'comped' WHERE id = ?", [orgId]));
  const { fetcher } = stub(stripeSub({ status: "active" }));
  await sub.handleEvent(
    event("customer.subscription.updated", { id: "sub_1", customer: "cus_9" }), fetcher);

  assert.equal(sub.orgBilling(orgId).billing_mode, "comped");
  db.systemQuery(() =>
    db.run("UPDATE organizations SET billing_mode = 'stripe' WHERE id = ?", [orgId]));
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --conditions=react-server --test tests/subscription.test.ts`
Expected: FAIL — cannot find module `../src/lib/subscription.ts`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/lib/subscription.ts`:

```ts
import "server-only";
import { get, run, systemQuery } from "./db.ts";
import { ORG_STATUS, type OrgStatus } from "./constants.ts";
import type { OrgBilling } from "./entitlement.ts";
import {
  createCheckoutSession, createPortalSession, getPrice, getSubscription,
  type Fetcher, type StripePrice, type StripeSubscription,
} from "./stripe.ts";
import { appUrl } from "./mailer.ts";

/** The trial we sell. Stripe holds the card from day one and charges on day 15. */
export const TRIAL_DAYS = 14;

export type OrgBillingRow = OrgBilling & {
  id: number;
  name: string;
  stripe_customer_id: string | null;
};

/**
 * `organizations` is a global table, not a tenant one — it is not in TENANT_TABLES, so
 * the isolation guard does not fire on it. `systemQuery` here is documentation of that
 * fact, the same way scripts/set-billing-status.ts uses it.
 */
export function orgBilling(orgId: number): OrgBillingRow {
  return systemQuery(() =>
    get<OrgBillingRow>(
      `SELECT id, name, status, billing_mode, plan, stripe_customer_id,
              stripe_subscription_id, trial_ends_at, current_period_end
         FROM organizations WHERE id = ?`,
      [orgId],
    ),
  )!;
}

/** The only translation between Stripe's vocabulary and ours. */
const STATUS: Record<string, OrgStatus> = {
  trialing: ORG_STATUS.TRIAL,
  active: ORG_STATUS.ACTIVE,
  past_due: ORG_STATUS.PAST_DUE,
  incomplete: ORG_STATUS.PAST_DUE,
  canceled: ORG_STATUS.SUSPENDED,
  unpaid: ORG_STATUS.SUSPENDED,
  incomplete_expired: ORG_STATUS.SUSPENDED,
  paused: ORG_STATUS.SUSPENDED,
};

/** Anything Stripe adds that we have not mapped is treated as not-paying. Fail closed. */
export function statusFor(stripeStatus: string): OrgStatus {
  return STATUS[stripeStatus] ?? ORG_STATUS.SUSPENDED;
}

/** Null for a price that is neither of ours — an old price still attached to a
 *  long-standing customer. The page says "Custom plan" rather than guessing. */
export function planFor(priceId: string | null): string | null {
  if (!priceId) return null;
  if (priceId === process.env.STRIPE_PRICE_MONTHLY) return "monthly";
  if (priceId === process.env.STRIPE_PRICE_YEARLY) return "yearly";
  return null;
}

const iso = (seconds: number | null | undefined) =>
  typeof seconds === "number" ? new Date(seconds * 1000).toISOString() : null;

/**
 * Mirrors a Stripe subscription onto an organisation. Absolute values, never deltas, so
 * applying the same subscription twice is indistinguishable from applying it once.
 *
 * Deliberately does NOT write `billing_mode`. A comped organisation stays comped whatever
 * Stripe says, so no webhook can ever start paywalling a grandfathered tenant; moving one
 * onto billing is a person running scripts/set-billing-status.ts.
 */
export function applySubscription(orgId: number, sub: StripeSubscription): void {
  const item = sub.items?.data?.[0];
  systemQuery(() =>
    run(
      `UPDATE organizations
          SET status = ?, stripe_customer_id = ?, stripe_subscription_id = ?,
              plan = ?, trial_ends_at = ?, current_period_end = ?
        WHERE id = ?`,
      [
        statusFor(sub.status),
        typeof sub.customer === "string" ? sub.customer : null,
        sub.id,
        planFor(item?.price?.id ?? null),
        iso(sub.trial_end),
        // Newer Stripe API versions moved this onto the subscription item; older ones
        // keep it on the subscription. Read both so an upgrade does not silently null it.
        iso(item?.current_period_end ?? sub.current_period_end),
        orgId,
      ],
    ),
  );
}

export function orgIdForCustomer(customerId: string): number | null {
  return (
    systemQuery(() =>
      get<{ id: number }>("SELECT id FROM organizations WHERE stripe_customer_id = ?", [customerId]),
    )?.id ?? null
  );
}

export function alreadySeen(eventId: string): boolean {
  return systemQuery(() => !!get("SELECT 1 FROM stripe_events WHERE id = ?", [eventId]));
}

export function recordEvent(eventId: string, type: string): void {
  systemQuery(() =>
    run("INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)",
      [eventId, type, new Date().toISOString()]),
  );
}

export type StripeEvent = { id: string; type: string; data: { object: Record<string, unknown> } };

/**
 * Applies one verified event and says what happened, for the log.
 *
 * The event is recorded as handled only after the work succeeds. Recording first would
 * mean a handler that threw — a Stripe timeout, a locked database — swallowed Stripe's
 * retry of the very event it failed on. Applying twice is harmless because
 * `applySubscription` writes absolute values.
 */
export async function handleEvent(event: StripeEvent, fetcher?: Fetcher): Promise<string> {
  if (alreadySeen(event.id)) return `duplicate ${event.id} (${event.type})`;

  const object = event.data.object;
  let subscriptionId: string | null = null;
  let orgId: number | null = null;

  if (event.type === "checkout.session.completed") {
    subscriptionId = typeof object.subscription === "string" ? object.subscription : null;
    // Set when the session was created — the only way to find the organisation before any
    // customer id has been stored against it.
    const reference = object.client_reference_id;
    orgId = typeof reference === "string" && /^\d+$/.test(reference) ? Number(reference) : null;
  } else {
    subscriptionId = typeof object.id === "string" ? object.id : null;
  }
  if (orgId === null && typeof object.customer === "string") {
    orgId = orgIdForCustomer(object.customer);
  }
  if (!subscriptionId) {
    recordEvent(event.id, event.type);
    return `${event.type}: no subscription on the event`;
  }

  // Read the subscription back rather than trusting the event's copy of it. Stripe does
  // not guarantee delivery order, so the event that arrives last is not necessarily the
  // one that happened last; reading the current state makes ordering irrelevant.
  const subscription = await getSubscription(subscriptionId, fetcher);
  if (orgId === null && typeof subscription.customer === "string") {
    orgId = orgIdForCustomer(subscription.customer);
  }
  if (orgId === null) {
    // Recorded and accepted. Returning an error would make Stripe retry an event that can
    // never succeed, for days.
    recordEvent(event.id, event.type);
    return `${event.type}: no organisation for ${subscriptionId}`;
  }

  applySubscription(orgId, subscription);
  recordEvent(event.id, event.type);
  return `${event.type}: organisation ${orgId} -> ${statusFor(subscription.status)}`;
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --conditions=react-server --test tests/subscription.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/subscription.ts
git add tests/subscription.test.ts
git commit -m "Mirror Stripe subscriptions onto the organisation, idempotently"
```

---

### Task 6: The webhook

**Files:**
- Modify: `src/lib/subscription.ts` (append `handleWebhookRequest`)
- Create: `src/app/api/stripe/webhook/route.ts`
- Test: `tests/subscription.test.ts` (append)

**Interfaces:**
- Consumes: `verifySignature` from `stripe.ts`; `handleEvent` from Task 5.
- Produces: `handleWebhookRequest(request: Request, fetcher?: Fetcher): Promise<Response>`

The whole handler lives in `subscription.ts` so it is a plain function a test can call with
a `Request`. The route file is glue with no branches — which also means the tests do not
need Next's `@/` path alias, which `node --test` does not resolve.

- [ ] **Step 1: Write the failing test**

Append to `tests/subscription.test.ts`, putting the new `import` line up with the others
at the top of the file:

```ts
import { createHmac } from "node:crypto";

const WHSEC = "whsec_test_endpoint_secret";
const signed = (body: string, now = new Date()) => {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${createHmac("sha256", WHSEC).update(`${t}.${body}`, "utf8").digest("hex")}`;
};
const post = (body: string, signature: string | null) =>
  new Request("https://app.example.com/api/stripe/webhook", {
    method: "POST",
    body,
    headers: signature ? { "stripe-signature": signature } : {},
  });

test("an unconfigured deployment says so rather than pretending to accept events", async () => {
  const saved = process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  const response = await sub.handleWebhookRequest(post("{}", "t=1,v1=x"));
  assert.equal(response.status, 503);
  if (saved) process.env.STRIPE_WEBHOOK_SECRET = saved;
});

test("an unsigned or wrongly signed request is refused and writes nothing", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
  const before = sub.orgBilling(orgId).status;
  const body = JSON.stringify(
    event("customer.subscription.updated", { id: "sub_1", customer: "cus_9" }, "evt_forged"));

  assert.equal((await sub.handleWebhookRequest(post(body, null))).status, 400);
  assert.equal((await sub.handleWebhookRequest(post(body, "t=1,v1=deadbeef"))).status, 400);
  assert.equal(sub.orgBilling(orgId).status, before, "a refused request changed nothing");
  assert.equal(sub.alreadySeen("evt_forged"), false, "and was not recorded as handled");
});

test("a properly signed event is applied", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
  const { fetcher } = stub(stripeSub({ status: "active" }));
  const body = JSON.stringify(
    event("customer.subscription.updated", { id: "sub_1", customer: "cus_9" }, "evt_signed"));

  const response = await sub.handleWebhookRequest(post(body, signed(body)), fetcher);
  assert.equal(response.status, 200);
  assert.equal(sub.orgBilling(orgId).status, "active");
});

test("a signed body that is not JSON is refused, not crashed on", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
  const body = "not json at all";
  const response = await sub.handleWebhookRequest(post(body, signed(body)));
  assert.equal(response.status, 400);
});

test("a handler failure asks Stripe to retry", async () => {
  process.env.STRIPE_WEBHOOK_SECRET = WHSEC;
  const failing = (async () => { throw new Error("Stripe timed out"); }) as unknown as typeof fetch;
  const body = JSON.stringify(
    event("customer.subscription.updated", { id: "sub_1", customer: "cus_9" }, "evt_boom"));

  const response = await sub.handleWebhookRequest(post(body, signed(body)), failing);
  assert.equal(response.status, 500, "a 500 is what makes Stripe deliver it again");
  assert.equal(sub.alreadySeen("evt_boom"), false, "and it is not marked handled");
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --conditions=react-server --test tests/subscription.test.ts`
Expected: FAIL — `sub.handleWebhookRequest is not a function`.

- [ ] **Step 3: Append the handler**

Add to the imports at the top of `src/lib/subscription.ts`: `verifySignature` from `./stripe.ts`.
Then append:

```ts
/**
 * One verified Stripe delivery, from raw request to response.
 *
 * Lives here rather than in the route file so it is a plain function a test can call with
 * a `Request`, no HTTP server and no build step.
 */
export async function handleWebhookRequest(
  request: Request,
  fetcher?: Fetcher,
): Promise<Response> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return new Response("Billing is not configured here.", { status: 503 });

  // Read the body as text before anything parses it: JSON that has been parsed and
  // re-serialised is different bytes, and therefore a different HMAC.
  const raw = await request.text();
  const verdict = verifySignature(raw, request.headers.get("stripe-signature"), secret);
  if (!verdict.ok) return new Response(verdict.reason, { status: 400 });

  let event: StripeEvent;
  try {
    event = JSON.parse(raw) as StripeEvent;
  } catch {
    return new Response("Body is not JSON.", { status: 400 });
  }
  if (!event?.id || !event?.type || !event?.data?.object) {
    return new Response("Not a Stripe event.", { status: 400 });
  }

  try {
    console.log(`[stripe] ${await handleEvent(event, fetcher)}`);
  } catch (error) {
    // A 500 is the request to deliver it again, which is right for a transient failure.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[stripe] ${event.id} (${event.type}) failed: ${message}`);
    return new Response("Handler failed.", { status: 500 });
  }
  return new Response("ok");
}
```

- [ ] **Step 4: Create the route**

Create `src/app/api/stripe/webhook/route.ts`:

```ts
import { handleWebhookRequest } from "@/lib/subscription";

/**
 * Stripe's webhook.
 *
 * AI Rules §5 reserves `src/app/api/` for file downloads, and this is the one documented
 * exception: a webhook is an unauthenticated POST from somebody else's servers,
 * authenticated by an HMAC over its body — which is precisely what a Server Action is
 * not. The rule's intent is untouched: our own mutations still go through Server Actions.
 *
 * All of the logic is in `subscription.ts`, so this file has nothing to test.
 */
export const POST = (request: Request) => handleWebhookRequest(request);
```

- [ ] **Step 5: Run the tests and make sure they pass**

Run: `node --conditions=react-server --test tests/subscription.test.ts`
Expected: PASS, 12 tests.

Then check the route compiles into the build:
Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/subscription.ts
git add src/app/api/stripe/webhook/route.ts
git add tests/subscription.test.ts
git commit -m "Stripe webhook: verified, deduped, and read back from Stripe"
```

---

### Task 7: `/subscription` — the page and its two actions

**Files:**
- Modify: `src/lib/subscription.ts` (append `planPrices`, `startCheckout`, `openPortal`)
- Create: `src/lib/subscription-actions.ts`
- Create: `src/app/(app)/subscription/page.tsx`
- Test: `tests/subscription.test.ts` (append)

**Interfaces:**
- Consumes: `orgBilling`, `TRIAL_DAYS` (Task 5); `entitlement` (Task 4); `createCheckoutSession`, `createPortalSession`, `getPrice` (Task 3); `requireOrg` from `auth.ts`; `can` from `permissions.ts`; `Card`, `CardHeader`, `PageHeader` from `@/components/ui`.
- Produces:
  - `planPrices(fetcher?): Promise<{ monthly: StripePrice | null; yearly: StripePrice | null; error: string | null }>`
  - `startCheckout(orgId: number, plan: "monthly" | "yearly", email: string, fetcher?): Promise<string>`
  - `openPortal(orgId: number, fetcher?): Promise<string>`
  - Server Actions `startCheckoutAction(formData: FormData)` and `openPortalAction()`

- [ ] **Step 1: Write the failing test**

Append to `tests/subscription.test.ts`:

```ts
test("the page degrades rather than 500s when Stripe cannot be reached", async () => {
  const failing = (async () => { throw new Error("getaddrinfo ENOTFOUND api.stripe.com"); }) as
    unknown as typeof fetch;
  const prices = await sub.planPrices(failing);
  assert.equal(prices.monthly, null);
  assert.equal(prices.yearly, null);
  assert.match(prices.error!, /ENOTFOUND/);
});

test("checkout refuses to guess when a price is not configured", async () => {
  const saved = process.env.STRIPE_PRICE_YEARLY;
  delete process.env.STRIPE_PRICE_YEARLY;
  await assert.rejects(
    () => sub.startCheckout(orgId, "yearly", "owner@acme.com"),
    /STRIPE_PRICE_YEARLY/,
  );
  process.env.STRIPE_PRICE_YEARLY = saved;
});

test("the portal cannot be opened for an organisation Stripe has never met", async () => {
  db.systemQuery(() =>
    db.run("UPDATE organizations SET stripe_customer_id = NULL WHERE id = ?", [orgId]));
  await assert.rejects(() => sub.openPortal(orgId), /no Stripe customer/i);
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `node --conditions=react-server --test tests/subscription.test.ts`
Expected: FAIL — `sub.planPrices is not a function`.

- [ ] **Step 3: Append the three functions**

Append to `src/lib/subscription.ts`:

```ts
/**
 * The two prices, as Stripe currently states them.
 *
 * Fetched rather than configured, so the number on the button and the number on the card
 * statement cannot drift apart — no amount appears anywhere in this codebase. Memoised
 * for ten minutes because the page renders on every request and a price changes about
 * once a year.
 */
const priceCache = new Map<string, { at: number; price: StripePrice }>();
const PRICE_TTL_MS = 10 * 60_000;

async function cachedPrice(id: string | undefined, fetcher?: Fetcher): Promise<StripePrice | null> {
  if (!id) return null;
  const hit = priceCache.get(id);
  if (hit && Date.now() - hit.at < PRICE_TTL_MS) return hit.price;
  const price = await getPrice(id, fetcher);
  priceCache.set(id, { at: Date.now(), price });
  return price;
}

export async function planPrices(fetcher?: Fetcher): Promise<{
  monthly: StripePrice | null;
  yearly: StripePrice | null;
  error: string | null;
}> {
  try {
    const [monthly, yearly] = await Promise.all([
      cachedPrice(process.env.STRIPE_PRICE_MONTHLY, fetcher),
      cachedPrice(process.env.STRIPE_PRICE_YEARLY, fetcher),
    ]);
    return { monthly, yearly, error: null };
  } catch (error) {
    // A Stripe outage must not take the page down with it — somebody arriving here to
    // fix their card still needs the "Manage billing" button to render.
    return { monthly: null, yearly: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Returns the Stripe-hosted URL to send the customer to. */
export async function startCheckout(
  orgId: number,
  plan: "monthly" | "yearly",
  email: string,
  fetcher?: Fetcher,
): Promise<string> {
  const variable = plan === "yearly" ? "STRIPE_PRICE_YEARLY" : "STRIPE_PRICE_MONTHLY";
  const priceId = process.env[variable];
  if (!priceId) throw new Error(`${variable} is not set — no price to subscribe to.`);

  const org = orgBilling(orgId);
  const session = await createCheckoutSession({
    priceId,
    orgId,
    customerId: org.stripe_customer_id,
    customerEmail: org.stripe_customer_id ? null : email,
    trialDays: TRIAL_DAYS,
    // A hint for the page's copy only. Payment is never believed from a query string —
    // only the webhook writes billing state.
    successUrl: `${appUrl()}/subscription?checkout=success`,
    cancelUrl: `${appUrl()}/subscription?checkout=cancelled`,
  }, fetcher);
  return session.url;
}

/** Card changes, plan changes, invoices and cancellation are all Stripe's screens. */
export async function openPortal(orgId: number, fetcher?: Fetcher): Promise<string> {
  const org = orgBilling(orgId);
  if (!org.stripe_customer_id) {
    throw new Error("This organisation has no Stripe customer yet — start a subscription first.");
  }
  const session = await createPortalSession(
    org.stripe_customer_id, `${appUrl()}/subscription`, fetcher);
  return session.url;
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `node --conditions=react-server --test tests/subscription.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Write the Server Actions**

Create `src/lib/subscription-actions.ts`:

```ts
"use server";
import { redirect } from "next/navigation";
import { requireOrg } from "./auth.ts";
import { can } from "./permissions.ts";
import { openPortal, startCheckout } from "./subscription.ts";

/**
 * The thin auth wrapper over `subscription.ts`, in the shape of `note-actions.ts`.
 *
 * Both actions re-check the permission here rather than relying on the page having
 * hidden the button — AI Rules §4, and BUGS.md records what happened the two times a
 * check was left to the UI. `settings:manage` resolves to owner and admin, which is who
 * holds the company card.
 */
export async function startCheckoutAction(formData: FormData): Promise<void> {
  const { user, org } = await requireOrg();
  if (!can(user, "settings:manage")) throw new Error("Not authorized to manage the subscription.");

  const plan = formData.get("plan") === "yearly" ? "yearly" : "monthly";
  // Outside any try/catch: `redirect` works by throwing, so catching here would swallow it.
  redirect(await startCheckout(org.id, plan, user.email));
}

export async function openPortalAction(): Promise<void> {
  const { user, org } = await requireOrg();
  if (!can(user, "settings:manage")) throw new Error("Not authorized to manage the subscription.");
  redirect(await openPortal(org.id));
}
```

- [ ] **Step 6: Write the page**

Create `src/app/(app)/subscription/page.tsx`:

```tsx
import type { Metadata } from "next";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { entitlement } from "@/lib/entitlement";
import { orgBilling, planPrices, TRIAL_DAYS } from "@/lib/subscription";
import { openPortalAction, startCheckoutAction } from "@/lib/subscription-actions";
import { formatDate } from "@/lib/format";
import { Card, CardHeader, PageHeader } from "@/components/ui";
import type { StripePrice } from "@/lib/stripe";

export const metadata: Metadata = { title: "Subscription" };

/** Stripe quotes in minor units. Whole amounts lose the ".00" — nobody writes $499.00. */
function money(price: StripePrice): string {
  if (price.unit_amount === null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: price.currency.toUpperCase(),
    minimumFractionDigits: price.unit_amount % 100 === 0 ? 0 : 2,
  }).format(price.unit_amount / 100);
}

function PlanCard({
  plan, price, label, hint, disabled,
}: {
  plan: "monthly" | "yearly";
  price: StripePrice | null;
  label: string;
  hint: string;
  disabled: boolean;
}) {
  if (!price) return null;
  return (
    <Card>
      <CardHeader title={label} subtitle={hint} />
      <p className="tnum text-2xl font-semibold text-ink-900">
        {money(price)}
        <span className="ml-1 text-sm font-normal text-ink-500">
          /{price.recurring?.interval ?? "period"}
        </span>
      </p>
      <form action={startCheckoutAction} className="mt-4">
        <input type="hidden" name="plan" value={plan} />
        <button
          type="submit"
          disabled={disabled}
          className="w-full rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-medium text-white transition hover:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Start {TRIAL_DAYS}-day free trial
        </button>
      </form>
    </Card>
  );
}

export default async function SubscriptionPage() {
  // Every page under (app) calls this itself. The layout's call is defence in depth,
  // never the boundary: Next renders a layout and its page concurrently, so a layout that
  // refuses does not stop the page running. See the comment on requireSupport in auth.ts.
  const { user, org } = await requireOrg();
  // Viewing is deliberately ungated, so that a dispatcher who finds the application
  // read-only can read what happened and who to ask, rather than meeting a blank 403.
  // Acting is not: both Server Actions re-check this for themselves.
  const mayManage = can(user, "settings:manage");

  const billing = orgBilling(org.id);
  const state = entitlement(billing);
  const prices = await planPrices();
  const subscribed = billing.stripe_subscription_id !== null;

  return (
    <>
      <PageHeader
        title="Subscription"
        subtitle="What this organisation pays for Carrier Hub."
      />

      <div className="space-y-5">
        {state.notice && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-sm font-medium text-amber-800">
            {state.notice}
            {state.until && ` (${formatDate(state.until)})`}
          </p>
        )}

        {billing.billing_mode === "comped" && (
          <Card className="border-dashed">
            <CardHeader
              title="Not billed"
              subtitle="This organisation is not charged for Carrier Hub, and no card is held for it."
            />
          </Card>
        )}

        {prices.error && (
          <p className="rounded-lg border border-line bg-ink-50 px-3.5 py-3 text-sm text-ink-600">
            Prices could not be loaded from Stripe just now. Existing subscriptions are
            unaffected.
          </p>
        )}

        {!subscribed && billing.billing_mode !== "comped" && (
          <section aria-label="Plans" className="grid gap-3 sm:grid-cols-2">
            <PlanCard
              plan="monthly" price={prices.monthly} label="Monthly"
              hint="One price for the whole company, billed every month."
              disabled={!mayManage}
            />
            <PlanCard
              plan="yearly" price={prices.yearly} label="Yearly"
              hint="One price for the whole company, billed once a year."
              disabled={!mayManage}
            />
          </section>
        )}

        {subscribed && (
          <Card>
            <CardHeader
              title={billing.plan ? `${billing.plan[0]!.toUpperCase()}${billing.plan.slice(1)} plan` : "Custom plan"}
              subtitle={
                billing.current_period_end
                  ? `Renews ${formatDate(billing.current_period_end)}.`
                  : "Managed in Stripe."
              }
            />
            <form action={openPortalAction}>
              <button
                type="submit"
                disabled={!mayManage}
                className="rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-sm font-medium text-ink-700 transition hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Manage billing
              </button>
            </form>
            <p className="mt-2 text-xs text-ink-500">
              Cards, plan changes, invoices and cancellation are all handled by Stripe.
            </p>
          </Card>
        )}

        {!mayManage && (
          <p className="text-sm text-ink-500">
            Only an owner or an administrator can change the subscription.
          </p>
        )}
      </div>
    </>
  );
}
```

- [ ] **Step 7: Check it compiles and renders**

Run: `npx tsc --noEmit`
Expected: no errors. `Card` already takes `className`, and `bg-brand-600` /
`hover:bg-brand-700` are already in use on `/loads` — this task modifies no shared component.

Run: `npm run build`
Expected: build succeeds and `/subscription` appears in the route list.

There is no unit test of the page itself: the codebase tests pages through `tests/http/`,
which needs a full build, and the page's logic is `entitlement()` and `planPrices()`, both
already tested. The check that matters here is that the build passes and the two actions
are the only write paths.

- [ ] **Step 8: Verify by hand, against Stripe test mode**

With `STRIPE_SECRET_KEY=sk_test_…`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY` set:

```bash
npm run dev
```

Then, signed in as an owner:
1. Open `/subscription`. It shows two prices matching the Stripe dashboard.
2. Comp status: run `npm run set-billing-status -- <slug> stripe` so the plan cards appear.
3. Click **Start 14-day free trial**, pay with `4242 4242 4242 4242`, any future expiry.
4. Forward the webhook: `stripe listen --forward-to localhost:3000/api/stripe/webhook`,
   and put the `whsec_…` it prints into `STRIPE_WEBHOOK_SECRET`.
5. Reload `/subscription`. It says the trial ends in 14 days; the org row has
   `status='trial'` and a `stripe_subscription_id`.
6. Click **Manage billing** — Stripe's portal opens and returns to `/subscription`.
7. Confirm the rest of the application is completely unaffected: no banner anywhere else,
   no page redirects, every write still works.

- [ ] **Step 9: Commit**

```bash
git add src/lib/subscription.ts
git add src/lib/subscription-actions.ts
git add src/app/\(app\)/subscription/page.tsx
git add tests/subscription.test.ts
git commit -m "The /subscription page: two plans, Checkout, and the Customer Portal"
```

---

### Task 8: Documentation

**Files:**
- Modify: `Plan.md` (add Phase 23)
- Modify: `DEPLOY.md` (the environment table around line 65, and a new Stripe section)

AI Rules §10: finishing a phase means updating `Plan.md` in the same change.

- [ ] **Step 1: Add the phase to `Plan.md`**

Insert before `## Deferred by design`:

```markdown
## Phase 23 — Stripe billing, built and not yet attached ✅ (2026-09-06)

Spec: `docs/superpowers/specs/2026-09-06-stripe-billing-design.md`
Plan: `docs/superpowers/plans/2026-09-06-stripe-billing.md`

- [x] Migration 24: six billing columns on `organizations`, plus `stripe_events`. Every
      organisation that predates it is `comped`; the column defaults to `stripe` so a
      future path that forgets fails into the paying lane
- [x] `src/lib/stripe.ts` — REST over `fetch`, HMAC signature verification from
      `node:crypto`. No dependency added
- [x] `entitlement()` — one pure function, the whole truth table under test
- [x] `/subscription` — two plans priced from Stripe, Checkout with a 14-day trial and the
      card taken up front, Customer Portal for everything after that
- [x] Webhook at `/api/stripe/webhook`: signature verified, replay window enforced,
      deduplicated on event id, and the subscription re-read from Stripe so delivery order
      cannot matter
- [x] Tests: 49 new cases

### Deliberately not attached
**Nothing enforces any of this.** No gate in `requireOrg()`, no read-only write block, no
trial started at signup, no sidebar entry, no boot check. The application behaves exactly
as it did before this phase. Enforcement is Phase B — section 9 of the spec — and is a
separate, small, reviewable change. Billing's two halves have very different risk: the
half that talks to Stripe is fiddly and harmless, and the half that locks people out is
tiny and catastrophic. This phase shipped the first with the second absent.
```

- [ ] **Step 2: Add the variables to `DEPLOY.md`**

Add to the environment table (near `SIGNUP_OPEN`, around line 65):

```markdown
   | `STRIPE_SECRET_KEY` | `sk_live_…` | only needed once you are selling |
   | `STRIPE_WEBHOOK_SECRET` | `whsec_…` | from the webhook endpoint's own page |
   | `STRIPE_PRICE_MONTHLY` | `price_…` | created in the Stripe dashboard |
   | `STRIPE_PRICE_YEARLY` | `price_…` | created in the Stripe dashboard |
```

And a short section after the SMTP one:

```markdown
## Stripe

Nothing in the application is gated on billing yet, so a deployment with none of these
set runs exactly as before — `/subscription` is the only page that needs them, and it
says so rather than failing.

1. In the Stripe dashboard create **one product** with **two recurring prices**, monthly
   and yearly. The amounts live there and in no file.
2. Add a webhook endpoint at `https://<your-host>/api/stripe/webhook`, subscribed to
   `checkout.session.completed`, `customer.subscription.updated` and
   `customer.subscription.deleted`.
3. `fly secrets set STRIPE_SECRET_KEY=… STRIPE_WEBHOOK_SECRET=… STRIPE_PRICE_MONTHLY=… STRIPE_PRICE_YEARLY=…`

Secrets never go in `fly.toml` — it is in git.

Every organisation that existed before migration 24 is `comped`: never charged, never
paywalled. To move one onto billing, or to comp a new one:

```
npm run set-billing-status -- <org-slug> stripe
npm run set-billing-status -- <org-slug> comped
```

Test with `sk_test_…` keys and `stripe listen --forward-to localhost:3000/api/stripe/webhook`
before switching to live keys.
```

- [ ] **Step 3: Run the whole suite one last time**

Run: `npm test`
Expected: PASS — the previous total plus 49.

Run: `npx tsc --noEmit && npm run build`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add Plan.md
git add DEPLOY.md
git commit -m "Phase 23: record the billing subsystem and how to configure it"
```

---

## Definition of done

- `npm test` green, `npx tsc --noEmit` clean, `npm run build` succeeds.
- A trial can be started end to end against Stripe test mode and the webhook writes the
  trial onto the organisation.
- **The application is otherwise unchanged.** Sign in as a user of the live tenant with no
  Stripe keys set at all: every page loads, every write works, no banner appears, and
  `/subscription` says the organisation is not billed. If any of that is false, the phase
  has overreached and the extra change belongs in Phase B.
