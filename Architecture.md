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

## Multi-tenancy (Option B) — implemented

This is a shared application with a shared database and strict per-tenant isolation. One
deployment serves many organisations; a user authenticated to one organisation has no
application path and no database path to another's data.

### Why Option B

Chosen so the product can be sold self-serve to many companies without operating one
deployment per customer. The cost — every query is tenant-scoped, and isolation must be
proven, not assumed — is paid down by three independent layers plus an adversarial test
suite, rather than trusting each query site to remember a `WHERE` clause.

### Table classification (spec §1)

| Class | Tables | Rule |
|---|---|---|
| **Global / system** | `organizations`, `schema_migrations`, `login_attempts`, `sessions`, `password_resets` | No `organization_id`. Reached only through `systemQuery()`, whose call sites are enumerated and few. Sessions/resets derive their tenant from the user they point at; login throttling must work *before* a tenant is known. |
| **Tenant-owned** | `carriers`, `carrier_notes`, `carrier_activity`, `offboarding_records`, `lookups`, `app_settings`, `users` | Carry `organization_id`. Every read and write is scoped. `lookups` and `app_settings` are per-tenant so one company retiring a plan or changing a threshold never touches another. |
| **User-owned within a tenant** | `saved_filters` | Scoped by `organization_id` *and* `user_id`. |

### Three isolation layers

**Layer 1 — the database refuses it.** Composite foreign keys
(`FOREIGN KEY (organization_id, status_id) REFERENCES lookups (organization_id, id)`, and
likewise for every lookup/user/carrier reference) mean a carrier, note or offboarding row
cannot point at another tenant's row even if application code tried. Verified: inserting an
org-B carrier that references an org-A status fails with `FOREIGN KEY constraint failed`.

**Layer 2 — the query layer refuses it.** `src/lib/db.ts` inspects every statement; one
naming a tenant-owned table without an `organization_id` predicate throws
(`tenantTablesLackingScope`). Fail-closed — a forgotten scope is a loud error in
development, never a silent leak. `systemQuery()` is the only bypass.

**Layer 3 — the caller passes a tenant, never a request value.** Query functions take an
`Org` obtained from `requireOrg()`, which reads `organization_id` from the server-side
session. No `organization_id` from a URL, body or header is ever trusted. An id from
another tenant simply resolves to "not found".

### Tenant identity

`requireOrg()` → `{ user, org }`. `org.id` comes only from the authenticated session. IDOR
is closed structurally: `getCarrier(org, id)` scopes by both, so a foreign id returns
`undefined` rather than another tenant's row — proven in `tests/cross-tenant.test.ts`.

### Migration of existing data (spec §18)

Migrations 5–6 add tenancy. On a database that already held single-tenant data, migration 5
creates one organisation (named from `MIGRATION_ORG_NAME` or the existing `company_name`)
and backfills every row to it — the single-tenant book maps unambiguously to one tenant, so
nothing is guessed. `assertSingleTenantData` refuses to proceed if it ever finds data that
cannot belong to one organisation. On a genuinely empty database, migration creates no
organisation; the app's `seed()` creates the bootstrap organisation with its vocabularies
and owner. Sessions are cleared on migration, since they predate tenancy.

### Roles

`owner` › `admin` › `member` (with the existing dispatcher / account-manager / viewer
distinctions carried inside member). "Last active administrator" is enforced per
organisation. Evaluated server-side only.

### Proven, not assumed

`tests/cross-tenant.test.ts` provisions two organisations and attacks isolation through the
real query functions: read, fetch-by-id, search, duplicate detection, update, notes,
offboarding, saved-filter deletion, dashboard, reports, needs-attention, export, import,
team and settings. All 16 confirm A cannot reach B.

### Known limitations (spec §19)

- **A platform support role is not yet built.** The product owner chose standing,
  read-only, internally-audited support access; that role and its audit log are a later
  phase. Until then there is no cross-tenant access of any kind through the application.
- MFA, self-serve signup, invitations, email verification and the generalised audit log are
  later phases; this phase is tenant isolation and the data layer.
- Cross-tenant access, if the support role is added, will be the single documented exception
  to the isolation invariant, and read-only.

## Schema changes

`src/lib/migrations.ts` owns the schema outright — including creating it from nothing.
Migrations are numbered, ordered, run exactly once, and recorded in `schema_migrations`.
Each runs in its own transaction, so a failure rolls back rather than leaving a database
half-upgraded.

`migrate()` is self-sufficient: pointed at an empty file it builds a complete database,
pointed at an existing one it applies only what is missing. That is what a restore, a
provisioning script and the container's start command all rely on.

Three rules, because other people's data now depends on them:
1. Never edit a migration that has shipped — add a new one.
2. Never renumber — the version is the identity.
3. Every migration must be safe against a database already holding real records.

## Authentication hardening

**Login throttling** (`src/lib/throttle.ts`) applies two independent limits: per email
(5 failures / 15 minutes) to stop grinding one account, and per IP (30 / 15 minutes) to
stop one host spraying many accounts — which a per-email limit alone never sees. The check
runs before any password verification, so a locked account costs no scrypt work. A
successful sign-in clears that account's own failures but never the IP's, since one valid
login should not launder a spray from the same host. Counts live in SQLite so they survive
restarts and work across processes.

**Password resets** (`src/lib/reset.ts`) are one-time links. The previous flow had an
administrator type a password and then tell the person what it was, in plain text over
whatever channel was handy. Now the administrator issues a link and never learns the
password. Only the SHA-256 of the token is stored, so a database dump cannot be replayed
into an account takeover; links expire in 24 hours, work exactly once, are invalidated by
issuing a newer one, and completing a reset ends every existing session for that account.

## Operations

```bash
npm run dev       # http://localhost:3000
npm run build && npm start
npm run migrate   # apply pending migrations (idempotent; run before starting a new version)
npm run backup    # snapshot + verify + rotate
npm test          # 147 tests
```

Backups use `VACUUM INTO`, which takes a consistent snapshot of a database being written
to. Copying the file with `cp` while the app runs can capture a torn page — the classic
way to find out your backups were never valid. Every backup is reopened, integrity-checked
and row-counted before it is accepted.

`Dockerfile` builds a standalone image. The database **must** be on a mounted volume at
`/data`; without one every record is lost on restart. Migrations run before the server
accepts traffic.

First boot creates `data/carrier-hub.db`, seeds the controlled vocabularies and default
settings, and creates one admin from `ADMIN_EMAIL` / `ADMIN_PASSWORD` (defaults documented
in the README). Backup = copy the `data/` directory.
