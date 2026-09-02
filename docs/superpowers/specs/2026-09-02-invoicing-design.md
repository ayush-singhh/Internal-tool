# Invoicing — Design

Answers the six-point question list sent to Asterism's founder (see `HANDOFF.md` /
`Plan.md` Phase 15). This is the spec; `docs/superpowers/plans/2026-09-02-invoicing.md`
is the task-by-task plan that implements it.

## 1. Scope: which invoice

Two invoice concepts exist in the business and both get a place in the data model, but
only one gets built now:

- **Asterism → Carrier dispatch invoice** — Asterism's fee for dispatch service. Builds
  in full this phase.
- **Carrier → Broker freight invoice** — the freight bill for the load, which Asterism
  may prepare/submit on the carrier's behalf. **Not built.** The schema leaves room
  (`invoices.invoice_type`) so it can be added later without a rebuild, per the explicit
  ask — no UI, no computation, no CRUD for it ships in this phase.

## 2. The math

**Final Load Amount** = Load Amount (`loads.rate`, the negotiated linehaul) + approved
extra pay − approved deductions. Deadhead is never auto-billed; it is analytics only.

A **TONU or cancelled** load gets no automatic linehaul billing — its Final Load Amount
is whatever was explicitly approved (entered as an extra-pay adjustment), never `rate`.
This is one rule, not two: `finalLoadAmount()` treats `rate` as inapplicable exactly when
`exception` is `tonu` or `cancelled`, and returns `null` (no billable amount at all) only
when neither a rate nor any adjustment exists.

**RPM is redefined**: `RPM = Final Load Amount ÷ Total Miles` (loaded and total variants,
as today) — no longer raw `rate ÷ miles`. It stays a display/analytics figure, never
shown to a driver, computed rather than stored.

**Dispatch fee** = the carrier's configured pricing arrangement applied to Final Load
Amount:
- `pricing_type = percentage_per_load` → `percentage% × Final Load Amount`
- `pricing_type = flat_per_load` (**new** lookup value — the existing types are
  `fixed_monthly`/`fixed_weekly`, which are periodic, not tied to one load) → the
  carrier's flat `rate`
- any other pricing type → invoicing refuses with a clear error; that carrier's
  arrangement isn't structured for automatic per-load billing yet

No new carrier columns: `pricing_type_id`, `rate`, `percentage` already hold exactly this
shape (Architecture.md's Commercial section), added to for one new vocabulary value.

## 3. Invoice shape / owner-operator vs fleet

The two sample documents are layout references only, never obtained — no client
response arrived, and the shape of the printed invoice is not the blocking question
(this spec doesn't produce a PDF/print layout; that's a follow-on if requested). The
business distinction that matters — owner-operator (customer = driver) vs fleet (customer
≠ driver) — already exists in the carrier/driver model and needs no invoice-specific
change. Multi-driver loads stay a schema note, not a build item: `loads.driver_id` is
already nullable/single; a genuine team-driver second column is added only if the
business is shown to need it, per the client's own answer.

## 4. One invoice per load, or batching

Both, via one shape: `invoices` (header) + `invoice_lines` (one row per included load,
amounts snapshotted at creation). A single-load invoice is simply an invoice with one
line. Batching is same-carrier only — an invoice belongs to one carrier
(`invoices.carrier_id`), never mixed. No date-range/weekly auto-batch job ships now (the
dispatcher picks loads by hand on the create screen); the schema doesn't block adding one
later.

## 5. Remit-to / factoring

Not modeled as new invoice fields this phase. For the Asterism → Carrier dispatch
invoice, the payee is always Asterism itself (the tenant) — there is no "who gets paid"
choice to store. What *does* vary per carrier — factoring vs direct ACH vs wire vs
check vs quick pay — is already `carriers.invoice_mode_id`, and it governs *when* the
dispatch fee is actually payable (the agreement: due after the carrier is paid by
shipper/broker/factor), which this phase does not enforce as a gate, only as a fact
already visible on the carrier record. Remit-to/payee as a first-class field on
`invoices` is exactly the kind of thing the Carrier → Broker freight invoice will need
(broker pays the carrier vs. the carrier's factor) — deferred to that invoice type,
consistent with §1.

## 6. Status workflow

Load status gains one value: **Delivered → Invoiced → Paid → Closed** (`LOAD_STATUS`
already had Delivered/Invoiced/Closed; `paid` is inserted between the last two). Forward
only, like every other load status transition — nothing here walks a load backward.

- **Invoiced**: set automatically when a load is included in a created dispatch invoice
  (creating the invoice *is* "the invoice has been generated"). The existing manual
  "Mark Invoiced" control (admin-only, `load:close`) is untouched, for a load handled
  outside the invoice flow.
- **Paid**: set automatically, for every included load, when its invoice is marked Paid.
  Not set by "invoice sent" — only by the invoice's own status actually reaching Paid.
- **Closed**: unchanged, a separate manual step (`load:close`) — administratively done,
  not implied by payment.

The invoice's own status (`pending` / `paid` / `disputed`) is a free three-state field,
not forward-only — an admin can move a mistaken Paid back to Pending or on to Disputed.
That correction never walks the load status backward (the load stays Paid); this
asymmetry is deliberate, matching how a wrongly-Delivered load is corrected by a note and
an exception flag, never by un-delivering it.

**POD requirement**: already enforced by the existing flow — POD upload moves a load to
Delivered, and only a Delivered load is eligible for invoicing (`status = delivered` is
the eligibility filter for the create-invoice screen).

## Permissions

Two new actions, both following the existing `load:rate` / `load:close` split:

- `invoice:view` — universal to any non-sales/non-support role, same scope as `load:rate`
  ("everyone who can see a load can see what it pays").
- `invoice:manage` — create an invoice, change its status. Administrators only, same
  rationale as `load:close`: there's no dispatcher tier for invoicing at all here, so one
  action covers the whole lifecycle rather than splitting create from status-change.

## What's explicitly not built

- Carrier → Broker freight invoices (line-itemized linehaul + deductions as a customer-
  facing document, factoring remit-to) — schema seam only (§1, §5).
- Date-range/weekly auto-batching — manual load selection only (§4).
- A printable/PDF invoice layout — no sample ever arrived to design against (§3).
- Voiding a created invoice — correcting one is `pending`/`paid`/`disputed` only; a
  wrongly-created invoice is a rare admin/support correction out of band, the same
  category as other emergency corrections in `Architecture.md`.
