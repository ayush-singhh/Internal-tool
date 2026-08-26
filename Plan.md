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

## Phase 2 — Application Shell 🔨

- [x] Design tokens in `globals.css` (palette, spacing, shadows, typography)
- [ ] Dark sidebar with the nine nav sections + active state
- [ ] Top bar: global search entry, current user, sign out
- [ ] Responsive: collapsible sidebar / mobile drawer
- [ ] Shared primitives: `Badge`, `Card`, `StatTile`, `EmptyState`, `PageHeader`

## Phase 3 — Carrier Database ⬜

- [ ] `listCarriers()` — search, filters, sort allow-list, pagination
- [ ] Carrier table with sortable headers and status badges
- [ ] Quick status filter row
- [ ] Advanced filter panel (12 filters incl. two date ranges)
- [ ] Global search across name, owner, phone, email, MC, USDOT, address
- [ ] Column visibility picker (persisted per user)
- [ ] Saved filters
- [ ] Preset views: Active, Onboarding, Offboarded, Investigations

## Phase 4 — Carrier Profile ⬜

- [ ] Profile page: Overview, Contact, Regulatory/Equipment, Onboarding, Commercial
- [ ] Offboarding section, rendered only when a record exists
- [ ] Internal notes — add, list, attribute, timestamp
- [ ] Activity history timeline with date, time and user
- [ ] Review-flag banner for import-flagged records

## Phase 5 — Add / Edit Carrier ⬜

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
| SSO | Four roles, one office | The company standardizes on an IdP |
