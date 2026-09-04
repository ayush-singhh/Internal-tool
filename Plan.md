# Build Plan

Ten phases. Each is a working, verifiable slice — nothing is left as a stub for a later
phase to finish. Status is updated as part of the phase it describes.

Legend: ✅ done · 🔨 in progress · ⬜ not started

**Phases 0–17 complete.** 386 unit + 20 HTTP tests passing, production build clean,
permission matrix verified over HTTP for every role. Phases 16–17 are the first two of
seven sub-projects decomposed from the client's three-panel spec — see the decomposition
table under Phase 16.

---

## Phase 0 — Foundation ✅

- [x] Next.js 16 + React 19 + TypeScript + Tailwind v4 scaffold
- [x] Docs: `PRD.md`, `Architecture.md`, `AI Rules.md`, `Plan.md`

## Phase 1 — Database & Authentication ✅

- [x] Controlled vocabularies in `src/lib/constants.ts`
- [x] SQLite schema via `node:sqlite` — users, lookups, carriers, notes, activity,
      offboarding, settings, saved filters, sessions
- [x] Idempotent seed: lookups, default settings, first admin user
- [x] scrypt password hashing (`src/lib/password.ts`) — superseded by argon2id in Phase 12
- [x] Session create/verify/destroy, `requireUser()`, role permission helpers
      (`src/lib/auth.ts`, `src/lib/permissions.ts`)
- [x] Login page with split brand panel + first-run credential hint
- [x] Tests: password round-trip, full permission matrix — **8/8 passing**
- [x] Design tokens in `globals.css` (moved forward from Phase 2)

## Phase 2 — Application Shell ✅

- [x] Design tokens in `globals.css` (palette, spacing, shadows, typography)
- [x] Dark sidebar, grouped nav, active state, live count badges per section
- [x] Top bar: global search, Add Carrier, mobile menu
- [x] Responsive: fixed rail on desktop, overlay drawer under `lg`
- [x] Shared primitives: `Badge`, `Card`, `CardHeader`, `PageHeader`, `EmptyState`, `Field`
- [x] Inline monoline icon set (no icon dependency)
- [x] Request-cached lookup loader (`src/lib/lookups.ts`)
- [x] Verified: `/` redirects to `/login` unauthenticated, renders the shell with a session

## Phase 3 — Carrier Database ✅

- [x] `listCarriers()` — search, 11 filters, 2 date ranges, sort allow-list, pagination
- [x] Carrier table: 28 columns, sortable headers, status badges, sticky name column,
      review-flag markers
- [x] Quick status filter row (All + 7 statuses)
- [x] Advanced filter panel
- [x] Global search across name, owner, phone, email, MC, USDOT, address, serial —
      matches a phone whether typed formatted or as digits
- [x] Column visibility picker persisted in a cookie so the server still renders the table
- [x] Saved filters (create, recall, delete — scoped to the owner)
- [x] Preset views: Active, Onboarding, Offboarded, Investigations
- [x] CSV export of the filtered set (32 columns, formula-injection safe) — brought
      forward from Phase 8 so the toolbar button was never a dead link
- [x] Tests: 9 CSV parser/serializer edge cases — **17/17 passing overall**
- [x] Verified against SQL truth: every preset and filter count matches the database
- [x] `npm run build` clean

### Fixed during this phase
- DB connected at module evaluation, so `next build`'s 9 workers raced to seed it
  → connection is now lazy, with `busy_timeout`
- Index creation ran before column migrations → indexes now run after `migrate()`
- A Client Component transitively imported the DB layer (caught by `server-only`)
  → pure types split into `src/lib/carrier-types.ts`
- `ORDER BY ... DESC COLLATE NOCASE` is invalid SQLite → collation now precedes direction
- A corrupt column cookie collapsed the table to one column → falls back to defaults

## Phase 4 — Carrier Profile ✅

- [x] Profile page: Overview, Contact, Regulatory & Equipment, Onboarding, Commercial, Record
- [x] Offboarding section rendered only for exited carriers — verified absent on active ones
- [x] Internal notes — add, list, attribute, timestamp, mark important (pins + logs)
- [x] Activity history timeline with date, time, user and old → new value diffs
- [x] Review-flag banner for import-flagged records
- [x] Write logic split from Server Actions (`notes.ts` vs `note-actions.ts`) so it is
      testable without request context — the pattern Phase 5 reuses for carrier writes
- [x] Tests: 8 note/activity cases against a throwaway database — **25/25 passing overall**

## Phase 5 — Add / Edit Carrier ✅

