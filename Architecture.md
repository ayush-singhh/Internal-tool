# Architecture

## Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js 16** (App Router, React 19, TypeScript) | Server Components + Server Actions mean forms, mutations and queries need no separate API layer or client state library |
| Styling | **Tailwind CSS v4** | Design tokens live in `globals.css`; no component library to fight |
| Database | **SQLite via `node:sqlite`** | Ships with Node 22+. Real persistent, relational, transactional storage with **zero dependencies** and no native build step |
| Auth | **`node:crypto` scrypt + server-side session table** | ~80 lines, no NextAuth. Sessions are DB rows, so revocation is a `DELETE` |
| Charts | **Hand-rolled inline SVG / CSS** | Bars, donuts and sparklines are a few dozen lines each and stay on-brand. No 500 KB charting dependency |
| CSV | **Hand-rolled RFC 4180 parser/serializer** | Handles quoting and embedded newlines correctly in ~40 lines |

**Runtime dependencies: `next`, `react`, `react-dom`, `server-only`.** `server-only` is a
build-time guard (a few lines, published by the Next team) that fails the build if a module
touching the database or session is ever imported into a client bundle — cheap insurance on
the rule that matters most here.

### Import convention

Relative imports inside `src/lib/` carry explicit `.ts` extensions
(`allowImportingTsExtensions` in `tsconfig.json`). This lets `node --test` run the modules
directly through Node's native type stripping — no build step, no test runner, no transpiler
in the test path.

## Why SQLite

This is an internal tool for one office with thousands — not millions — of carriers.
SQLite in WAL mode handles that with room to spare, keeps the whole system a single file
(trivial to back up: copy `data/carrier-hub.db`), and removes an entire class of
deployment work. The data layer is plain SQL, so moving to Postgres later means changing
the driver in `src/lib/db.ts`, not rewriting features.

## Directory Layout

```
src/
  lib/
    constants.ts   controlled vocabularies, roles, default settings
    db.ts          connection, schema, seeding, query helpers (all/get/run)
    password.ts    scrypt hash + verify
    auth.ts        session create/read/destroy, requireUser, permission checks
    carriers.ts    carrier queries, mutations, activity logging
    format.ts      phone / date / pricing display formatting
    csv.ts         CSV parse + serialize
  app/
    login/                  unauthenticated
    (app)/                  authenticated shell — sidebar layout wraps everything
      page.tsx              Dashboard
      carriers/             list, new, [id] profile, [id]/edit
      active/ onboarding/ offboarded/ investigations/   preset views of the carrier list
      reports/ team/ settings/ import/
    api/export/             CSV download endpoint
  components/               shared UI: badges, tables, forms, charts
```

## Data Model

```
users ──┬─< carriers.dispatcher_id
        ├─< carriers.account_manager_id
        ├─< carrier_notes.user_id
        ├─< carrier_activity.user_id
        ├─< offboarding_records.handled_by
        └─< sessions.user_id

lookups ──< carriers.{status,trailer_type,onboarding_type,lead_source,plan,
                      pricing_type,billing_frequency,subscription,
                      agreement_status,invoice_mode}_id
        └─< offboarding_records.{reason,category,final_status}_id

carriers ──┬─< carrier_notes
           ├─< carrier_activity
           └─── offboarding_records   (0..1)

app_settings   key/value — Needs Attention thresholds, company name
saved_filters  named carrier-list filter sets
```

### Design decisions worth knowing

**One `lookups` table, not nine.** Statuses, plans, lead sources, trailer types, pricing
types, agreement statuses, subscriptions, invoice modes and offboarding reasons are all
`(kind, value, label, tone, sort)`. Carriers hold real foreign keys into it, so referential
integrity is intact — but Settings gets one editor instead of nine, and adding a vocabulary
is one row, not one migration. If a single vocabulary ever needs its own columns, it
graduates to its own table.

**Users and Team Members are one table.** A team member is a person who logs in and can be
assigned carriers. Two tables would mean keeping two records of the same human in sync.

**Onboarding fields live on `carriers`.** They are strictly 1:1 with the carrier and always
present; a separate table would be a join with no benefit. **Offboarding is its own table**
because it is sparse (most carriers have none), has a dozen fields of its own, and
represents a discrete workflow event.

**Subscription is a field, not a billing engine.** We track its state (Active / Paused /
Cancelled / None) alongside plan and pricing. We do not process payments.

**Duplicate MC/USDOT is enforced in the application, not by a `UNIQUE` constraint.** The
requirement is a warning the user can review and override; a database constraint would make
that impossible. Indexes exist for detection speed.

## Request Flow

1. `middleware`-free auth: the authenticated `(app)` layout calls `requireUser()`, which
   reads the `ch_session` HTTP-only cookie, looks the session up in the `sessions` table,
   and redirects to `/login` when absent or expired.
2. Pages are Server Components that query SQLite directly — no fetch, no API round trip.
3. Mutations are Server Actions. Each one re-checks permission server-side (the UI hiding a
   button is never the security boundary), writes inside a transaction, appends any
   `carrier_activity` rows, and calls `revalidatePath`.
4. Client Components are used only where interaction demands them: filter bars, column
   pickers, the import wizard, multi-section forms.

## Auditing

`recordActivity()` is called by every carrier mutation. Field-level diffs are computed
before the write, so status, dispatcher, account manager, pricing, agreement, subscription
and offboarding changes each produce an attributed, timestamped entry. Activity is
append-only — nothing in the UI edits or deletes it.

## Security

- All application routes sit behind `requireUser()`; `/login` is the only public page.
- Passwords: scrypt with a per-user random salt, compared with `timingSafeEqual`.
- Sessions: opaque 256-bit random IDs in HTTP-only, `SameSite=Lax` cookies, with a
  server-side expiry row. Logout deletes the row.
- Authorization is re-checked inside every Server Action.
- All SQL uses bound parameters.
- The database file lives outside the served tree and is git-ignored.

## Operations

```bash
npm run dev     # http://localhost:3000
npm run build
npm start
```

First boot creates `data/carrier-hub.db`, seeds the controlled vocabularies and default
settings, and creates one admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD` (defaults documented
in the README). Backup = copy the `data/` directory.
