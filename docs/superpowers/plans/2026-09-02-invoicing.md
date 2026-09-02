# Invoicing (Asterism → Carrier dispatch fee) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Asterism → Carrier dispatch invoice — the last open item in Phase 15 —
with a data model that leaves room for the (not-built) Carrier → Broker freight invoice.

**Architecture:** Two new small domains on top of the existing dispatch tables: itemized
`load_adjustments` (deductions/extra pay) that redefine a load's Final Load Amount and RPM,
and `invoices` + `invoice_lines` (Asterism's dispatch fee, one or more loads per invoice,
amounts snapshotted at creation). `loads.status` gains one value, `paid`, between `invoiced`
and `closed`. Every read/write follows the `Org`-scoped, composite-FK, fail-closed-guard
pattern already used by `loads`/`drivers`/`brokers`/`load_documents`.

**Tech Stack:** Next.js 16 Server Components + Server Actions, `node:sqlite`, no new
runtime dependency.

**Spec:** `docs/superpowers/specs/2026-09-02-invoicing-design.md` — read it alongside this
plan; it has the *why* behind every schema and permission decision below.

## Global Constraints

- Every new table carries `organization_id` and composite foreign keys, exactly like
  `drivers`/`brokers`/`loads`/`load_documents` (migration 15/16) — see `Architecture.md`
  §Multi-tenancy, the three isolation layers.
- New tables must be added to **both** `TENANT_TABLES` (`src/lib/tenant-db.ts`, the
  fail-closed query guard's source of truth) **and** `OWNED` (`src/lib/tenant-lifecycle.ts`,
  export/delete) in the same task — `tests/tenant-lifecycle.test.ts` fails the build if one
  is added without the other. This is not optional: see `BUGS.md`'s 2026-09-02
  `load_documents` entry for exactly this class of bug shipping once already.
- `loads.status` moves **forward only, one step at a time** — never add a path that walks a
  load status backward. Correcting a mistake is a flag/note, never an un-invoice.
- Money fields are typed `REAL`, validated server-side (positive, finite) before any write —
  never trust a client-supplied amount.
- Write logic lives in a plain module taking an explicit `userId`/`Org`; the Server Action is
  a thin `can()`-checking wrapper that delegates and calls `revalidatePath` — AI Rules §8, the
  `notes.ts`/`note-actions.ts` and `documents.ts`/`document-actions.ts` pattern.
- No new runtime dependency. No API routes for anything but file downloads — mutations are
  Server Actions (AI Rules §5).
- Non-trivial logic leaves one `node --test` file behind (AI Rules §8).

---

### Task 1: Migration 17 — `load_adjustments`, `invoices`, `invoice_lines`, and the `flat_per_load` pricing type

**Files:**
- Modify: `src/lib/constants.ts:181-186` (LOOKUPS — add one pricing_type row)
- Modify: `src/lib/migrations.ts:655-656` (new migration, after version 16)
- Modify: `src/lib/tenant-db.ts:9-24` (`TENANT_TABLES`)
- Modify: `src/lib/tenant-lifecycle.ts:29-33,144-153` (`OWNED`, `deleteOrganization` order)
- Test: `tests/migrations.test.ts`
- Test: `tests/tenant-lifecycle.test.ts`

**Interfaces:**
- Produces: tables `load_adjustments(id, organization_id, load_id, kind, description,
  amount, created_at, created_by)`, `invoices(id, organization_id, invoice_type, carrier_id,
  status, issued_on, paid_on, total_amount, notes, created_at, created_by, updated_at,
  updated_by)`, `invoice_lines(id, organization_id, invoice_id, load_id, final_load_amount,
  fee_basis, fee_rate, amount, created_at)`. A `pricing_type` lookup value `flat_per_load`
  backfilled into every existing organisation.

- [ ] **Step 1: Add the lookup value**

In `src/lib/constants.ts`, in the `LOOKUPS` array, right after the existing
`percentage_per_load` row (around line 181):

```ts
  { kind: "pricing_type", value: "percentage_per_load", label: "Percentage Per Load" },
  { kind: "pricing_type", value: "flat_per_load", label: "Flat Fee Per Load" },
  { kind: "pricing_type", value: "fixed_monthly", label: "Fixed Monthly" },
```

This reaches brand-new organisations automatically (`provision.ts` seeds from `LOOKUPS`).
Existing organisations do not — `seed()` in `db.ts` only seeds the bootstrap org and only
when the database has zero organisations — which is what migration 17 backfills in Step 2.

- [ ] **Step 2: Write the migration**

In `src/lib/migrations.ts`, add a new entry to the `MIGRATIONS` array immediately after the
version-16 block (before the closing `];` at line 656):

```ts
  {
    version: 17,
    name: "invoicing: load adjustments, dispatch invoices, flat-per-load pricing",
    up: (db) => {
      // Existing organisations never re-run provision.ts's seed (seed() in db.ts only
      // seeds the bootstrap org, and only on a database with zero organisations), so a
      // LOOKUPS entry added today only reaches a tenant created after this ships unless
      // it is inserted here too. ON CONFLICT DO NOTHING: a tenant provisioned after the
      // LOOKUPS change but before this migration ran already has the row.
      const orgs = db.prepare("SELECT id FROM organizations").all() as { id: number }[];
      const insertLookup = db.prepare(
        `INSERT INTO lookups (organization_id, kind, value, label, tone, sort)
         VALUES (?, 'pricing_type', 'flat_per_load', 'Flat Fee Per Load', NULL,
           (SELECT COALESCE(MAX(sort), 0) + 1 FROM lookups
             WHERE organization_id = ? AND kind = 'pricing_type'))
         ON CONFLICT (organization_id, kind, value) DO NOTHING`,
      );
      for (const o of orgs) insertLookup.run(o.id, o.id);

      // Itemized deductions/extra pay tied to a load — what Final Load Amount is built
      // from (see loads.ts's finalLoadAmount). Append-only, like load_documents: a
      // detention charge or an approved TONU fee is evidence in a payment dispute, not a
      // value to quietly edit later. No cascade from loads on purpose, matching
      // load_documents (see BUGS.md 2026-09-02) — tenant-lifecycle.ts deletes it
      // explicitly, in order, rather than relying on a cascade a future migration can't
      // retrofit without a table rebuild.
      db.exec(`
        CREATE TABLE IF NOT EXISTS load_adjustments (
          id              INTEGER PRIMARY KEY,
          organization_id INTEGER NOT NULL,
          load_id         INTEGER NOT NULL,
          kind            TEXT NOT NULL,
          description     TEXT NOT NULL,
          amount          REAL NOT NULL,
          created_at      TEXT NOT NULL,
          created_by      INTEGER,
          FOREIGN KEY (organization_id) REFERENCES organizations (id),
          FOREIGN KEY (organization_id, load_id)    REFERENCES loads (organization_id, id),
          FOREIGN KEY (organization_id, created_by) REFERENCES users (organization_id, id)
        )`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_load_adjustments_org ON load_adjustments (organization_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_load_adjustments_load ON load_adjustments (organization_id, load_id)");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_load_adjustments_org_id ON load_adjustments (organization_id, id)");

      // Asterism -> Carrier dispatch invoices today. `invoice_type` leaves room for
      // Carrier -> Broker freight invoices later without a rebuild — the same
      // one-table-many-kinds shape `lookups` already uses in this schema. See the design
      // doc §1: only 'dispatch' is ever inserted by this phase's code.
      db.exec(`
        CREATE TABLE IF NOT EXISTS invoices (
          id              INTEGER PRIMARY KEY,
          organization_id INTEGER NOT NULL,
          invoice_type    TEXT NOT NULL DEFAULT 'dispatch',
          carrier_id      INTEGER NOT NULL,
          status          TEXT NOT NULL DEFAULT 'pending',
          issued_on       TEXT NOT NULL,
          paid_on         TEXT,
          total_amount    REAL NOT NULL,
          notes           TEXT,
          created_at      TEXT NOT NULL,
          created_by      INTEGER,
          updated_at      TEXT NOT NULL,
          updated_by      INTEGER,
          FOREIGN KEY (organization_id) REFERENCES organizations (id),
          FOREIGN KEY (organization_id, carrier_id) REFERENCES carriers (organization_id, id),
          FOREIGN KEY (organization_id, created_by) REFERENCES users    (organization_id, id),
          FOREIGN KEY (organization_id, updated_by) REFERENCES users    (organization_id, id)
        )`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_invoices_org ON invoices (organization_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_invoices_org_carrier ON invoices (organization_id, carrier_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_invoices_org_status ON invoices (organization_id, status)");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_org_id ON invoices (organization_id, id)");

      // One row per included load, amounts snapshotted at creation — an invoice is a
      // historical financial document, so it must not silently reflow if the load's rate
      // or adjustments change later. Cascades from invoices (a line has no existence
      // apart from its invoice, same shape as load_stops cascading from loads); no
      // cascade from loads, same reasoning as load_adjustments above.
      db.exec(`
        CREATE TABLE IF NOT EXISTS invoice_lines (
          id                 INTEGER PRIMARY KEY,
          organization_id    INTEGER NOT NULL,
          invoice_id         INTEGER NOT NULL,
          load_id            INTEGER NOT NULL,
          final_load_amount  REAL NOT NULL,
          fee_basis          TEXT NOT NULL,
          fee_rate           REAL NOT NULL,
          amount             REAL NOT NULL,
          created_at         TEXT NOT NULL,
          FOREIGN KEY (organization_id) REFERENCES organizations (id),
          FOREIGN KEY (organization_id, invoice_id) REFERENCES invoices (organization_id, id) ON DELETE CASCADE,
          FOREIGN KEY (organization_id, load_id)    REFERENCES loads    (organization_id, id),
          UNIQUE (organization_id, invoice_id, load_id)
        )`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_invoice_lines_org ON invoice_lines (organization_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines (organization_id, invoice_id)");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_lines_org_id ON invoice_lines (organization_id, id)");
    },
  },
```

- [ ] **Step 3: Wire the fail-closed query guard**

In `src/lib/tenant-db.ts`, add the three new tables to `TENANT_TABLES` (around line 22,
after `"load_documents"`):

```ts
export const TENANT_TABLES = [
  "carriers",
  "carrier_notes",
  "carrier_activity",
  "offboarding_records",
  "saved_filters",
  "users",
  "lookups",
  "app_settings",
  "audit_log",
  "drivers",
  "brokers",
  "loads",
  "load_stops",
  "load_documents",
  "load_adjustments",
  "invoices",
  "invoice_lines",
] as const;
```

- [ ] **Step 4: Wire export and deletion**

In `src/lib/tenant-lifecycle.ts`, add to `OWNED` (around line 32):

```ts
export const OWNED = [
  "users", "lookups", "app_settings", "carriers", "carrier_notes",
  "carrier_activity", "offboarding_records", "saved_filters", "audit_log",
  "drivers", "brokers", "load_documents", "load_adjustments", "invoices",
  "invoice_lines", "loads", "load_stops",
] as const;
```

In `deleteOrganization`'s transaction (around line 149, the dispatch-deletion block),
delete invoices and load_adjustments before loads — invoice_lines cascades from invoices,
load_adjustments has no cascade (same as load_documents):

