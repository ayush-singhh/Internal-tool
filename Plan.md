# Build Plan

Ten phases. Each is a working, verifiable slice — nothing is left as a stub for a later
phase to finish. Status is updated as part of the phase it describes.

Legend: ✅ done · 🔨 in progress · ⬜ not started

**All ten phases complete.** 126 tests passing, production build clean, permission matrix
verified over HTTP for every role.

---

## Phase 0 — Foundation ✅

- [x] Next.js 16 + React 19 + TypeScript + Tailwind v4 scaffold
- [x] Docs: `PRD.md`, `Architecture.md`, `AI Rules.md`, `Plan.md`

## Phase 1 — Database & Authentication ✅

- [x] Controlled vocabularies in `src/lib/constants.ts`
- [x] SQLite schema via `node:sqlite` — users, lookups, carriers, notes, activity,
      offboarding, settings, saved filters, sessions
- [x] Idempotent seed: lookups, default settings, first admin user
- [x] scrypt password hashing (`src/lib/password.ts`)
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

### Still to do (later phases)
- [ ] TOTP MFA + recovery codes (argon2 + qrcode already installed)
- [ ] Secure signup + organisation creation + email verification (SMTP)
- [ ] Invitations (single-use, tenant-bound tokens)
- [ ] RBAC UI for owner/admin/member
- [ ] Session hardening: rotation, device list, revoke
- [ ] Generalised audit log + rate limiting beyond login
- [ ] Security headers / CSP
- [ ] Platform support role (read-only, internally audited) per the owner's decision
- [ ] Password hashing migration scrypt → argon2id

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