- [x] Nine-section create form — 12 dropdowns, 3 date pickers, no free-text vocabularies
- [x] Smart behaviour: pricing type reveals only the relevant money field and sets the
      billing frequency; new carriers default to About to Be Active / Pending agreement /
      today's onboarding date; the creator is pre-assigned to their own role slot
- [x] Server-side validation for every rule in PRD §5, shared by form and import
- [x] Edit form pre-filled from the record; a patch never blanks untouched fields
- [x] Duplicate MC/USDOT warning listing the existing carrier with a link, requiring an
      explicit "this is a different carrier" confirmation to proceed
- [x] Field-level diffing into activity history, typed per change
      (status / assignment / pricing / agreement / subscription / field)
- [x] Editing a flagged record clears its review flag
- [x] Tests: 29 new cases — validation rules, real FormData round trip, duplicate
      detection, patch isolation, activity typing — **54/54 passing overall**
- [x] `npm run build` clean

## Phase 6 — Status & Offboarding ✅

- [x] Status change action with an automatic, attributed activity entry
- [x] Offboarding workflow opens automatically for Inactive / Suspended / Blacklisted /
      Carrier Back-off, inside the same dialog and the same submission
- [x] Full capture: date, reason, category, handler, final status, last load date,
      outstanding balance, subscription cancelled, agreement closed, can return, notes
- [x] Cancelling the subscription in the workflow updates the carrier's subscription field
- [x] Re-running the workflow revises the record rather than duplicating it
- [x] Reactivation path logged as its own activity type, keeping the offboarding record
- [x] Native `<dialog>` — focus trapping, Esc-to-close and backdrop with no library
- [x] Tests: 11 cases — **65/65 passing overall**, verified stable over 5 consecutive runs
- [x] **Guaranteed by test: offboarding never deletes a carrier** — the record survives,
      stays searchable, appears under Offboarded, and leaves the Active count

## Phase 7 — Dashboard ✅

- [x] Eleven live metric tiles — **each verified equal to its own SQL count**
- [x] Seven charts as inline SVG/CSS: status, dispatcher, account manager, lead source,
      plan, pricing, plus onboarding and offboarding 12-month trends
- [x] Recent Activity feed across all carriers
- [x] Needs Attention queue — 8 rules, thresholds read from Settings, empty rules omitted
- [x] Tests: 11 cases including threshold changes moving items in and out of the queue
      — **76/76 passing overall**
- [x] `npm run build` clean

### Chart colour decision
Ran the palette validator rather than eyeballing it. Encoding the seven statuses as
seven hues **failed**: purple↔blue separate by ΔE 1.3 for deuteranopia (indistinguishable),
and orange↔amber by 6.7 even with full colour vision. So the charts do not encode identity
in colour at all — every bar is one validated hue (`#3a67ac`: passes lightness band,
chroma floor and 3:1 contrast) and identity comes from the direct text label on each row.
The small status dot beside a label echoes the badge language used elsewhere but is never
the only carrier of meaning.

## Phase 8 — Reports & Export ✅

- [x] Thirteen reports grouped as Team / Portfolio / Commercial / Movement
- [x] Date filtering, applied to the date that actually matters per report — offboarding
      reports filter on when a carrier *left*, not when it joined
- [x] Reports that describe the present (active workload) say so instead of pretending
      the date range applies
- [x] Every report renders as a chart **and** a table, so no figure is gated behind colour
- [x] CSV export of any report; CSV export of the filtered carrier list (Phase 3)
- [x] Tests: 12 cases including a CSV round trip over **all thirteen** reports
      — **88/88 passing overall**
- [x] `npm run build` clean

## Phase 9 — Import ✅

- [x] Four-step wizard: upload → map → review → done. The file is parsed in the browser,
      so mapping is instant and nothing reaches the server until you ask for a preview
- [x] Delimiter sniffing (comma, semicolon, tab, pipe) and BOM handling
- [x] Column mapping with auto-suggested matches from 27 target fields and ~120 header
      aliases; a field can only be claimed once
- [x] Row-by-row preview with per-row errors and flags — **preview writes nothing**
- [x] Duplicate MC/USDOT detected against the database *and* within the file itself,
      with skip / update / create handling
- [x] Unmatched vocabulary values preserved verbatim and flagged, never guessed
- [x] Commit runs in one transaction — a failure leaves nothing behind
- [x] Tests: 22 cases — **110/110 passing overall**
- [x] `npm run build` clean

### Bug found and fixed by these tests
`"Mar 4, 2025"` imported as **2025-03-03**. `new Date("Mar 4, 2025")` yields *local*
midnight, and `toISOString()` then rolls the calendar day backwards in any timezone east
of UTC — which would have silently shifted every named-month date in the real migration.
Now rebuilt from local components and verified identical across UTC-8 → UTC+14.