```ts
      // Dispatch first, and in this order: invoices before loads (invoice_lines cascades
      // from invoices), load_adjustments and load_documents before loads (neither
      // cascades — same reasoning as the load_documents fix, BUGS.md 2026-09-02), loads
      // references drivers, brokers, carriers and users so they cannot outlive any of
      // them. load_stops cascades from loads.
      del("invoices", "DELETE FROM invoices WHERE organization_id = ?", [orgId]);
      del("load_adjustments", "DELETE FROM load_adjustments WHERE organization_id = ?", [orgId]);
      del("load_documents", "DELETE FROM load_documents WHERE organization_id = ?", [orgId]);
      del("loads", "DELETE FROM loads WHERE organization_id = ?", [orgId]);
```

(Replaces the existing two-line `del("load_documents", ...); del("loads", ...);` block.)

- [ ] **Step 5: Test the backfill**

Add to `tests/migrations.test.ts`, after the existing "single-tenant database" test:

```ts
test("migration 17 backfills flat-per-load pricing into an existing organisation", () => {
  const db = fresh("backfill");
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  const now = new Date().toISOString();
  for (const x of m.MIGRATIONS.filter((x) => x.version <= 16)) {
    x.up(db);
    db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(x.version, x.name, now);
  }
  db.exec(`INSERT INTO organizations (name, slug, status, created_at)
           VALUES ('Existing Co', 'existing-co', 'active', '${now}')`);
  const orgId = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  db.prepare(
    `INSERT INTO lookups (organization_id, kind, value, label, sort)
     VALUES (?, 'pricing_type', 'percentage_per_load', 'Percentage Per Load', 0)`,
  ).run(orgId);

  m.migrate(db);

  const row = db.prepare(
    "SELECT label FROM lookups WHERE organization_id = ? AND kind = 'pricing_type' AND value = 'flat_per_load'",
  ).get(orgId) as { label: string } | undefined;
  assert.ok(row, "the pre-existing organisation gained the new pricing type");
  assert.equal(row!.label, "Flat Fee Per Load");
  db.close();
});
```

Also add `"load_adjustments"`, `"invoices"`, `"invoice_lines"` to the table-existence list
in the `"an empty file becomes a complete database"` test (line ~33).

- [ ] **Step 6: Verify the drift guard passes**

Run: `node --conditions=react-server --test tests/tenant-lifecycle.test.ts tests/migrations.test.ts`

Expected: all pass, including the existing `"every tenant-owned table is exported and
deleted with the tenant"` test — it now iterates the three new tables and finds them in
`OWNED`.

- [ ] **Step 7: Commit**

```bash
git add src/lib/constants.ts src/lib/migrations.ts src/lib/tenant-db.ts src/lib/tenant-lifecycle.ts tests/migrations.test.ts tests/tenant-lifecycle.test.ts
git commit -m "Migration 17: load_adjustments, invoices, invoice_lines; flat-per-load pricing"
```

---

### Task 2: `loads.status` gains `paid`

**Files:**
- Modify: `src/lib/constants.ts:60-101`
- Modify: `src/lib/dispatch-admin.ts:59,128`
- Modify: `src/lib/load-actions.ts:119`
- Modify: `src/app/(app)/loads/[id]/page.tsx:46`
- Test: `tests/loads.test.ts`
- Test: `tests/dispatch-admin.test.ts`

**Interfaces:**
- Produces: `LOAD_STATUS.PAID = "paid"`, positioned between `INVOICED` and `CLOSED` in
  `LOAD_STATUS_ORDER`, so `nextStatuses("invoiced") === ["paid"]` and
  `nextStatuses("paid") === ["closed"]`.

- [ ] **Step 1: Add the status**

In `src/lib/constants.ts`, update the four `LOAD_STATUS*` blocks (lines 60-101):

```ts
export const LOAD_STATUS = {
  CREATED: "created",
  ASSIGNED: "assigned",
  PICKED_UP: "picked_up",
  IN_TRANSIT: "in_transit",
  DELIVERED: "delivered",
  INVOICED: "invoiced",
  PAID: "paid",
  CLOSED: "closed",
} as const;

export type LoadStatus = (typeof LOAD_STATUS)[keyof typeof LOAD_STATUS];

/** The order they may be reached in. Index position is the whole rule. */
export const LOAD_STATUS_ORDER: LoadStatus[] = [
  LOAD_STATUS.CREATED,
  LOAD_STATUS.ASSIGNED,
  LOAD_STATUS.PICKED_UP,
  LOAD_STATUS.IN_TRANSIT,
  LOAD_STATUS.DELIVERED,
  LOAD_STATUS.INVOICED,
  LOAD_STATUS.PAID,
  LOAD_STATUS.CLOSED,
];

export const LOAD_STATUS_LABELS: Record<LoadStatus, string> = {
  created: "Created",
  assigned: "Assigned",
  picked_up: "Picked Up",
  in_transit: "In Transit",
  delivered: "Delivered",
  invoiced: "Invoiced",
  paid: "Paid",
  closed: "Closed",
};

export const LOAD_STATUS_TONE: Record<LoadStatus, Tone> = {
  created: "slate",
  assigned: "blue",
  picked_up: "amber",
  in_transit: "amber",
  delivered: "green",
  invoiced: "purple",
  paid: "green",
  closed: "slate",
};
```

Also add the new invoicing/adjustment vocabularies to `constants.ts` now (same file, right
after the `LOAD_EXCEPTION*` block, ~line 122), since Tasks 4/6/7 need them:

```ts
export const ADJUSTMENT_KIND = { DEDUCTION: "deduction", EXTRA_PAY: "extra_pay" } as const;
export type AdjustmentKind = (typeof ADJUSTMENT_KIND)[keyof typeof ADJUSTMENT_KIND];
export const ADJUSTMENT_KIND_LABELS: Record<AdjustmentKind, string> = {
  deduction: "Deduction",
  extra_pay: "Extra Pay",
};
export const ADJUSTMENT_KIND_TONE: Record<AdjustmentKind, Tone> = {
  deduction: "red",
  extra_pay: "green",
};

export const FEE_BASIS = { PERCENTAGE: "percentage", FLAT: "flat" } as const;
export type FeeBasis = (typeof FEE_BASIS)[keyof typeof FEE_BASIS];

export const INVOICE_STATUS = { PENDING: "pending", PAID: "paid", DISPUTED: "disputed" } as const;
export type InvoiceStatus = (typeof INVOICE_STATUS)[keyof typeof INVOICE_STATUS];
export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  pending: "Pending",
  paid: "Paid",
  disputed: "Disputed",
};
export const INVOICE_STATUS_TONE: Record<InvoiceStatus, Tone> = {
  pending: "amber",
  paid: "green",
  disputed: "red",
};
```

- [ ] **Step 2: Update every "open load" literal**

In `src/lib/dispatch-admin.ts`, both occurrences (lines 59 and 128) of
`NOT IN ('delivered', 'invoiced', 'closed')` become
`NOT IN ('delivered', 'invoiced', 'paid', 'closed')`. (`nav.ts`'s and `loads.ts`'s
`LOAD_STATUS_ORDER.slice(0, indexOf(DELIVERED))` uses need no change — `DELIVERED`'s index
is unaffected by inserting `PAID` after it.)

- [ ] **Step 3: Extend the invoicing-side permission gate**

In `src/lib/load-actions.ts:119`:

```ts
  const invoicing =
    to === LOAD_STATUS.INVOICED || to === LOAD_STATUS.PAID || to === LOAD_STATUS.CLOSED;
```

- [ ] **Step 4: Extend the offered-buttons filter**

In `src/app/(app)/loads/[id]/page.tsx:45-47`:

```ts
  const offered = nextStatuses(load.status).filter((s) =>
    s === LOAD_STATUS.INVOICED || s === LOAD_STATUS.PAID || s === LOAD_STATUS.CLOSED
      ? mayClose
      : mayManage,
  );
```

- [ ] **Step 5: Write the tests**

Add to `tests/loads.test.ts`:

```ts
test("paid sits between invoiced and closed, forward only", () => {
  assert.deepEqual(write.nextStatuses(C.LOAD_STATUS.INVOICED), [C.LOAD_STATUS.PAID]);
  assert.deepEqual(write.nextStatuses(C.LOAD_STATUS.PAID), [C.LOAD_STATUS.CLOSED]);
});
```

(Use whichever of `nextStatuses`/`loads`/`write` this test file already imports it under —
`nextStatuses` lives in `src/lib/loads.ts`, per the existing import block.)

Add to `tests/dispatch-admin.test.ts` (mirroring an existing open-loads case): create a
load, move it through to `paid` via `write.setStatus`, and assert it no longer counts in
`listDrivers(...)[i].open_loads` / `openLoadsByDriver(...)`.

- [ ] **Step 6: Run and commit**

```bash
node --conditions=react-server --test tests/loads.test.ts tests/dispatch-admin.test.ts
git add src/lib/constants.ts src/lib/dispatch-admin.ts src/lib/load-actions.ts "src/app/(app)/loads/[id]/page.tsx" tests/loads.test.ts tests/dispatch-admin.test.ts
git commit -m "Add Paid to the load status flow, between Invoiced and Closed"
```

---

### Task 3: `loads.ts` — Final Load Amount and the RPM redefinition

**Files:**
- Modify: `src/lib/loads.ts` (imports, `LoadRow`, `SELECT`, `rpm`)
- Test: `tests/loads.test.ts`

**Interfaces:**
- Consumes: `load_adjustments` table (Task 1). `LOAD_EXCEPTION` from `constants.ts`
  (already exists).
- Produces: `LoadRow.adjustments_net: number`; `finalLoadAmount(load): number | null`;
  `rpm(load)` redefined to divide by `finalLoadAmount` instead of `rate`.

- [ ] **Step 1: Widen the import**

`src/lib/loads.ts:4-7` currently:

```ts
import {
  LOAD_STATUS, LOAD_STATUS_ORDER, STOP_KIND,
  type LoadStatus, type LoadException, type StopKind,
} from "./constants.ts";
```

becomes:

```ts
import {
  LOAD_EXCEPTION, LOAD_STATUS, LOAD_STATUS_ORDER, STOP_KIND,
  type LoadStatus, type LoadException, type StopKind,
} from "./constants.ts";
```

- [ ] **Step 2: Add the column to `LoadRow`**

In the `LoadRow` type (line ~47, right after `delivery_count: number;`):

```ts
  pickup_count: number;
  delivery_count: number;
  /** Sum of extra_pay minus deduction adjustments on this load. See `finalLoadAmount`. */
  adjustments_net: number;
```

- [ ] **Step 3: Add the subquery to `SELECT`**

In the `SELECT` constant (line ~118-140), right after the `delivery_count` subquery, add a
trailing comma to that line and this new column:

```ts
         (SELECT COUNT(*) FROM load_stops s
           WHERE s.organization_id = l.organization_id AND s.load_id = l.id AND s.kind = 'delivery') AS delivery_count,
         (SELECT COALESCE(SUM(CASE WHEN a.kind = 'extra_pay' THEN a.amount
                                    WHEN a.kind = 'deduction' THEN -a.amount END), 0)
            FROM load_adjustments a
           WHERE a.organization_id = l.organization_id AND a.load_id = l.id) AS adjustments_net
    FROM loads l
```

- [ ] **Step 4: Replace `rpm` with `finalLoadAmount` + redefined `rpm`**

Replace the existing `rpm` function (lines 63-86) with:

