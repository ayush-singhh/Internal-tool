# Build Plan

Ten phases. Each is a working, verifiable slice — nothing is left as a stub for a later
phase to finish. Status is updated as part of the phase it describes.

Legend: ✅ done · 🔨 in progress · ⬜ not started

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

## Phase 5 — Add / Edit Carrier 🔨

- [ ] Nine-section create form with dropdowns, date pickers, auto-formatting
- [ ] Server-side validation for every rule in PRD §5
- [ ] Edit form that preserves untouched fields
- [ ] Duplicate MC/USDOT warning with a link to the existing carrier and deliberate override
- [ ] Field-level diffing into activity history
- [ ] Tests: validation rules, duplicate detection, diffing

## Phase 6 — Status & Offboarding ⬜

- [ ] Status change action with automatic activity entry
- [ ] Offboarding workflow triggered by the four exit statuses
- [ ] Full offboarding capture form
- [ ] Reactivation path back to an active status
- [ ] Guarantee: offboarding never deletes a carrier

## Phase 7 — Dashboard ⬜

- [ ] Eleven live metric tiles
- [ ] Seven charts (status, dispatcher, account manager, lead source, plan, onboarding
      trend, offboarding trend) as inline SVG/CSS
- [ ] Recent Activity feed
- [ ] Needs Attention queue driven by Settings thresholds
- [ ] Tests: Needs Attention rules

## Phase 8 — Reports & Export ⬜

- [ ] Thirteen report views with date filtering
- [ ] CSV export of any report
- [ ] CSV export of the filtered carrier list
- [ ] Tests: CSV serializer round-trip

## Phase 9 — Import ⬜

- [ ] CSV upload + RFC 4180 parser
- [ ] Column mapping UI with auto-suggested matches
- [ ] Row preview with per-row validation errors
- [ ] Duplicate MC/USDOT detection with skip / create / update handling
- [ ] Unmatched vocabulary values preserved and flagged for review
- [ ] Commit inside a transaction; existing records preserved
- [ ] Tests: parser edge cases (quotes, embedded newlines, CRLF)

## Phase 10 — Team & Settings ⬜

- [ ] Team list with role, status and assigned carrier counts
- [ ] Create/edit team member, deactivate, reset password (admin only)
- [ ] Settings: Needs Attention thresholds, company name
- [ ] Settings: manage lookup vocabularies
- [ ] Final pass: permission matrix verified end to end, `npm run build` clean

---

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