## Phase 10 — Team & Settings ✅

- [x] Team list with role, active state and live assigned-carrier counts
- [x] Create / edit / deactivate / reactivate a team member, set a password (admin only)
- [x] **The last active administrator cannot be deactivated or demoted** — the lockout guard
- [x] Deactivating revokes sessions immediately but keeps the account and its history,
      and leaves their carriers assigned until someone reassigns them
- [x] Changing your own password keeps you signed in here and signs out everywhere else
- [x] Settings: Needs Attention thresholds and company name, with validation and
      "restore defaults"
- [x] Settings: retire / restore any dropdown value, with usage counts — a retired value
      disappears from new records but stays on the carriers already using it
- [x] Tests: 16 cases — **126/126 passing overall**
- [x] Permission matrix verified end to end over HTTP across all four roles
- [x] `npm run build` clean
- [x] README written for the people who have to run this

---

## Post-build: driven in a real browser

Launched the app and drove it end to end with headless Chromium — signing in through the
actual login form (every earlier check had injected a session row directly), then walking
login → dashboard → table → filters → profile → note → status/offboarding dialog →
add carrier → validation → reports → team → settings → import → mobile → sign-out.
**Zero console or network errors.** A full CSV import was completed through the UI:
3 created, 0 failed, 1 flagged, 46 → 49 carriers.

### Two real bugs this found, both fixed

**1. Custom CSS was unlayered, silently overriding Tailwind utilities app-wide.**
Unlayered CSS beats every `@layer`, so `.field` won against utilities like `pl-8` and
`w-36` wherever they touched the same property — visibly, the search placeholder sat
underneath the magnifier icon. Moved `globals.css` into `@layer base / components /
utilities`, restoring normal precedence. Verified: padding-left 11.2px → 32px.

**2. Every dropdown lost its value when a submit was rejected.**
React resets the form after a form action completes, and that reset lands *after* the
re-render. A text input survives it (`defaultValue` is a real DOM property React
re-applies with the echoed value) and an uncontrolled `<select>` is restored to its
`defaultValue` — but a *controlled* select is reset to its first option while React still
believes it holds the old value, so React sees no change and never corrects it. Someone
fixing a duplicate MC number would silently lose their plan, pricing type and billing
frequency. Every select is now uncontrolled, with the billing-frequency auto-fill driven
through a ref. Verified: all 8 fields survive a rejected submit.

Two further "failures" turned out to be faults in the test driver, not the app — a probe
that fought the browser's own email validation, and a row count read before navigation
finished. Both re-checked and correct.

## Phase 12 — Multi-tenant SaaS (Option B) 🔨

Committed to a shared app with strict per-tenant isolation. See `Architecture.md` §Multi-tenancy
and `MIGRATION-PLAN.md`.

### Phase 2 of the rollout — data-layer tenant isolation ✅
- [x] `organizations` table; `organization_id` on all 8 tenant-owned tables (migration 5)
- [x] Composite foreign keys — the database refuses cross-tenant references (migration 6, Layer 1)
- [x] Fail-closed query guard in `db.ts`; `systemQuery()` for global tables (Layer 2)
- [x] `Org` threaded from the session into all ~56 query sites (Layer 3); 24 modules + all
      pages/actions/components/routes converted
- [x] Per-tenant vocabularies and settings; per-tenant email uniqueness
- [x] Per-tenant provisioning (`provision.ts`); owner role; tenant-aware seed & migration
- [x] Table classification documented in `Architecture.md`
- [x] Existing-data migration backfills one org unambiguously; refuses ambiguous data
- [x] **Adversarial cross-tenant suite — 16 attacks, all denied** (`tests/cross-tenant.test.ts`)
- [x] **170 tests passing**, `npm run build` clean

### Password hashing — scrypt → argon2id ✅
- [x] `password.ts` hashes with Argon2id (`@node-rs/argon2`, OWASP defaults m=19456, t=2, p=1)
- [x] Pre-existing scrypt hashes still verify — nobody is locked out by the change
- [x] `signIn()` re-hashes a legacy hash on the next successful login (`needsRehash()`)
- [x] Tests: legacy verify + rehash flagging + the guard accepts the in-place upgrade —
      **172 passing**; `npm run build` clean

### Two-factor authentication (TOTP) ✅
- [x] Migration 7: `users.mfa_secret/mfa_activated_at/mfa_last_step`, `sessions.mfa_pending`,
      `mfa_recovery_codes`