```ts
/**
 * The dollar amount this load is actually worth to bill, after approved deductions and
 * extra pay — the Final Load Amount the carrier agreement and the dispatch fee are both
 * based on. A TONU or cancelled load never bills its linehaul automatically; only an
 * explicitly approved adjustment counts, because the load was never run as agreed.
 * `null` when there is nothing to bill at all yet — no rate and no adjustment.
 */
export function finalLoadAmount(
  load: Pick<LoadRow, "rate" | "exception" | "adjustments_net">,
): number | null {
  const net = load.adjustments_net ?? 0;
  const linehaul =
    load.exception === LOAD_EXCEPTION.TONU || load.exception === LOAD_EXCEPTION.CANCELLED
      ? null
      : load.rate;
  if (linehaul === null && net === 0) return null;
  return (linehaul ?? 0) + net;
}

/**
 * Rate per mile, both ways, off the Final Load Amount rather than the raw rate — RPM is
 * an analytics figure, and Final Load Amount (after approved deductions/extra pay) is
 * what the load actually earned. See `finalLoadAmount`.
 *
 *   Loaded  = Final Load Amount ÷ loaded miles               — what the freight itself paid
 *   Total   = Final Load Amount ÷ (deadhead + loaded)         — what the truck actually earned
 *
 * Returns null rather than Infinity or NaN when the divisor is missing or zero, or when
 * there is nothing to bill at all: a load with no miles, or no billable amount, has no
 * rate per mile, and "∞/mi" on a dispatch board is worse than an empty cell. **Never shown
 * to a driver** — that is a permission decision made by the caller, but it is the reason
 * this is computed rather than stored.
 */
export function rpm(
  load: Pick<LoadRow, "rate" | "loaded_miles" | "deadhead_miles" | "exception" | "adjustments_net">,
): { loaded: number | null; total: number | null } {
  const amount = finalLoadAmount(load);
  if (amount === null) return { loaded: null, total: null };
  const loadedMiles = load.loaded_miles ?? 0;
  const totalMiles = loadedMiles + (load.deadhead_miles ?? 0);
  return {
    loaded: loadedMiles > 0 ? amount / loadedMiles : null,
    total: totalMiles > 0 ? amount / totalMiles : null,
  };
}
```

- [ ] **Step 5: Write the tests**

Add to `tests/loads.test.ts` (insert adjustment rows directly with `db.run`, matching how
this file already seeds fixtures):

```ts
test("finalLoadAmount and rpm: the ordinary case is unchanged", () => {
  const load = { rate: 1000, exception: null, adjustments_net: 0, loaded_miles: 500, deadhead_miles: 100 };
  assert.equal(loads.finalLoadAmount(load), 1000);
  assert.equal(loads.rpm(load).loaded, 2);
  assert.equal(loads.rpm(load).total, 1000 / 600);
});

test("finalLoadAmount adds extra pay and subtracts deductions", () => {
  assert.equal(loads.finalLoadAmount({ rate: 3650, exception: null, adjustments_net: 270 }), 3920);
  assert.equal(loads.finalLoadAmount({ rate: 3650, exception: null, adjustments_net: -200 }), 3450);
});

test("a TONU or cancelled load bills only what was approved, never the linehaul", () => {
  assert.equal(loads.finalLoadAmount({ rate: 2000, exception: C.LOAD_EXCEPTION.TONU, adjustments_net: 0 }), null);
  assert.equal(loads.finalLoadAmount({ rate: 2000, exception: C.LOAD_EXCEPTION.TONU, adjustments_net: 150 }), 150);
  assert.equal(loads.finalLoadAmount({ rate: 2000, exception: C.LOAD_EXCEPTION.CANCELLED, adjustments_net: 0 }), null);
});

test("finalLoadAmount is null, not zero, with nothing to bill", () => {
  assert.equal(loads.finalLoadAmount({ rate: null, exception: null, adjustments_net: 0 }), null);
  assert.deepEqual(loads.rpm({ rate: null, exception: null, adjustments_net: 0, loaded_miles: 500, deadhead_miles: 0 }),
    { loaded: null, total: null });
});
```

(Match this file's existing import aliasing — `loads` for `src/lib/loads.ts`, `C` for
`src/lib/constants.ts`, per the `before()` block already there.)

- [ ] **Step 6: Run and commit**

```bash
node --conditions=react-server --test tests/loads.test.ts
git add src/lib/loads.ts tests/loads.test.ts
git commit -m "Redefine RPM around Final Load Amount; add finalLoadAmount()"
```

---

### Task 4: `load_adjustments` — read, write, and the upload-style Server Action

**Files:**
- Create: `src/lib/load-adjustments.ts`
- Create: `src/lib/load-adjustment-actions.ts`
- Test: `tests/load-adjustments.test.ts`

**Interfaces:**
- Consumes: `Org` (`tenant-db.ts`), `ADJUSTMENT_KIND`/`AdjustmentKind` (`constants.ts`,
  Task 2), `can`/`requireOrg` (Task 5 adds the action, but `load:manage` already exists).
- Produces: `AdjustmentRow`, `listLoadAdjustments(org, loadId)`,
  `addLoadAdjustment(org, loadId, input, userId)`, `addAdjustmentAction(prev, form)`.

- [ ] **Step 1: Write the failing test**

Create `tests/load-adjustments.test.ts`, mirroring `tests/dispatch-admin.test.ts`'s
seed/import shape:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { seedOrg, lookupId, type TestOrg } from "./helpers.ts";

const DB = path.join(tmpdir(), `carrier-hub-adjustments-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let adj: typeof import("../src/lib/load-adjustments.ts");
let alpha: TestOrg;
let beta: TestOrg;
let org: import("../src/lib/tenant-db.ts").Org;
let betaOrg: import("../src/lib/tenant-db.ts").Org;
let loadId: number;
let betaLoadId: number;

const now = () => new Date().toISOString();

before(async () => {
  db = await import("../src/lib/db.ts");
  adj = await import("../src/lib/load-adjustments.ts");
  const { Org } = await import("../src/lib/tenant-db.ts");

  alpha = seedOrg(db, "Alpha Dispatch");
  beta = seedOrg(db, "Beta Dispatch");
  org = new Org(alpha.id);
  betaOrg = new Org(beta.id);

  for (const [o, out] of [[alpha, "loadId"], [beta, "betaLoadId"]] as const) {
    db.run(
      `INSERT INTO carriers (organization_id, legal_name, status_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [o.id, `Carrier ${o.id}`, lookupId(db, o.id, "status", "active"), now(), now()],
    );
    const carrierId = db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
    db.run(
      `INSERT INTO loads (organization_id, carrier_id, status, created_at, updated_at)
       VALUES (?, ?, 'delivered', ?, ?)`,
      [o.id, carrierId, now(), now()],
    );
    const id = db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
    if (out === "loadId") loadId = id; else betaLoadId = id;
  }
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

test("adding an adjustment validates kind, description and amount", () => {
  assert.equal(adj.addLoadAdjustment(org, loadId, { kind: "bogus", description: "x", amount: 1 }, alpha.ownerId).ok, false);
  assert.equal(adj.addLoadAdjustment(org, loadId, { kind: "deduction", description: "  ", amount: 1 }, alpha.ownerId).ok, false);
  assert.equal(adj.addLoadAdjustment(org, loadId, { kind: "deduction", description: "Damage", amount: 0 }, alpha.ownerId).ok, false);
  assert.equal(adj.addLoadAdjustment(org, loadId, { kind: "deduction", description: "Damage", amount: -5 }, alpha.ownerId).ok, false);
  assert.equal(adj.addLoadAdjustment(org, loadId, { kind: "unknown_load", description: "x", amount: 1 }, alpha.ownerId).ok, false);
});

test("a valid adjustment is added and listed, newest last", () => {
  const first = adj.addLoadAdjustment(org, loadId, { kind: "extra_pay", description: "Detention", amount: 270 }, alpha.ownerId);
  assert.equal(first.ok, true);
  const second = adj.addLoadAdjustment(org, loadId, { kind: "deduction", description: "Damage claim", amount: 50 }, alpha.ownerId);
  assert.equal(second.ok, true);

  const list = adj.listLoadAdjustments(org, loadId);
  assert.equal(list.length, 2);
  assert.equal(list[0]!.description, "Detention");
  assert.equal(list[0]!.kind, "extra_pay");
  assert.equal(list[1]!.description, "Damage claim");
});

test("an adjustment cannot be added to another tenant's load", () => {
  const result = adj.addLoadAdjustment(org, betaLoadId, { kind: "extra_pay", description: "x", amount: 10 }, alpha.ownerId);
  assert.equal(result.ok, false);
});