- [x] `totp.ts` — RFC 6238 in ~40 lines of `node:crypto`, pinned to the RFC's own vectors
- [x] Enrolment confirmed by a code before it activates; QR rendered server-side to a
      `data:` URI, so the secret is never shipped as text to an unenrolled browser
- [x] Ten single-use recovery codes (80 bits, SHA-256 stored), shown exactly once
- [x] Replay prevention — a time step is accepted once; codes rate-limited on the existing
      login throttle
- [x] Pending sessions: a password on an enrolled account opens nothing until the code
- [x] `login.ts` split out of `auth.ts` so the sign-in rules are testable (AI Rules §8) —
      which also covers the argon2 rehash-on-login path
- [x] Fixed on the way: `can()` never knew the `owner` role, so every new tenant's owner
      was locked out of Settings, Team and Import
- [x] Tests: **198 passing**; verified over HTTP that a pending session opens no page

### Self-serve signup + email verification ✅
- [x] Migration 8: `users.email_verified_at` (existing accounts backfilled as confirmed),
      `email_verifications` tokens
- [x] `mailer.ts` — SMTP over `node:tls` (implicit TLS/465, AUTH PLAIN), header-injection
      safe, base64 bodies; logs the message in development instead of sending
- [x] `signup.ts` — organisation + owner + vocabularies via `provision.ts`, confirmation
      link, and the same answer for every address so the form cannot enumerate customers
- [x] Signing up again with an unconfirmed address is the resend; only the newest link works
- [x] Sign-in refuses an unconfirmed account without locking it out
- [x] `SIGNUP_OPEN=1` gates the route; `src/instrumentation.ts` refuses to serve a
      production build that opens signup with no `SMTP_URL` / `MAIL_FROM` / `APP_URL`
- [x] Per-IP signup throttle (3/hour), kept out of the administrator's failed-sign-in list
- [x] One address belongs to one organisation — checked in `signup.ts` and `team.ts`
- [x] Tests: **216 passing**, including the SMTP conversation against a fake relay;
      verified over HTTP that the link confirms an account and the closed route 404s

### Still to do (later phases)

0. [x] ~~**AUTOMATED OFF-BOX BACKUPS**~~ — a timer in `instrumentation.ts` (daily,
       `BACKUP_EVERY_HOURS`), each snapshot reopened and verified, then uploaded to any
       S3-compatible store via hand-rolled SigV4 (`BACKUP_S3_URL`). `scripts/restore.ts`
       verifies before replacing and keeps the old database. **The restore was rehearsed
       against a real database with every carrier deleted; all 46 came back.** Fixed on
       the way: minute-resolution filenames made two backups in one minute fail with a raw
       SQLite error. **249 tests.**

Then, in this order, and why — see `HANDOFF.md` for the same list with the reasoning:

1. [x] ~~**Self-serve password reset**~~ — `/forgot` asks for a link, answering the same
       way for every address; limited per address and per host; the administrator's link is
       now mailed where a relay is configured and only handed over where one is not; and
       consuming a link confirms an unconfirmed address, so signing up and forgetting is no
       longer a permanent dead end. **221 tests.**
2. [x] ~~**Invitations**~~ — adding a member now sends a link instead of inventing a
       password. No new table: an invitation is a member with no confirmed address and an
       unguessable password, shown as *Invited* until they accept. **224 tests.**
3. [x] ~~**Security headers / CSP**~~ — `src/proxy.ts` sets a nonce-per-request CSP with
       `'strict-dynamic'` (no inline scripts at all), plus HSTS, nosniff, frame-ancestors,
       referrer and permissions policies. The policy itself lives in
       `src/lib/security-headers.ts` as data, asserted by test so it cannot quietly rot.
       **231 tests.**
4. [x] ~~**Platform support role**~~ — `/support`, read-only by construction (no forms, no
       actions), every view recorded in `support_access_log`, second factor required, and
       the role ungrantable from inside any organisation. **238 tests.**
5. [x] ~~**RBAC UI**~~ — this was already built and the item was stale: the Team page
       assigns roles, invites, deactivates and resets, and `can()` is the single matrix.
       What was genuinely missing was found while checking: `updateTeamMember` checked
       email uniqueness only within one organisation while creation checked globally, so
       an **edit** could still produce the ambiguous sign-in that creation refuses. Fixed.
6. [x] ~~**Session hardening**~~ — Settings lists every live session with the browser it
       was issued to, its address and when it was last used, marks the current one, and
       ends one or all others. **258 tests.**