test("adjustments are scoped per tenant", () => {
  assert.equal(adj.listLoadAdjustments(betaOrg, loadId).length, 0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --conditions=react-server --test tests/load-adjustments.test.ts`
Expected: FAIL — `src/lib/load-adjustments.ts` does not exist yet.

- [ ] **Step 3: Write `load-adjustments.ts`**

```ts
import "server-only";
import { all, get, run } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import { ADJUSTMENT_KIND, type AdjustmentKind } from "./constants.ts";

/**
 * Deductions and extra pay, itemized against a load. Append-only, like `load_documents`:
 * a detention charge or an approved TONU fee is evidence in a payment dispute, not a
 * value to quietly edit later. Feeds `loads.ts`'s `finalLoadAmount` and, downstream, the
 * dispatch fee.
 */

export type AdjustmentRow = {
  id: number;
  organization_id: number;
  load_id: number;
  kind: AdjustmentKind;
  description: string;
  amount: number;
  created_at: string;
  created_by: number | null;
  created_by_name: string | null;
};

export type Result = { ok: true; id: number } | { ok: false; error: string };

const SELECT = `
  SELECT a.*, u.name AS created_by_name
    FROM load_adjustments a LEFT JOIN users u ON u.organization_id = a.organization_id AND u.id = a.created_by
`;

export function listLoadAdjustments(org: Org, loadId: number): AdjustmentRow[] {
  return all<AdjustmentRow>(
    `${SELECT} WHERE a.organization_id = ? AND a.load_id = ? ORDER BY a.created_at, a.id`,
    [org.id, loadId],
  );
}

export function addLoadAdjustment(
  org: Org,
  loadId: number,
  input: { kind: string; description: string; amount: number },
  userId: number,
): Result {
  if (!Object.values(ADJUSTMENT_KIND).includes(input.kind as AdjustmentKind)) {
    return { ok: false, error: "Unknown adjustment kind." };
  }
  if (!get("SELECT 1 FROM loads WHERE organization_id = ? AND id = ?", [org.id, loadId])) {
    return { ok: false, error: "Unknown load." };
  }
  const description = input.description.trim().slice(0, 200);
  if (!description) return { ok: false, error: "Describe what this adjustment is for." };
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { ok: false, error: "Amount must be a positive number." };
  }

  run(
    `INSERT INTO load_adjustments (organization_id, load_id, kind, description, amount, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [org.id, loadId, input.kind, description, input.amount, new Date().toISOString(), userId],
  );
  return { ok: true, id: get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id };
}
```

- [ ] **Step 4: Run the test again**

Run: `node --conditions=react-server --test tests/load-adjustments.test.ts`
Expected: PASS

- [ ] **Step 5: Write the Server Action**

Create `src/lib/load-adjustment-actions.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { requireOrg } from "./auth.ts";
import { can } from "./permissions.ts";
import { addLoadAdjustment } from "./load-adjustments.ts";

export type AdjustmentState = { error?: string; ok?: string };

export async function addAdjustmentAction(_prev: AdjustmentState, form: FormData): Promise<AdjustmentState> {
  const { user, org } = await requireOrg();
  if (!can(user, "load:manage")) return { error: "Only dispatch can adjust a load's amount." };

  const loadId = Number(form.get("load_id"));
  if (!Number.isInteger(loadId) || loadId <= 0) return { error: "Unknown load." };

  const kind = String(form.get("kind") ?? "");
  const description = String(form.get("description") ?? "");
  const amount = Number(String(form.get("amount") ?? "").replace(/,/g, ""));

  const result = addLoadAdjustment(org, loadId, { kind, description, amount }, user.id);
  if (!result.ok) return { error: result.error };
  revalidatePath(`/loads/${loadId}`);
  return { ok: "Adjustment added." };
}
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/load-adjustments.ts src/lib/load-adjustment-actions.ts tests/load-adjustments.test.ts
git commit -m "Add load_adjustments: itemized deductions and extra pay"
```

---

### Task 5: Permissions — `invoice:view`, `invoice:manage`

**Files:**
- Modify: `src/lib/permissions.ts:18-45,78-114`

**Interfaces:**
- Produces: `can(user, "invoice:view")` — true for any active non-sales, non-support role
  (same scope as `load:rate`). `can(user, "invoice:manage")` — true only for admin/owner
  (same scope as `load:close`); no dispatcher tier exists for invoicing.

- [ ] **Step 1: Extend the `Action` union**

In `src/lib/permissions.ts`, add after `"broker:edit"` (line ~42):

```ts
  | "broker:edit"
  // Invoicing — Asterism's dispatch fee
  /** See invoices and what they total. Same scope as load:rate. */
  | "invoice:view"
  /** Generate a dispatch invoice and change its status (paid / disputed). No dispatcher
   *  tier exists here — the whole lifecycle is administrators only, same rationale as
   *  load:close. */
  | "invoice:manage"
  // Administration
  | "team:manage"
```

- [ ] **Step 2: Wire the switch**

In the `can()` switch (line ~78), add `"invoice:view"` to the universal-true group:

```ts
    case "carrier:view":
    case "export:run":
    case "load:view":
    case "invoice:view":
      return true;
```

And add `"invoice:manage"` to the admin-only `false` group (line ~107-113):

```ts
    case "carrier:delete":
    case "import:run":
    case "load:close":
    case "broker:edit":
    case "invoice:manage":
    case "team:manage":
    case "settings:manage":
      return false;
```

(TypeScript's exhaustive switch over `Action` forces both additions — the build fails
until every new action is handled somewhere in the switch.)

- [ ] **Step 3: Verify the build**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/lib/permissions.ts
git commit -m "Add invoice:view and invoice:manage permissions"
```

---

### Task 6: `invoices.ts` — dispatch fee calculation and reads

**Files:**
- Create: `src/lib/invoices.ts`
- Test: `tests/invoices.test.ts` (this task's slice: `computeDispatchFee` only)

**Interfaces:**
- Consumes: `LoadRow`, `listLoads`, `finalLoadAmount` (`loads.ts`, Task 3). `LOAD_STATUS`,
  `FEE_BASIS`, `InvoiceStatus` (`constants.ts`, Task 2).
- Produces: `computeDispatchFee(carrier, finalLoadAmount)`, `round2(n)`,
  `listInvoiceableLoads(org, carrierId)`, `InvoiceRow`, `InvoiceLineRow`, `listInvoices`,
  `getInvoice`, `invoiceLines`, `invoiceForLoad`.

- [ ] **Step 1: Write the failing test**

Create `tests/invoices.test.ts`:

```ts
import { test, before } from "node:test";
import assert from "node:assert/strict";

let inv: typeof import("../src/lib/invoices.ts");

before(async () => {
  inv = await import("../src/lib/invoices.ts");
});

test("computeDispatchFee: percentage of Final Load Amount", () => {
  const result = inv.computeDispatchFee({ pricingType: "percentage_per_load", rate: null, percentage: 10 }, 3920);
  assert.deepEqual(result, { ok: true, basis: "percentage", rateValue: 10, amount: 392 });
});

test("computeDispatchFee: flat fee ignores Final Load Amount", () => {
  const result = inv.computeDispatchFee({ pricingType: "flat_per_load", rate: 75, percentage: null }, 3920);
  assert.deepEqual(result, { ok: true, basis: "flat", rateValue: 75, amount: 75 });
});

test("computeDispatchFee: missing configuration is an error, not a guess", () => {
  assert.equal(inv.computeDispatchFee({ pricingType: "percentage_per_load", rate: null, percentage: null }, 100).ok, false);
  assert.equal(inv.computeDispatchFee({ pricingType: "flat_per_load", rate: null, percentage: null }, 100).ok, false);
});

test("computeDispatchFee: an unsupported pricing type refuses rather than guessing", () => {
  for (const pricingType of ["fixed_monthly", "fixed_weekly", "custom", "not_yet_pitched", null]) {
    const result = inv.computeDispatchFee({ pricingType, rate: 100, percentage: 10 }, 1000);
    assert.equal(result.ok, false);
  }
});

test("computeDispatchFee rounds to the cent", () => {
  const result = inv.computeDispatchFee({ pricingType: "percentage_per_load", rate: null, percentage: 12.5 }, 333.33);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.amount, 41.67);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --conditions=react-server --test tests/invoices.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write `invoices.ts`**

```ts
import "server-only";
import { all, get } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import { listLoads, type LoadRow } from "./loads.ts";
import { LOAD_STATUS, FEE_BASIS, INVOICE_STATUS, type FeeBasis, type InvoiceStatus } from "./constants.ts";

/**
 * Dispatch invoices: reads, and the pure dispatch-fee calculation. Writes (creating one,
 * changing its status) live in `invoice-write.ts` — same split as `loads.ts`/`load-write.ts`.
 */

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export type DispatchFeeResult =
  | { ok: true; basis: FeeBasis; rateValue: number; amount: number }
  | { ok: false; error: string };

/**
 * The Asterism → Carrier dispatch fee for one load, from the carrier's configured pricing
 * arrangement, applied to Final Load Amount — after approved deductions/extra pay, per
 * the carrier agreement, not the raw linehaul rate.
 */
export function computeDispatchFee(
  carrier: { pricingType: string | null; rate: number | null; percentage: number | null },
  finalLoadAmount: number,
): DispatchFeeResult {
  if (carrier.pricingType === "percentage_per_load") {
    if (carrier.percentage === null) {
      return { ok: false, error: "This carrier has no dispatch percentage configured." };
    }
    return {
      ok: true,
      basis: FEE_BASIS.PERCENTAGE,
      rateValue: carrier.percentage,
      amount: round2((carrier.percentage / 100) * finalLoadAmount),
    };
  }
  if (carrier.pricingType === "flat_per_load") {
    if (carrier.rate === null) {
      return { ok: false, error: "This carrier has no flat dispatch fee configured." };
    }
    return { ok: true, basis: FEE_BASIS.FLAT, rateValue: carrier.rate, amount: round2(carrier.rate) };
  }
  return {
    ok: false,
    error:
      "This carrier's pricing arrangement does not support automatic per-load dispatch " +
      "invoicing. Set it to Percentage Per Load or Flat Fee Per Load first.",
  };
}

/** Delivered loads for one carrier, not yet on any invoice — status forward-only means a
 *  load already invoiced can never reappear here. */
export function listInvoiceableLoads(org: Org, carrierId: number): LoadRow[] {
  return listLoads(org, { carrier: [carrierId], status: [LOAD_STATUS.DELIVERED] }, { pageSize: 200 }).rows;
}

export type InvoiceRow = {
  id: number;
  organization_id: number;
  invoice_type: string;
  carrier_id: number;
  status: InvoiceStatus;
  issued_on: string;
  paid_on: string | null;
  total_amount: number;
  notes: string | null;
  created_at: string;
  created_by: number | null;
  updated_at: string;
  updated_by: number | null;
  carrier_name: string;
};

export type InvoiceLineRow = {
  id: number;
  invoice_id: number;
  load_id: number;
  final_load_amount: number;
  fee_basis: FeeBasis;
  fee_rate: number;
  amount: number;
  created_at: string;
  load_number: string | null;
  delivered_at: string | null;
};

const INVOICE_SELECT = `
  SELECT i.*, c.legal_name AS carrier_name
    FROM invoices i JOIN carriers c ON c.organization_id = i.organization_id AND c.id = i.carrier_id
`;

export function listInvoices(
  org: Org,
  filters: { carrierId?: number; status?: InvoiceStatus } = {},
): InvoiceRow[] {
  const clauses = ["i.organization_id = ?"];
  const params: unknown[] = [org.id];
  if (filters.carrierId) { clauses.push("i.carrier_id = ?"); params.push(filters.carrierId); }
  if (filters.status) { clauses.push("i.status = ?"); params.push(filters.status); }
  return all<InvoiceRow>(
    `${INVOICE_SELECT} WHERE ${clauses.join(" AND ")} ORDER BY i.issued_on DESC, i.id DESC`,
    params,
  );
}

export function getInvoice(org: Org, id: number): InvoiceRow | undefined {
  return get<InvoiceRow>(`${INVOICE_SELECT} WHERE i.organization_id = ? AND i.id = ?`, [org.id, id]);
}

export function invoiceLines(org: Org, invoiceId: number): InvoiceLineRow[] {
  return all<InvoiceLineRow>(
    `SELECT il.*, l.load_number, l.delivered_at
       FROM invoice_lines il JOIN loads l ON l.organization_id = il.organization_id AND l.id = il.load_id
      WHERE il.organization_id = ? AND il.invoice_id = ?
      ORDER BY il.id`,
    [org.id, invoiceId],
  );
}

/** The invoice a load is on, if any — for a link back from the load's own page. */
export function invoiceForLoad(org: Org, loadId: number): { id: number; status: InvoiceStatus } | undefined {
  return get<{ id: number; status: InvoiceStatus }>(
    `SELECT i.id, i.status FROM invoice_lines il
       JOIN invoices i ON i.organization_id = il.organization_id AND i.id = il.invoice_id
      WHERE il.organization_id = ? AND il.load_id = ?`,
    [org.id, loadId],
  );
}
```

- [ ] **Step 4: Run the test again**

Run: `node --conditions=react-server --test tests/invoices.test.ts`
Expected: PASS (5 tests — the `computeDispatchFee` slice; more are added in Task 7).

- [ ] **Step 5: Commit**

```bash
git add src/lib/invoices.ts tests/invoices.test.ts
git commit -m "Add invoices.ts: dispatch fee calculation and invoice reads"
```

---

### Task 7: `invoice-write.ts` — creating an invoice, changing its status

**Files:**
- Create: `src/lib/invoice-write.ts`
- Modify: `tests/invoices.test.ts` (add this task's cases)

**Interfaces:**
- Consumes: `getCarrier` (`carriers.ts`), `lookup` (`lookups.ts`), `getLoad`,
  `finalLoadAmount` (`loads.ts`), `setStatus` (`load-write.ts`), `computeDispatchFee`,
  `round2` (`invoices.ts`, Task 6). `INVOICE_STATUS`, `LOAD_STATUS` (`constants.ts`).
- Produces: `CreateInvoiceInput`, `InvoiceResult`, `createInvoice(org, input, userId)`,
  `setInvoiceStatus(org, id, status, userId)`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/invoices.test.ts` — this needs a real database, so rework the `before()`
block to seed one (mirroring `tests/loads.test.ts`'s shape) and add these cases:

```ts
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { seedOrg, lookupId, type TestOrg } from "./helpers.ts";

const DB = path.join(tmpdir(), `carrier-hub-invoices-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let inv: typeof import("../src/lib/invoices.ts");
let iw: typeof import("../src/lib/invoice-write.ts");
let C: typeof import("../src/lib/constants.ts");
let alpha: TestOrg;
let org: import("../src/lib/tenant-db.ts").Org;
let percentCarrier: number;
let flatCarrier: number;
let unsupportedCarrier: number;

const now = () => new Date().toISOString();

before(async () => {
  db = await import("../src/lib/db.ts");
  inv = await import("../src/lib/invoices.ts");
  iw = await import("../src/lib/invoice-write.ts");
  C = await import("../src/lib/constants.ts");
  const { Org } = await import("../src/lib/tenant-db.ts");

  alpha = seedOrg(db, "Alpha Dispatch");
  org = new Org(alpha.id);

  const carrier = (pricingValue: string, rate: number | null, percentage: number | null) => {
    db.run(
      `INSERT INTO carriers (organization_id, legal_name, status_id, pricing_type_id, rate, percentage, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [alpha.id, `Carrier ${pricingValue}`, lookupId(db, alpha.id, "status", "active"),
       lookupId(db, alpha.id, "pricing_type", pricingValue), rate, percentage, now(), now()],
    );
    return db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
  };
  percentCarrier = carrier("percentage_per_load", null, 10);
  flatCarrier = carrier("flat_per_load", 75, null);
  unsupportedCarrier = carrier("fixed_monthly", 500, null);
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

function deliveredLoad(carrierId: number, rate: number): number {
  db.run(
    `INSERT INTO loads (organization_id, carrier_id, status, rate, created_at, updated_at)
     VALUES (?, ?, 'delivered', ?, ?, ?)`,
    [alpha.id, carrierId, rate, now(), now()],
  );
  return db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
}

test("createInvoice batches loads for one carrier, snapshots amounts, advances status", () => {
  const a = deliveredLoad(percentCarrier, 1000);
  const b = deliveredLoad(percentCarrier, 2000);

  const result = iw.createInvoice(org, { carrierId: percentCarrier, loadIds: [a, b], issuedOn: "2026-09-02" }, alpha.ownerId);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const header = inv.getInvoice(org, result.id)!;
  assert.equal(header.status, "pending");
  assert.equal(header.total_amount, 300); // 10% of 1000 + 10% of 2000

  const lines = inv.invoiceLines(org, result.id);
  assert.equal(lines.length, 2);

  const loadA = db.get<{ status: string }>("SELECT status FROM loads WHERE id = ?", [a])!;
  assert.equal(loadA.status, "invoiced");
});

test("createInvoice rejects a load that is not Delivered", () => {
  db.run(
    `INSERT INTO loads (organization_id, carrier_id, status, rate, created_at, updated_at)
     VALUES (?, ?, 'assigned', 500, ?, ?)`,
    [alpha.id, percentCarrier, now(), now()],
  );
  const id = db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
  const result = iw.createInvoice(org, { carrierId: percentCarrier, loadIds: [id], issuedOn: "2026-09-02" }, alpha.ownerId);
  assert.equal(result.ok, false);
});

test("createInvoice refuses a carrier whose pricing arrangement isn't per-load", () => {
  const load = deliveredLoad(unsupportedCarrier, 1000);
  const result = iw.createInvoice(org, { carrierId: unsupportedCarrier, loadIds: [load], issuedOn: "2026-09-02" }, alpha.ownerId);
  assert.equal(result.ok, false);
});

test("createInvoice refuses an empty selection", () => {
  const result = iw.createInvoice(org, { carrierId: percentCarrier, loadIds: [], issuedOn: "2026-09-02" }, alpha.ownerId);
  assert.equal(result.ok, false);
});

test("a flat-fee carrier is charged the flat rate regardless of load amount", () => {
  const load = deliveredLoad(flatCarrier, 9999);
  const result = iw.createInvoice(org, { carrierId: flatCarrier, loadIds: [load], issuedOn: "2026-09-02" }, alpha.ownerId);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(inv.getInvoice(org, result.id)!.total_amount, 75);
});

test("marking an invoice Paid advances its loads to Paid; disputing never walks them back", () => {
  const load = deliveredLoad(percentCarrier, 1000);
  const created = iw.createInvoice(org, { carrierId: percentCarrier, loadIds: [load], issuedOn: "2026-09-02" }, alpha.ownerId);
  assert.equal(created.ok, true);
  if (!created.ok) return;

  iw.setInvoiceStatus(org, created.id, "paid", alpha.ownerId);
  assert.equal(db.get<{ status: string }>("SELECT status FROM loads WHERE id = ?", [load])!.status, "paid");
  assert.ok(inv.getInvoice(org, created.id)!.paid_on);

  iw.setInvoiceStatus(org, created.id, "disputed", alpha.ownerId);
  assert.equal(db.get<{ status: string }>("SELECT status FROM loads WHERE id = ?", [load])!.status, "paid",
    "disputing the invoice does not walk the load status backward");
  assert.equal(inv.getInvoice(org, created.id)!.paid_on, null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --conditions=react-server --test tests/invoices.test.ts`
Expected: FAIL — `src/lib/invoice-write.ts` does not exist.

- [ ] **Step 3: Write `invoice-write.ts`**

```ts
import "server-only";
import { get, run, transaction } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import { getCarrier } from "./carriers.ts";
import { lookup } from "./lookups.ts";
import { getLoad, finalLoadAmount } from "./loads.ts";
import { setStatus } from "./load-write.ts";
import { computeDispatchFee, round2 } from "./invoices.ts";
import { LOAD_STATUS, INVOICE_STATUS, type InvoiceStatus, type FeeBasis } from "./constants.ts";

export type CreateInvoiceInput = {
  carrierId: number;
  loadIds: number[];
  issuedOn: string;
  notes?: string | null;
};

export type InvoiceResult = { ok: true; id: number } | { ok: false; error: string };

/**
 * One dispatch invoice for one carrier, covering one or more Delivered loads. Amounts are
 * computed and snapshotted here — an invoice is a historical document, not a live view —
 * and every included load is advanced to Invoiced in the same transaction.
 *
 * Every load is re-validated here rather than trusted from the caller: carrier match,
 * Delivered status, and a real billable amount. `load:manage`'s create-load form already
 * re-validates its own referenced ids the same way (`belongs()` in `load-write.ts`).
 */
export function createInvoice(org: Org, input: CreateInvoiceInput, userId: number | null): InvoiceResult {
  if (input.loadIds.length === 0) return { ok: false, error: "Choose at least one load to invoice." };

  const carrier = getCarrier(org, input.carrierId);
  if (!carrier) return { ok: false, error: "Unknown carrier." };
  const pricingType = lookup(org, carrier.pricing_type_id)?.value ?? null;

  const lines: { loadId: number; finalAmount: number; basis: FeeBasis; rateValue: number; amount: number }[] = [];
  for (const loadId of input.loadIds) {
    const load = getLoad(org, loadId);
    if (!load) return { ok: false, error: `Load ${loadId} not found.` };
    if (load.carrier_id !== input.carrierId) {
      return { ok: false, error: `Load ${load.load_number ?? loadId} belongs to a different carrier.` };
    }
    if (load.status !== LOAD_STATUS.DELIVERED) {
      return { ok: false, error: `Load ${load.load_number ?? loadId} is not Delivered.` };
    }
    const amount = finalLoadAmount(load);
    if (amount === null) {
      return { ok: false, error: `Load ${load.load_number ?? loadId} has no billable amount yet.` };
    }
    const fee = computeDispatchFee({ pricingType, rate: carrier.rate, percentage: carrier.percentage }, amount);
    if (!fee.ok) return { ok: false, error: fee.error };
    lines.push({ loadId, finalAmount: amount, basis: fee.basis, rateValue: fee.rateValue, amount: fee.amount });
  }

  const total = round2(lines.reduce((sum, l) => sum + l.amount, 0));
  const now = new Date().toISOString();

  return transaction(() => {
    run(
      // ponytail: invoice_type is always 'dispatch' today — 'freight' (Carrier → Broker)
      // becomes real when that invoice ships; the column exists now so that doesn't need
      // its own migration.
      `INSERT INTO invoices (organization_id, invoice_type, carrier_id, status, issued_on, total_amount, notes, created_at, created_by, updated_at, updated_by)
       VALUES (?, 'dispatch', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [org.id, input.carrierId, INVOICE_STATUS.PENDING, input.issuedOn, total, input.notes?.trim() || null, now, userId, now, userId],
    );
    const invoiceId = get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;

    for (const line of lines) {
      run(
        `INSERT INTO invoice_lines (organization_id, invoice_id, load_id, final_load_amount, fee_basis, fee_rate, amount, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [org.id, invoiceId, line.loadId, line.finalAmount, line.basis, line.rateValue, line.amount, now],
      );
      const advanced = setStatus(org, line.loadId, LOAD_STATUS.INVOICED, userId);
      if (!advanced.ok) throw new Error(`Could not advance load ${line.loadId} to Invoiced: ${advanced.error}`);
    }
    return { ok: true as const, id: invoiceId };
  });
}

/**
 * Free transitions among pending / paid / disputed — not forward-only like a load's own
 * status, because a mistaken Paid has to be correctable. Moving *to* Paid advances every
 * included load from Invoiced to Paid (skipping one already moved on some other way);
 * moving *off* Paid never walks a load status backward — see the design doc §6.
 */
export function setInvoiceStatus(
  org: Org, id: number, status: InvoiceStatus, userId: number | null,
): InvoiceResult {
  const invoice = get<{ id: number }>("SELECT id FROM invoices WHERE organization_id = ? AND id = ?", [org.id, id]);
  if (!invoice) return { ok: false, error: "Unknown invoice." };
  const now = new Date().toISOString();

  return transaction(() => {
    run(
      `UPDATE invoices SET status = ?, paid_on = ?, updated_at = ?, updated_by = ?
        WHERE organization_id = ? AND id = ?`,
      [status, status === INVOICE_STATUS.PAID ? now : null, now, userId, org.id, id],
    );

    if (status === INVOICE_STATUS.PAID) {
      const lineLoads = get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM invoice_lines WHERE organization_id = ? AND invoice_id = ?", [org.id, id],
      )!.n;
      if (lineLoads > 0) {
        const rows = get<{ ids: string }>(
          `SELECT group_concat(load_id) AS ids FROM invoice_lines WHERE organization_id = ? AND invoice_id = ?`,
          [org.id, id],
        )!;
        for (const loadIdStr of (rows.ids ?? "").split(",")) {
          const loadId = Number(loadIdStr);
          const load = get<{ status: string }>("SELECT status FROM loads WHERE organization_id = ? AND id = ?", [org.id, loadId]);
          if (load?.status === LOAD_STATUS.INVOICED) setStatus(org, loadId, LOAD_STATUS.PAID, userId);
        }
      }
    }
    return { ok: true as const, id };
  });
}
```

- [ ] **Step 4: Run the tests again**

Run: `node --conditions=react-server --test tests/invoices.test.ts`
Expected: PASS (all cases from Tasks 6 and 7).

- [ ] **Step 5: Commit**

```bash
git add src/lib/invoice-write.ts tests/invoices.test.ts
git commit -m "Add invoice-write.ts: createInvoice and setInvoiceStatus"
```

---

### Task 8: `invoice-actions.ts` — Server Actions

**Files:**
- Create: `src/lib/invoice-actions.ts`

**Interfaces:**
- Consumes: `createInvoice`, `setInvoiceStatus` (Task 7). `can`, `requireOrg`.
  `INVOICE_STATUS` (Task 2).
- Produces: `InvoiceFormState`, `createInvoiceAction(prev, form)`,
  `setInvoiceStatusAction(form)`.

- [ ] **Step 1: Write the file**

```ts
"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireOrg } from "./auth.ts";
import { can } from "./permissions.ts";
import { createInvoice } from "./invoice-write.ts";
import { setInvoiceStatus } from "./invoice-write.ts";
import { INVOICE_STATUS, type InvoiceStatus } from "./constants.ts";

export type InvoiceFormState = { error?: string };

export async function createInvoiceAction(_prev: InvoiceFormState, form: FormData): Promise<InvoiceFormState> {
  const { user, org } = await requireOrg();
  if (!can(user, "invoice:manage")) return { error: "You do not have permission to create invoices." };

  const carrierId = Number(form.get("carrier_id"));
  if (!Number.isInteger(carrierId)) return { error: "Choose a carrier." };
  const loadIds = form.getAll("load_id").map(Number).filter(Number.isInteger);
  const issuedOn = String(form.get("issued_on") ?? "").trim() || new Date().toISOString().slice(0, 10);
  const notes = String(form.get("notes") ?? "").trim() || null;

  const result = createInvoice(org, { carrierId, loadIds, issuedOn, notes }, user.id);
  if (!result.ok) return { error: result.error };

  revalidatePath("/invoices");
  revalidatePath("/loads");
  redirect(`/invoices/${result.id}`);
}

export async function setInvoiceStatusAction(form: FormData): Promise<void> {
  const { user, org } = await requireOrg();
  if (!can(user, "invoice:manage")) throw new Error("Not authorized to change this invoice's status.");

  const id = Number(form.get("id"));
  const status = String(form.get("status")) as InvoiceStatus;
  if (!Object.values(INVOICE_STATUS).includes(status)) throw new Error("Unknown invoice status.");
  if (Number.isInteger(id)) setInvoiceStatus(org, id, status, user.id);

  revalidatePath(`/invoices/${id}`);
  revalidatePath("/invoices");
  revalidatePath("/loads");
}
```

(Two `import ... from "./invoice-write.ts"` lines are written separately above to name
each import explicitly; combine them into one `import { createInvoice, setInvoiceStatus } from "./invoice-write.ts";` line when writing the file.)

- [ ] **Step 2: Verify the build**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/invoice-actions.ts
git commit -m "Add Server Actions for creating and updating invoices"
```

---

### Task 9: `/invoices` list page and nav entry

**Files:**
- Create: `src/app/(app)/invoices/page.tsx`
- Modify: `src/components/app-shell.tsx:27-35`

**Interfaces:**
- Consumes: `listInvoices` (Task 6), `can`/`requireOrg`, `INVOICE_STATUS_LABELS`/`_TONE`
  (Task 2).

- [ ] **Step 1: Write the page**

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { listInvoices } from "@/lib/invoices";
import { INVOICE_STATUS_LABELS, INVOICE_STATUS_TONE } from "@/lib/constants";
import { formatDate, formatMoney } from "@/lib/format";
import { Badge, Card, EmptyState, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Invoices" };

export default async function InvoicesPage() {
  const { user, org } = await requireOrg();
  if (!can(user, "invoice:view")) redirect("/");
  const mayManage = can(user, "invoice:manage");

  const invoices = listInvoices(org);

  return (
    <>
      <PageHeader
        title="Invoices"
        subtitle="Asterism's dispatch fee, billed to the carrier."
        actions={
          mayManage ? (
            <Link
              href="/invoices/new"
              className="rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-brand-700"
            >
              Create Invoice
            </Link>
          ) : undefined
        }
      />
      {invoices.length === 0 ? (
        <EmptyState
          title="No invoices yet"
          description="Once a load is Delivered, it can be included on a dispatch invoice."
        />
      ) : (
        <Card padded={false}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-line bg-ink-50/70">
                  {["Carrier", "Issued", "Status", "Total", ""].map((h) => (
                    <th key={h} scope="col" className="px-4 py-2.5 text-left text-xs font-semibold text-ink-600">
                      {h === "" ? <span className="sr-only">Open</span> : h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {invoices.map((inv) => (
                  <tr key={inv.id} className="border-b border-line/70 last:border-0">
                    <td className="px-4 py-2.5 text-ink-900">{inv.carrier_name}</td>
                    <td className="px-4 py-2.5 text-ink-600">{formatDate(inv.issued_on)}</td>
                    <td className="px-4 py-2.5">
                      <Badge tone={INVOICE_STATUS_TONE[inv.status]}>{INVOICE_STATUS_LABELS[inv.status]}</Badge>
                    </td>
                    <td className="px-4 py-2.5 font-mono tnum text-ink-900">{formatMoney(inv.total_amount)}</td>
                    <td className="px-4 py-2.5 text-right">
                      <Link href={`/invoices/${inv.id}`} className="text-sm font-medium text-brand-700 hover:underline">
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
```

- [ ] **Step 2: Add the nav entry**

In `src/components/app-shell.tsx`, in the `"Dispatch"` group (lines 29-35), add a fourth
item. Reuse the existing `"note"` icon — a lined-document glyph already in `icons.tsx`
that nothing in the sidebar currently uses, so no new SVG is needed:

```ts
  {
    heading: "Dispatch",
    items: [
      { href: "/loads", label: "Load Management", icon: "loads", count: "loads" },
      { href: "/drivers", label: "Drivers", icon: "drivers" },
      { href: "/brokers", label: "Brokers", icon: "brokers" },
      { href: "/invoices", label: "Invoices", icon: "note" },
    ],
  },
```

No `count` — invoices aren't a workload queue the way open loads are, so no badge (matches
`/drivers`, `/brokers`, `/reports`, `/team`, which also carry none).

- [ ] **Step 3: Manual check**

Run: `npm run dev`, sign in, confirm "Invoices" appears in the Dispatch group and
`/invoices` renders the empty state.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/invoices/page.tsx" src/components/app-shell.tsx
git commit -m "Add /invoices list page and nav entry"
```

---

### Task 10: `/invoices/new` — pick a carrier, pick loads, create

**Files:**
- Create: `src/app/(app)/invoices/new/page.tsx`
- Create: `src/components/invoice-form.tsx`

**Interfaces:**
- Consumes: `carrierOptions` (`form-options.ts`), `getCarrier` (`carriers.ts`), `lookup`
  (`lookups.ts`), `listInvoiceableLoads`, `computeDispatchFee` (Task 6), `finalLoadAmount`
  (Task 3), `createInvoiceAction` (Task 8).

A two-step, JS-free carrier picker (plain `<form>` GET, no `action`/`method`, which
submits to the same URL with `?carrier=` — the same server-component-only shape used
everywhere else in this app), then a client-side create form for the loads it finds.

- [ ] **Step 1: Write the page**

```tsx
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { carrierOptions } from "@/lib/form-options";
import { getCarrier } from "@/lib/carriers";
import { lookup } from "@/lib/lookups";
import { listInvoiceableLoads, computeDispatchFee } from "@/lib/invoices";
import { finalLoadAmount } from "@/lib/loads";
import { Card, CardHeader, EmptyState, PageHeader } from "@/components/ui";
import { InvoiceForm } from "@/components/invoice-form";

export const metadata: Metadata = { title: "Create Invoice" };

export default async function NewInvoicePage(props: PageProps<"/invoices/new">) {
  const { user, org } = await requireOrg();
  if (!can(user, "invoice:manage")) redirect("/invoices");

  const sp = await props.searchParams;
  const raw = Array.isArray(sp.carrier) ? sp.carrier[0] : sp.carrier;
  const carrierId = raw ? Number(raw) : null;
  const carriers = carrierOptions(org);

  let panel: React.ReactNode = null;
  if (carrierId) {
    const carrier = getCarrier(org, carrierId);
    if (!carrier) {
      panel = <EmptyState title="Unknown carrier" />;
    } else {
      const pricingType = lookup(org, carrier.pricing_type_id)?.value ?? null;
      // Probing with an arbitrary amount surfaces a carrier-level problem (no percentage
      // configured, or a pricing type that isn't per-load at all) without duplicating
      // computeDispatchFee's own validation here.
      const probe = computeDispatchFee({ pricingType, rate: carrier.rate, percentage: carrier.percentage }, 1);
      if (!probe.ok) {
        panel = (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {probe.error}
          </div>
        );
      } else {
        const eligible = listInvoiceableLoads(org, carrierId);
        panel =
          eligible.length === 0 ? (
            <EmptyState
              title="Nothing to invoice"
              description={`${carrier.legal_name} has no Delivered, uninvoiced loads right now.`}
            />
          ) : (
            <InvoiceForm
              carrierId={carrierId}
              carrierName={carrier.legal_name}
              loads={eligible.map((load) => {
                const amount = finalLoadAmount(load);
                const fee = amount === null
                  ? null
                  : computeDispatchFee({ pricingType, rate: carrier.rate, percentage: carrier.percentage }, amount);
                return {
                  load: { id: load.id, load_number: load.load_number, delivered_at: load.delivered_at },
                  finalAmount: amount,
                  feeAmount: fee && fee.ok ? fee.amount : null,
                };
              })}
            />
          );
      }
    }
  }

  return (
    <>
      <PageHeader title="Create Invoice" subtitle="Pick a carrier, then the Delivered loads to bill for dispatch." />
      <Card className="mb-5">
        <CardHeader title="Carrier" />
        <form className="flex flex-wrap items-end gap-3">
          <div className="min-w-[16rem] flex-1">
            <label className="label" htmlFor="carrier">Carrier</label>
            <select id="carrier" name="carrier" defaultValue={carrierId ?? ""} className="field w-full" required>
              <option value="" disabled>Choose a carrier</option>
              {carriers.map((c) => (
                <option key={c.id} value={c.id}>{c.label}</option>
              ))}
            </select>
          </div>
          <button className="rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-sm font-semibold text-ink-700 hover:bg-ink-50">
            Show loads
          </button>
        </form>
      </Card>
      {panel}
    </>
  );
}
```

- [ ] **Step 2: Write the client form**

Create `src/components/invoice-form.tsx`. Note the `PreviewRow` type is defined locally
here rather than imported from `loads.ts` — that module carries `import "server-only"`,
and this repo has already been bitten once by a Client Component transitively reaching a
server-only module through a type import (`Architecture.md`, Phase 3's "Fixed during this
phase"); a small local type sidesteps the question entirely.

```tsx
"use client";

import { useActionState } from "react";
import { createInvoiceAction, type InvoiceFormState } from "@/lib/invoice-actions";
import { formatDate, formatMoney } from "@/lib/format";
import { Banner } from "./ui";

type PreviewRow = {
  load: { id: number; load_number: string | null; delivered_at: string | null };
  finalAmount: number | null;
  feeAmount: number | null;
};

export function InvoiceForm({
  carrierId,
  carrierName,
  loads,
}: {
  carrierId: number;
  carrierName: string;
  loads: PreviewRow[];
}) {
  const [state, action, pending] = useActionState<InvoiceFormState, FormData>(createInvoiceAction, {});
  const today = new Date().toISOString().slice(0, 10);
  const invoiceable = loads.some((r) => r.feeAmount !== null);

  return (
    <div className="space-y-4">
      <Banner state={state} />
      <form action={action} className="space-y-4">
        <input type="hidden" name="carrier_id" value={carrierId} />
        <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-ink-50/70">
                {["", "Load", "Delivered", "Final Load Amount", "Dispatch Fee"].map((h) => (
                  <th key={h} scope="col" className="px-4 py-2.5 text-left text-xs font-semibold text-ink-600">
                    {h === "" ? <span className="sr-only">Include</span> : h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loads.map(({ load, finalAmount, feeAmount }) => (
                <tr key={load.id} className="border-b border-line/70 last:border-0">
                  <td className="px-4 py-2.5">
                    <input
                      type="checkbox" name="load_id" value={load.id}
                      defaultChecked={feeAmount !== null} disabled={feeAmount === null}
                    />
                  </td>
                  <td className="px-4 py-2.5 text-ink-900">{load.load_number || `Load #${load.id}`}</td>
                  <td className="px-4 py-2.5 text-ink-600">{formatDate(load.delivered_at?.slice(0, 10) ?? null)}</td>
                  <td className="px-4 py-2.5 font-mono tnum text-ink-900">{formatMoney(finalAmount)}</td>
                  <td className="px-4 py-2.5 font-mono tnum text-ink-900">
                    {feeAmount === null ? (
                      <span className="text-red-600">No billable amount yet</span>
                    ) : (
                      formatMoney(feeAmount)
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="label" htmlFor="issued_on">Issued</label>
            <input id="issued_on" name="issued_on" type="date" defaultValue={today} className="field" required />
          </div>
          <div className="min-w-[16rem] flex-1">
            <label className="label" htmlFor="notes">Notes</label>
            <input id="notes" name="notes" type="text" className="field w-full" placeholder="Optional" />
          </div>
          <button
            type="submit"
            disabled={pending || !invoiceable}
            className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
          >
            {pending ? "Creating…" : `Create Invoice for ${carrierName}`}
          </button>
        </div>
      </form>
    </div>
  );
}
```

- [ ] **Step 3: Manual check**

Run: `npm run dev`. As an admin, open `/invoices/new`, pick a carrier with a delivered
load and `percentage_per_load`/`flat_per_load` pricing, confirm the fee preview looks
right, submit, and land on the new invoice's detail page (Task 11 — until that page
exists this will 404, which is fine to note and revisit after Task 11).

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/invoices/new/page.tsx" src/components/invoice-form.tsx
git commit -m "Add /invoices/new: carrier + load picker with a live fee preview"
```

---

### Task 11: `/invoices/[id]` — detail and status controls

**Files:**
- Create: `src/app/(app)/invoices/[id]/page.tsx`

**Interfaces:**
- Consumes: `getInvoice`, `invoiceLines` (Task 6), `setInvoiceStatusAction` (Task 8),
  `INVOICE_STATUS`, `INVOICE_STATUS_LABELS`, `INVOICE_STATUS_TONE` (Task 2).

- [ ] **Step 1: Write the page**

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { getInvoice, invoiceLines } from "@/lib/invoices";
import { setInvoiceStatusAction } from "@/lib/invoice-actions";
import { INVOICE_STATUS, INVOICE_STATUS_LABELS, INVOICE_STATUS_TONE } from "@/lib/constants";
import { formatDate, formatMoney } from "@/lib/format";
import { Badge, Card, CardHeader, Field, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Invoice" };

export default async function InvoicePage(props: PageProps<"/invoices/[id]">) {
  const { user, org } = await requireOrg();
  if (!can(user, "invoice:view")) redirect("/");

  const id = Number((await props.params).id);
  if (!Number.isInteger(id)) notFound();
  const invoice = getInvoice(org, id);
  if (!invoice) notFound();

  const mayManage = can(user, "invoice:manage");
  const lines = invoiceLines(org, id);

  return (
    <>
      <PageHeader
        title={`Invoice #${invoice.id}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={INVOICE_STATUS_TONE[invoice.status]}>{INVOICE_STATUS_LABELS[invoice.status]}</Badge>
            <span className="text-ink-500">{invoice.carrier_name}</span>
          </span>
        }
        actions={
          <Link
            href="/invoices"
            className="rounded-lg border border-line-strong bg-surface px-3.5 py-2 text-sm font-medium text-ink-700 hover:bg-ink-50"
          >
            All invoices
          </Link>
        }
      />

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card>
            <CardHeader title="Loads" subtitle="Dispatch fee per load, fixed at the time this invoice was created." />
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line bg-ink-50/70">
                    {["Load", "Delivered", "Final Load Amount", "Basis", "Dispatch Fee"].map((h) => (
                      <th key={h} scope="col" className="px-3 py-2 text-left text-xs font-semibold text-ink-600">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.id} className="border-b border-line/70 last:border-0">
                      <td className="px-3 py-2">
                        <Link href={`/loads/${line.load_id}`} className="font-medium text-brand-700 hover:underline">
                          {line.load_number || `Load #${line.load_id}`}
                        </Link>
                      </td>
                      <td className="px-3 py-2 text-ink-600">{formatDate(line.delivered_at?.slice(0, 10) ?? null)}</td>
                      <td className="px-3 py-2 font-mono tnum text-ink-900">{formatMoney(line.final_load_amount)}</td>
                      <td className="px-3 py-2 text-ink-600">
                        {line.fee_basis === "percentage" ? `${line.fee_rate}%` : formatMoney(line.fee_rate)}
                      </td>
                      <td className="px-3 py-2 font-mono tnum text-ink-900">{formatMoney(line.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={4} className="px-3 py-2 text-right text-sm font-semibold text-ink-700">Total</td>
                    <td className="px-3 py-2 font-mono tnum text-sm font-semibold text-ink-900">{formatMoney(invoice.total_amount)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Record" />
            <dl className="grid gap-y-2">
              <Field label="Issued">{formatDate(invoice.issued_on)}</Field>
              <Field label="Paid">{formatDate(invoice.paid_on)}</Field>
              <Field label="Notes">{invoice.notes}</Field>
            </dl>
          </Card>

          {mayManage && (
            <Card>
              <CardHeader title="Status" />
              <form action={setInvoiceStatusAction} className="flex flex-wrap gap-2">
                <input type="hidden" name="id" value={invoice.id} />
                {Object.values(INVOICE_STATUS)
                  .filter((s) => s !== invoice.status)
                  .map((s) => (
                    <button
                      key={s}
                      name="status"
                      value={s}
                      className="rounded-lg border border-line-strong bg-surface px-3 py-1.5 text-sm font-semibold text-ink-700 hover:bg-ink-50"
                    >
                      Mark {INVOICE_STATUS_LABELS[s]}
                    </button>
                  ))}
              </form>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Manual check**

Run: `npm run dev`. Revisit the Task 10 flow end to end: create an invoice, land here,
confirm the line table and total match what the create-form previewed, mark it Paid,
confirm the badge updates and the included load shows Paid on `/loads/[id]`.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(app)/invoices/[id]/page.tsx"
git commit -m "Add /invoices/[id]: line items, total, status controls"
```

---

### Task 12: Load detail page — adjustments, Final Load Amount, invoice link

**Files:**
- Modify: `src/app/(app)/loads/[id]/page.tsx`
- Create: `src/components/adjustment-manager.tsx`

**Interfaces:**
- Consumes: `listLoadAdjustments` (Task 4), `finalLoadAmount` (Task 3), `invoiceForLoad`
  (Task 6), `addAdjustmentAction` (Task 4), `ADJUSTMENT_KIND_LABELS`/`_TONE` (Task 2).

- [ ] **Step 1: Write the client component**

Create `src/components/adjustment-manager.tsx`, mirroring `document-manager.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { addAdjustmentAction, type AdjustmentState } from "@/lib/load-adjustment-actions";
import { ADJUSTMENT_KIND_LABELS, ADJUSTMENT_KIND_TONE, type AdjustmentKind } from "@/lib/constants";
import { formatDateTime } from "@/lib/format";
import { Badge, Banner, EmptyState } from "./ui";

type AdjustmentRow = {
  id: number;
  kind: AdjustmentKind;
  description: string;
  amount: number;
  created_at: string;
};

export function AdjustmentManager({
  loadId,
  adjustments,
  canAdd,
}: {
  loadId: number;
  adjustments: AdjustmentRow[];
  canAdd: boolean;
}) {
  const [state, action, pending] = useActionState<AdjustmentState, FormData>(addAdjustmentAction, {});
  const money = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });

  return (
    <div className="space-y-4">
      {adjustments.length === 0 ? (
        <EmptyState title="No adjustments" description="Detention, lumper fees, a negotiated TONU amount — added here." />
      ) : (
        <table className="w-full border-collapse text-sm">
          <tbody>
            {adjustments.map((a) => (
              <tr key={a.id} className="border-b border-line/70 last:border-0">
                <td className="py-2 pr-3">
                  <Badge tone={ADJUSTMENT_KIND_TONE[a.kind]}>{ADJUSTMENT_KIND_LABELS[a.kind]}</Badge>
                </td>
                <td className="py-2 pr-3 text-ink-900">{a.description}</td>
                <td className="py-2 pr-3 text-right font-mono tnum text-ink-900">{money(a.amount)}</td>
                <td className="py-2 text-right text-xs text-ink-400">{formatDateTime(a.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canAdd && (
        <div className="space-y-3 border-t border-line pt-4">
          <Banner state={state} />
          <form action={action} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="load_id" value={loadId} />
            <div>
              <label className="label" htmlFor="kind">Kind</label>
              <select id="kind" name="kind" defaultValue="extra_pay" className="field" required>
                {Object.entries(ADJUSTMENT_KIND_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
            <div className="min-w-[10rem] flex-1">
              <label className="label" htmlFor="description">Description</label>
              <input id="description" name="description" type="text" className="field w-full" placeholder="Detention, lumper fee…" required />
            </div>
            <div className="w-32">
              <label className="label" htmlFor="amount">Amount</label>
              <input id="amount" name="amount" type="number" step="0.01" min="0.01" className="field w-full" required />
            </div>
            <button
              type="submit"
              disabled={pending}
              className="rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
            >
              {pending ? "Adding…" : "Add"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Wire it into the load page**

In `src/app/(app)/loads/[id]/page.tsx`:

Update the import on line 6 to add `finalLoadAmount`:

```ts
import { finalLoadAmount, getLoad, loadStops, nextStatuses, rpm } from "@/lib/loads";
```

Add new imports after the existing ones (near line 16):

```ts
import { listLoadAdjustments } from "@/lib/load-adjustments";
import { AdjustmentManager } from "@/components/adjustment-manager";
import { invoiceForLoad } from "@/lib/invoices";
import { INVOICE_STATUS_LABELS } from "@/lib/constants";
```

(`INVOICE_STATUS_LABELS` joins the existing `@/lib/constants` import on line 10-13 rather
than a new line — combine them.)

After `const documents = listLoadDocuments(org, id);` (line 38), add:

```ts
  const adjustments = listLoadAdjustments(org, id);
  const invoice = invoiceForLoad(org, id);
  const finalAmount = finalLoadAmount(load);
```

Update the "offered" computation (already changed in Task 2, step 4 — confirm it reads):

```ts
  const offered = nextStatuses(load.status).filter((s) =>
    s === LOAD_STATUS.INVOICED || s === LOAD_STATUS.PAID || s === LOAD_STATUS.CLOSED
      ? mayClose
      : mayManage,
  );
```

In the "Rate" card (lines 121-133), add Final Load Amount and update the subtitle:

```tsx
          {showRates && (
            <Card>
              <CardHeader
                title="Rate"
                subtitle="Rate per mile is calculated from the Final Load Amount — rate plus approved extra pay, minus approved deductions."
              />
              <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
                <Field label="Rate" mono>{money(load.rate)}</Field>
                <Field label="Final Load Amount" mono>{money(finalAmount)}</Field>
                <Field label="Loaded Miles RPM" mono>{r.loaded === null ? null : `$${r.loaded.toFixed(2)}`}</Field>
                <Field label="Total Miles RPM" mono>{r.total === null ? null : `$${r.total.toFixed(2)}`}</Field>
              </dl>
            </Card>
          )}

          {showRates && (
            <Card>
              <CardHeader
                title="Adjustments"
                subtitle="Deductions and extra pay approved for this load — what Final Load Amount is built from."
              />
              <AdjustmentManager loadId={load.id} adjustments={adjustments} canAdd={mayManage} />
            </Card>
          )}
```

In the "Record" card (lines 204-211), add an invoice link when one exists:

```tsx
          <Card>
            <CardHeader title="Record" />
            <dl className="grid gap-y-2">
              <Field label="Brokerage">{load.broker_name}</Field>
              <Field label="Dispatcher">{load.dispatcher_name}</Field>
              <Field label="Created">{formatDate(load.created_at.slice(0, 10))}</Field>
              {invoice && (
                <Field label="Invoice">
                  <Link href={`/invoices/${invoice.id}`} className="font-medium text-brand-700 hover:underline">
                    Invoice #{invoice.id} — {INVOICE_STATUS_LABELS[invoice.status]}
                  </Link>
                </Field>
              )}
            </dl>
          </Card>
```

- [ ] **Step 3: Manual check**

Run: `npm run dev`. Open a Delivered load, add a deduction and an extra-pay adjustment as
a dispatcher, confirm Final Load Amount and both RPM figures update. As an admin, create a
dispatch invoice including this load (Task 10/11), then revisit the load page and confirm
the Record card links to it.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/loads/[id]/page.tsx" src/components/adjustment-manager.tsx
git commit -m "Show adjustments, Final Load Amount, and invoice link on the load page"
```

---

### Task 13: Tenant-lifecycle test coverage for the three new tables

**Files:**
- Modify: `tests/tenant-lifecycle.test.ts`

**Interfaces:**
- Consumes: nothing new — extends the existing fixture and assertions.

The drift-guard test added in Task 1 (`"every tenant-owned table is exported and deleted
with the tenant"`) proves `OWNED` and `TENANT_TABLES` stay in sync structurally. It does
**not** prove deletion or the neighbour-isolation check actually *works* for these tables
— `load_documents` had exactly this gap until BUGS.md's 2026-09-02 entry: the fixture
seeded no loads at all, so the assertion passed without ever exercising the code.

- [ ] **Step 1: Find the existing seed fixture**

Locate the block in `tests/tenant-lifecycle.test.ts` that seeds a load and a document per
organisation (added for the `load_documents` fix — grep for `load_documents` in this
file). Extend it, per organisation, to also insert:

```ts
db.run(
  `INSERT INTO load_adjustments (organization_id, load_id, kind, description, amount, created_at)
   VALUES (?, ?, 'extra_pay', 'Detention', 150, ?)`,
  [orgId, loadId, now],
);
db.run(
  `INSERT INTO invoices (organization_id, invoice_type, carrier_id, status, issued_on, total_amount, created_at, updated_at)
   VALUES (?, 'dispatch', ?, 'pending', ?, 15, ?, ?)`,
  [orgId, carrierId, now.slice(0, 10), now, now],
);
const invoiceId = db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
db.run(
  `INSERT INTO invoice_lines (organization_id, invoice_id, load_id, final_load_amount, fee_basis, fee_rate, amount, created_at)
   VALUES (?, ?, ?, 150, 'flat', 15, 15, ?)`,
  [orgId, invoiceId, loadId, now],
);
```

- [ ] **Step 2: Extend the "neighbour untouched" and export/deletion-count assertions**

Wherever this file currently tracks table names for the "deleting one tenant leaves the
neighbour intact" assertion and for `deletionPlan`/`exportOrganization` row counts, add
`"load_adjustments"`, `"invoices"`, `"invoice_lines"` alongside the existing
`"load_documents"`/`"loads"` entries, following the same pattern that test already uses.

- [ ] **Step 3: Run and verify it would have caught the analogous bug**

Run: `node --conditions=react-server --test tests/tenant-lifecycle.test.ts`
Expected: PASS. As a sanity check, temporarily remove the `del("invoices", ...)` line
added in Task 1 and re-run — expect a `FOREIGN KEY constraint failed` failure (invoices
reference the carrier being deleted), confirming the test actually exercises the code path
before restoring the line.

- [ ] **Step 4: Commit**

```bash
git add tests/tenant-lifecycle.test.ts
git commit -m "Exercise invoicing tables in the tenant export/deletion tests"
```

---

### Task 14: HTTP-level permission checks for `/invoices`

**Files:**
- Modify: `tests/http/app.test.ts`

**Interfaces:**
- Consumes: `startApp`, `Harness` (`tests/http/harness.ts`) — `app.get(path, cookie)`,
  `app.session(email)`. No POST support in the harness, so these are GET-only: page-level
  auth (redirect/404) and cross-tenant body-content isolation, the same shape as the
  existing `/support` and carrier-detail tests.

- [ ] **Step 1: Seed fixtures**

In the shared `before()` block (or a new one scoped to these tests, matching how the
existing document-download test adds its own fixtures), seed via `seedOrg` + direct
`db.run`: one organisation with a dispatcher and an admin, a carrier with
`percentage_per_load` pricing, a Delivered load, and one dispatch invoice. Capture
`app.session(email)` for both roles.

- [ ] **Step 2: Write the tests**

```ts
test("a dispatcher can view invoices but not create one", async () => {
  const list = await app.get("/invoices", dispatcherSession);
  assert.equal(list.status, 200);

  const create = await app.get("/invoices/new", dispatcherSession);
  assert.equal(create.status, 307, "redirected away from the create screen");
  assert.match(create.location ?? "", /\/invoices$/);
});

test("an admin can reach the create screen", async () => {
  const res = await app.get("/invoices/new", adminSession);
  assert.equal(res.status, 200);
});

test("an unauthenticated visitor is sent to sign in", async () => {
  for (const path of ["/invoices", "/invoices/new", `/invoices/${seededInvoiceId}`]) {
    const res = await app.get(path);
    assert.equal(res.status, 307);
    assert.match(res.location ?? "", /\/login/);
  }
});

test("one tenant cannot open another tenant's invoice", async () => {
  const res = await app.get(`/invoices/${seededInvoiceId}`, outsider);
  assert.equal(res.status, 404);
  assertNoVictimData(res.body, `/invoices/${seededInvoiceId}`);
});
```

(The last case reuses this file's existing `outsider` session and `assertNoVictimData` —
add the seeded carrier's distinguishing name to the `VICTIM` array, or seed the invoice
fixture under the existing `victimOrg`/`victimCarrier` rather than a new organisation, so
the established secret-string check covers it for free.)

- [ ] **Step 3: Run**

Run: `npm run test:http`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add tests/http/app.test.ts
git commit -m "HTTP-level auth coverage for /invoices"
```

---

### Task 15: Docs — close out Phase 15

**Files:**
- Modify: `Plan.md`
- Modify: `HANDOFF.md`

**Interfaces:** none — documentation only, required by AI Rules §10 ("Finishing a phase
means updating `Plan.md` in the same change").

- [ ] **Step 1: Update `Plan.md`**

In the Phase 15 section, change:

```
- [ ] Invoicing — blocked on the two invoice samples (owner-operator, two-driver) requested
      from the client.
```

to a checked, dated entry describing what shipped and what's explicitly deferred (freight
invoices, batching UI beyond manual selection, PDF layout) — pointing at
`docs/superpowers/specs/2026-09-02-invoicing-design.md` for the reasoning, matching how
the Load Documents entry points at its own design doc. Update the phase's overall status
marker (🔨 → ✅) if this was the only remaining item, and the test count in the phase
summary and the top-of-file legend if this repo tracks a running total there.

- [ ] **Step 2: Update `HANDOFF.md`**

Remove the "blocked on invoice samples" framing from the Next/State sections; note that
Phase 15 is complete, what the dispatch invoice module does and does not cover (freight
invoices, batching UI, PDF layout — same list as Plan.md), and the current test count.

- [ ] **Step 3: Full verification pass**

```bash
npm test
npm run test:http
npx tsc --noEmit
npm run build
```

Expected: all green, matching or exceeding the 333 unit + 11 HTTP baseline recorded in the
last handoff, plus every test added in Tasks 1-14.

- [ ] **Step 4: Commit**

```bash
git add Plan.md HANDOFF.md
git commit -m "Close out Phase 15: dispatch invoicing shipped"
```

---

## Self-review notes

**Spec coverage:** §1 (scope) → Task 1's `invoice_type` column, nothing built for freight
invoices. §2 (math) → Tasks 1/3/6/7. §3 (owner-operator/fleet) → no build item, confirmed
no schema change needed (existing carrier/driver model already covers it). §4 (batching) →
Tasks 7/10 (`loadIds: number[]`, one invoice per selection, not one-per-load). §5
(factoring/remit-to) → deliberately not built; documented in the spec why and where it
lands later. §6 (workflow) → Task 2 (`paid` status) + Task 7 (`setInvoiceStatus` driving
load status forward, never backward).

**Type consistency check:** `finalLoadAmount`'s input shape
(`Pick<LoadRow, "rate" | "exception" | "adjustments_net">`, Task 3) matches every call
site — `rpm()` (Task 3), `createInvoice` (Task 7, via `getLoad`), the `/invoices/new` page
(Task 10, via `listInvoiceableLoads`'s `LoadRow[]`). `computeDispatchFee`'s carrier shape
(`{pricingType, rate, percentage}`, Task 6) matches its two call sites (Task 7's
`createInvoice`, Task 10's probe). `InvoiceStatus` values (`pending`/`paid`/`disputed`,
Task 2) match every usage in Tasks 7/8/9/11. `AdjustmentKind` values
(`deduction`/`extra_pay`, Task 2) match Task 4's validation and Task 12's component.