7. [x] ~~**Generalised audit log**~~ — `audit_log` records sign-ins, lockouts, MFA and
       password changes, invitations, role changes, deactivations and every CSV export;
       readable at `/audit`, append-only, and it outlives the accounts it names. Export is
       rate-limited per person. **266 tests.**

- [x] Demo seeder made tenant-aware — it creates its own organisation via `provision.ts`
      instead of writing unscoped rows the guard now refuses; `DEPLOY.md` covers putting
      the app in front of a client
- [x] ~~**Recovery codes can be regenerated**~~ — a "Get new recovery codes" action in
      Settings, gated on the same proof `disable` requires, replaces the whole set in one
      transaction and shows the new ten once. **269 tests.**
- [x] ~~**Server errors are no longer invisible**~~ — Next's `onRequestError` hook writes
      every uncaught server error to `error_log` (message, digest, path, method, route
      type), surfaced on `/support` for the one audience that already sees across tenants.
      Node-only; a proxy-level error on the Edge runtime isn't caught. **273 tests.**
- [x] ~~**Billing decision, settled**~~ — manual invoicing. Reused `organizations.status`
      (existed since migration 5, unused) rather than a new column; `ORG_STATUS` gives it
      trial/active/past_due/suspended; set only by `npm run set-billing-status`, out of
      band like `support-user.ts`, never from `/support` itself, which stays read-only.
      No enforcement — a label to read, not a gate.

## Phase 13 — Audit, and the gaps it exposed ✅ (2026-08-30)

Not a planned phase. A review of finished work found two critical defects, and closing
them made it obvious that the test suite could not have caught either. Full write-ups,
including the trap behind each, are in `BUGS.md`.

### Two critical bugs, both fixed
- [x] **`/support` was authorised only by its layout** — a layout cannot refuse a request,
      so every page under it served another tenant's data in the body of a 404. Any
      signed-in customer could read every organisation, every carrier and every note on
      the deployment. `requireSupport()` is now called by each page for itself.
- [x] **The tenancy migrations destroyed data** — `PRAGMA foreign_keys` is a no-op inside
      a transaction, so migration 6's `OFF` never applied and `DROP TABLE` cascaded.
      Migration 5 failed outright on any real database; migration 6 would have silently
      emptied notes, activity and offboarding records. `migrate()` now switches
      enforcement outside the transaction and asserts `foreign_key_check` per migration.

### Three smaller ones
- [x] Report CSV export gained the rate limit and audit record its sibling route already had
- [x] `offboardingReasons` duplicate deleted — its copy built placeholders and parameters
      by different rules and desynced on an empty bound
- [x] `isFirstRun()` asked a single-tenant question of a multi-tenant deployment

### What the audit exposed, and what was built for it
- [x] **HTTP-level tests** (`npm run test:http`) — every previous test called a `src/lib`
      function directly, which is blind to anything that only exists once Next is
      composing layouts, pages, redirects and status codes. `tests/http/harness.ts` builds
      the app, starts it, and reads what comes back. Proven against the original bug:
      reverting the `/support` fix fails three of the eight.
- [x] **Backup failures are visible** — migration 13 adds `backup_log`; every run records
      `offsite` / `local` / `degraded` / `failed`, surfaced on `/support` and led by the
      last copy that actually reached off-machine storage. A verified snapshot whose
      upload was refused previously looked identical to a success.
- [x] **A tenancy can end** — `npm run export-org` and `npm run delete-org`. Creating an
      organisation had three routes and ending one had none; "send us our data" and
      "delete us" were answered with hand-written SQL. Deletion requires an export first,
      refuses to take platform support accounts with it, and asserts `foreign_key_check`
      inside the transaction so a partial deletion rolls back.
- [x] **The capacity ceiling written down** — `Architecture.md` now states the trigger to
      move off SQLite is concurrent tenants, not carrier count, because `DatabaseSync` is
      synchronous and one slow query delays every tenant.
- [x] **`BUGS.md`** — a ledger, listed in `AGENTS.md`, whose entries lead with *why it was
      missed*. A fix stops one bug; that line stops a category.

## Phase 14 — Carrier insurance expiry ✅ (2026-08-30)

The first feature the PRD never asked for, because the spreadsheet it replaced did not
track it either. For carrier management it is the fact with actual liability attached:
a certificate of insurance lapses, and a load dispatched against it is a claim.

- [x] Migration 14: `carriers.insurance_expires_on`, `carriers.insurance_provider`, and
      an `(organization_id, insurance_expires_on)` index
- [x] Two Needs Attention rules, not one — **Insurance expired** (red, live carriers
      only) and **Insurance expiring soon** (amber, window from Settings). They call for
      different actions, so they are counted and shown separately
- [x] `insurance_expiry_days` in Settings, default 30, alongside the other thresholds
- [x] Threaded the whole way through: form (with validation), profile, edit prefill,
      sortable table column, column picker, CSV export, CSV import with aliases
      (`coi expiry`, `insurance expiration`, …), activity history, and the read-only
      support view
- [x] Two columns rather than a policy table: one date per carrier is what the queue
      needs, and a policy history nobody asked for is a table to keep in step
- [x] **No rule for carriers with no expiry recorded** — every existing carrier is NULL
      on day one, and a queue that opens with hundreds of meaningless rows is a queue
      people learn to ignore. Add one once customers have backfilled
- [x] Five tests covering the split, the today boundary, the Settings window, live-only
      scoping, and that the item names the insurer so the alert can be acted on.
      **287 tests.**

Smaller, whenever they get in the way: none currently.

## Phase 15 — Asterism dispatch domain ✅ (2026-09-02)

New product half, built from scratch on this base — no previous app code exists to port.
Full write-up and reasoning in `HANDOFF.md`.

- [x] Migration 15: `drivers`, `brokers`, `loads`, `load_stops`, tenant-owned with composite
      foreign keys
- [x] Role model: `sales` role added; seven dispatch actions incl. `load:rate` separate
      from `load:view`, `load:close` admin-only, `broker:create` separate from `broker:edit`
- [x] `loads.ts` / `load-write.ts` — RPM, forward-only status flow, multi-stop; `/loads`
      list, `/loads/new`, `/loads/[id]` with status controls
- [x] `dispatch-admin.ts` — drivers and brokers; `/drivers`, `/brokers` screens, add/edit
      split (a dispatcher may add a broker, only an administrator may correct one)
- [x] A driver on an open load cannot be deactivated — guarded server-side and disabled in
      the UI so the failure is never silent
- [x] Tests: 333 passing overall; browser-verified end to end for both new screens
- [x] Documents (RC/BOL/POD, plus an "Other" catch-all) — migration 16, S3-backed via
      `DOCUMENTS_S3_URL` (separate bucket/credentials from `BACKUP_S3_URL`), append-only,
      load-scoped. Design in `docs/superpowers/specs/2026-09-02-load-documents-design.md`.
- [x] Invoicing — the Asterism → Carrier dispatch invoice. No sample ever arrived from the
      client; built from the six-point answer the client gave instead of the two documents
      originally requested. Migration 17: `load_adjustments` (itemized deductions/extra
      pay), `invoices` + `invoice_lines` (amounts snapshotted at creation, not live),
      `flat_per_load` pricing type, backfilled into every existing organisation.
      `loads.status` gains `paid` (Delivered → Invoiced → Paid → Closed). RPM redefined
      around Final Load Amount (rate plus approved extra pay, minus approved deductions —
      a TONU/cancelled load bills only what was explicitly approved, never the raw rate).
      `invoice:view` (universal) / `invoice:manage` (administrators only, whole lifecycle —
      no dispatcher tier). `/invoices`, `/invoices/new` (carrier + load picker with a live
      fee preview), `/invoices/[id]` (line items, status controls); an Adjustments card and
      Final Load Amount on the load page. Design in
      `docs/superpowers/specs/2026-09-02-invoicing-design.md`, plan in
      `docs/superpowers/plans/2026-09-02-invoicing.md`. Browser-verified end to end with
      Playwright. Tests: 355 unit + 15 HTTP passing overall.
      **Deliberately not built** — schema leaves room, no code exists yet: Carrier → Broker
      freight invoices (line-itemized linehaul + deductions as a customer-facing document,
      factoring remit-to/payee), date-range/weekly auto-batching (loads are picked by hand
      on the create screen), a printable/PDF invoice layout.

**Decided:** no HR module; live truck tracking is V2 and only on request (see "Deferred by
design" below).

---

## Phase 16 — Role panels ✅ (2026-09-04)

The client supplied a three-panel menu spec (Admin / Sales Agent / Dispatcher, ~40 feature
areas). Most of it does not exist yet; this phase builds the **frame** the rest hangs on,
and is sub-project **A** of seven — see "Role-panel spec decomposition" below.

- [x] Sidebar is permission-driven. Every item in `NAV_GROUPS` (`src/lib/nav.ts`) names the
      `Action` that reveals it; `visibleNav(user)` filters with `can()` and drops empty
      groups. The three panels are not three lists — they are what is left of one list
      after `can()` runs, so no role is named in a component and a role that gains an
      action gains the page in the same edit.
- [x] **Bug this closed:** `AppShell` previously filtered on a hardcoded list of four
      administration hrefs, so every non-administrator still got Carriers, Dispatch,
      Invoices and Reports — including `sales`, whose definition in `constants.ts` is that
      it sees no carrier, no load and no rate. A `viewer` was also shown an "Add Carrier"
      button it had no permission to use.
- [x] Header's carrier search and Add Carrier button gated on `carrier:view` /
      `carrier:create`, decided in the layout like the rest.
- [x] Dashboard empty state gates its two buttons and its copy the same way — it used to
      lead every role with "Import spreadsheet", pointing a dispatcher at a page
      `import:run` refuses them. Found by the HTTP test, not the unit test: the button is
      not in the nav, so only an assertion against the whole rendered page could see it.
- [x] Dashboard branches on `carrier:view`, not on a role name: a role that cannot see
      carriers gets its own body instead of the carrier metrics. Sales is that role today.
- [x] `/activity` — My Activity, self-scoped by construction (the only id it accepts is the
      session's own), so it needs no permission and every role has a real page on day one.
      `recentActivity()` took an optional `userId` rather than growing a second function.
- [x] `ActivityTimeline` links to the carrier when a row carries `legal_name`, so the same
      component serves a carrier's history and a cross-carrier feed with no flag.
- [x] Tests: `tests/nav.test.ts` pins all three panels at the data layer (9 cases, one of
      them reconstructing the old deny-list so the defect stays executable); three new
      cases in `tests/http/app.test.ts` assert the *rendered* page per role —
      **364 unit + 18 HTTP passing**. tsc and `next build` clean.

**Decided, against the supplied spec:** dispatchers keep carrier access. The client's
Dispatcher menu omits Carriers, but `PRD.md` §2 grants it and every carrier row has a
`dispatcher_id` — the menu is a sketch, not a permission revocation, and removing it would
break the assignment model. Revisit only if the client asks explicitly.

**Not built here:** a distinct Dispatcher dashboard. It would only differ decoratively
until Tasks and Alerts exist, so it lands in sub-project C rather than being invented now.

### Role-panel spec decomposition

The supplied spec is seven sub-projects, not one. Each gets its own spec → plan → build.

| # | Sub-project | Status |
|---|---|---|
| A | Role-scoped panels + nav | ✅ Phase 16 |
| B | Leads (entity, Submit Lead, lead → carrier conversion) | ✅ Phase 17 |
| C | Tasks + Announcements + Alerts (one phase — shared "needs my attention" feed; `attention.ts` is half of it already) | ⬜ next |
| D | Communication (internal threads, dispatch ↔ sales) | ⬜ |
| E | Planning Calendar, Working Notes, Brokers DNU list | ⬜ |
| F | Accounts payable / receivable, Team Performance Report | ⬜ |
| G | Map, Weather | ⬜ external APIs, recurring cost — see "Deferred by design" |

Already covered by existing screens, despite appearing in the spec as new: Active Carriers
(`/active`), Pre-onboarding (`/onboarding`), Carriers Account (`/carriers`), Load
Management (`/loads`), Employee Management (`/team`), Reports, Invoice (the dispatch-fee
half of Billing), Safety & Compliance (insurance-expiry rules only), My Activity
(`/activity`, Phase 16).

---

## Phase 17 — Leads ✅ (2026-09-04)

Sub-project **B**. The Sales Agent's entire reason to exist: before this, `can()` returned
`false` for every action a `sales` user could name, so the role had a login and nothing to
do with it.

- [x] **Migration 18 — `leads`.** A separate table, not a carrier with a "prospect"
      status. A lead has no dispatcher, no plan, no rate and no agreement, and every
      attention rule, report and export in the product treats a `carriers` row as a real
      customer — widening `carriers` would have quietly changed the meaning of all of them.
- [x] Four actions in `permissions.ts`: `lead:view`, `lead:create`, `lead:edit`,
      `lead:convert`. The `sales` role stopped being a blanket `return false` and became a
      switch listing what is *theirs* — still refusing everything else by default, so the
      role gains nothing it was not given on purpose.
- [x] `CarrierScope` became `Scope` (the old name kept as an alias) and gained `owner_id`.
      One extra disjunct in the ownership check now serves both "the carriers assigned to
      me" and "the leads I submitted", rather than a second scope type and a second rule.
- [x] `/leads` — one page, both panels. A rep's own pipeline and an administrator's whole
      pipeline are the same screen with a different **query**: `listLeads(org, ownerId?)`
      narrows in SQL, so another rep's prospect never reaches the HTML at all. The
      dashboard uses the identical `can(user, "lead:convert")` test to pick its scope,
      because two rules would eventually disagree.
- [x] `won` is not a settable stage. It is what `convertLead` writes and the only thing
      that writes it — `LEAD_STATUS_SETTABLE` omits it, both write paths refuse it, and
      the form never offers it. A lead marked won with no carrier behind it cannot exist.
- [x] Conversion creates a carrier at **About to Be Active** carrying only what the lead
      held (contact, MC/USDOT, fleet, trailer type, lead source). Plan, pricing and the
      agreement are filled in afterwards on the carrier profile; nothing is invented.
      The lead is kept, marked won, and points at the carrier — it is the record of how
      that customer arrived — and is read-only from then on, for everybody.
- [x] **`transaction()` now nests** (`src/lib/db.ts`). `convertLead` calls `createCarrier`,
      which already transacts, and `BEGIN` inside a transaction is a SQLite error — so
      before this a composite write had to inline a copy of whatever it wanted to reuse.
      Nested calls join the outer transaction through a savepoint; an outer rollback still
      discards everything the inner one wrote. Three cases pin exactly that.
- [x] `leads` registered in `TENANT_TABLES` (the query guard) and in `OWNED` + the ordered
      deletion in `tenant-lifecycle.ts` — before carriers, users and lookups, since a lead
      points at all three and none of those references cascades.
- [x] Tests: `tests/leads.test.ts` (22 cases) and two new HTTP cases —
      **386 unit + 20 HTTP passing**. tsc and `next build` clean.

**Decided, against the supplied spec:** `lead:view` is admin/owner and sales, and nobody
else. The spec puts Lead Management on the Admin and Sales Agent menus and on no other, so
dispatchers, account managers and viewers are refused rather than quietly included — the
temptation was to let "everyone except dispatchers" read the pipeline, which is how the
Phase 16 deny-list bug was written in the first place.

**Not built here:** a lead's own notes/activity trail (leads carry one notes field; the
timeline belongs with sub-project C's task feed), duplicate detection against existing
carriers by MC number, and any commission tracking — `sales` still has no commission
action because there is no commission feature.

---

## Phase 11 — Making it sellable ✅

The tool is being sold to other dispatch companies, so it now has to survive people the
author cannot walk over to. The tenancy model is undecided; this phase is deliberately the
work that pays off under **every** model — single-tenant deploys, multi-tenant SaaS, or a
self-hosted licence.

- [x] Versioned migrations owning the schema outright — `migrate()` builds a database
      from an empty file or upgrades an existing one, each step in its own transaction
- [x] One-time password reset links — the administrator never learns the password; only
      the token's SHA-256 is stored; single-use, 24h expiry, ends all sessions
- [x] Login throttling — per account (5/15min) and per network (30/15min), checked before
      any password work, surviving restarts
- [x] `npm run backup` — `VACUUM INTO` snapshot, integrity-checked, row-counted and
      rotated. A backup is not accepted until it has been reopened and read
- [x] `Dockerfile` with standalone output, non-root user, healthcheck, and migrations
      run before traffic is served
- [x] Tests: 19 new cases — **147/147 passing overall**
- [x] Verified in-browser: lockout engages on the 6th attempt and refuses even the correct
      password, is per-account, and a reset link works exactly once end to end

### Explicitly NOT done yet — and why
The schema has **no tenant column**. That is correct for one-deployment-per-customer,
where isolation is physical, and wrong for a shared multi-tenant app, where every one of
~111 query sites would need scoping. Adding tenancy speculatively would be the expensive
kind of wrong: it complicates every query for a model that may never be chosen. It is one
focused change when the decision is made — see `Architecture.md`.

## Deferred by design

Recorded so "later" is a decision rather than an oversight.

| Item | Why deferred | Add when |
|---|---|---|
| Postgres | SQLite covers one office comfortably | Concurrent writers across sites, or >100k carriers |
| Email/SMS notifications | Needs Attention is a queue people check | The team asks to be pushed rather than pull |
| File attachments (agreements, COIs) | Not in scope | Document storage is requested |
| Full-text search index | `LIKE` is fast enough at this scale | Search feels slow on the real dataset |
| Multi-select advanced filters | Single-select covers the daily need; the URL format and query layer already accept multiple ids | Someone asks to see two statuses at once |
| SSO | Four roles, one office | The company standardizes on an IdP |
| HR module (attendance, clock-in, leave, tickets, performance) | Present in the previous app's screenshots and in none of its specifications. Out of v1 by decision, 2026-08-30 | It is asked for as a product requirement rather than inherited |
| Live truck tracking | Recurring per-truck cost and a third-party dependency. **V2, and only on request** — decided 2026-08-30 | Explicitly asked for |
