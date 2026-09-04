# Architecture

## Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js 16** (App Router, React 19, TypeScript) | Server Components + Server Actions mean forms, mutations and queries need no separate API layer or client state library |
| Styling | **Tailwind CSS v4** | Design tokens live in `globals.css`; no component library to fight |
| Database | **SQLite via `node:sqlite`** | Ships with Node 22+. Real persistent, relational, transactional storage with **zero dependencies** and no native build step |
| Auth | **Argon2id (`@node-rs/argon2`) + server-side session table** | ~80 lines, no NextAuth. Sessions are DB rows, so revocation is a `DELETE` |
| Mail | **Hand-rolled SMTP over `node:tls`** | Two plain-text messages to one relay. Implicit TLS on 465, AUTH PLAIN, one recipient — the eight commands nodemailer would wrap |
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
    password.ts    argon2id hash + verify (also verifies retired scrypt hashes)
    login.ts       what signing in decides: lock, hash check, rehash, second factor due
    signup.ts      self-serve organisation creation + email confirmation links
    reset.ts       password reset links — asked for, or issued by an administrator
    mailer.ts      SMTP client and message building; logs instead when unconfigured
    security-headers.ts  the CSP and friends, as data so they can be asserted
    support.ts     the only cross-tenant reads in the product, each one recorded
    sessions.ts    the list of places an account is signed in, and ending one
    audit.ts       who signed in, who changed access, who took data out
    backup.ts      snapshot, verify, upload, rotate — one implementation, two callers
    backup-schedule.ts  the timer, kept out of the Edge bundle it could never run in
    s3.ts          SigV4 signing and a PUT, so backups can leave the machine
    auth.ts        session create/read/destroy, requireUser, permission checks
    totp.ts        RFC 6238 codes + base32 (pure, no database)
    mfa.ts         enrolment, the sign-in check, recovery codes
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

- All application routes sit behind `requireUser()`. The public pages are `/login`,
  `/reset/[token]`, `/verify/[token]`, and `/signup` — which returns 404 unless
  `SIGNUP_OPEN=1`, so a self-hosted install cannot have strangers creating organisations
  on it. `src/instrumentation.ts` refuses to serve if signup is open without a mail relay.
- Passwords: **Argon2id** at the OWASP parameters (m=19456, t=2, p=1), per-hash random
  salt, verified by `@node-rs/argon2`. Hashes written before this migration use
  `node:crypto` scrypt; they still verify, and `signIn()` re-hashes them to argon2id on
  the next successful login — the one moment the plaintext is available. `needsRehash()`
  in `password.ts` is the discriminator.
- Sessions: opaque 256-bit random IDs in HTTP-only, `SameSite=Lax` cookies, with a
  server-side expiry row. Logout deletes the row. Each row records the browser it was
  issued to and when it was last used, so Settings can show **where the account is signed
  in** and end any of it — revocation is a `DELETE`, so it takes effect on the next
  request with no token left working anywhere. Every query there is scoped by `user_id`:
  a session id is unguessable, but unguessable is not an authorisation check.
- **Two-factor authentication (TOTP)**, per user, self-service. A password on an enrolled
  account buys only a `mfa_pending` session: `getCurrentUser()` refuses one, so it opens
  no page and reads no data until a code confirms it, and it expires in 10 minutes.
  Confirming issues a *new* session id rather than promoting the pending one.
  - The secret is confirmed by a code before activation, so a scan that silently failed
    cannot lock its owner out.
  - A time step is accepted once (`users.mfa_last_step` only moves forward), so a code
    seen in flight cannot be replayed inside its own 30 seconds.
  - Ten single-use recovery codes, 80 bits each, stored as SHA-256 like a reset token.
  - The code step runs on the same throttle counters as the password step, so guessing
    six digits is bounded by the account lock.
  - The QR is rendered to a `data:` URI on the server: the secret reaches the browser
    only as that image and the base32 string for manual entry, and only while enrolling.
- Authorization is re-checked inside every Server Action. `can()` in `permissions.ts` is
  the only place a role is turned into a decision — `owner` holds everything `admin` does,
  and the shell asks `can()` rather than comparing role strings.
- All SQL uses bound parameters.
- The database file lives outside the served tree and is git-ignored.
- **Security headers on every response**, from `src/proxy.ts` (`middleware.ts` is
  deprecated in Next 16 and renamed). The CSP carries a nonce minted per request and uses
  `'strict-dynamic'`, so only scripts bearing that nonce run — an injected `<script>`
  would have to guess a value that changes every time. `script-src` allows no inline
  scripts at all; `style-src` does, because a nonce cannot cover the `style={{…}}`
  attributes React emits and CSS is a far weaker vector. Also `frame-ancestors 'none'` and
  `X-Frame-Options`, `nosniff`, a strict referrer policy, a `Permissions-Policy` denying
  camera/microphone/geolocation/payment, and HSTS in production only, without `preload`.
- **A nonce cannot be prerendered**, so every route renders per request. Next's built-in
  404 is the exception and stays static: its scripts carry no nonce and are blocked, which
  costs nothing because there is nothing on that page to hydrate. A route with something
  to click must not be static while this policy is in force.

### Invitations

An invitation is **not a table**. Adding someone with no password creates their account
with one nobody knows — 32 random bytes, never shown — and no confirmed address, so it
cannot be signed into; the administrator's link is then mailed, and setting a password
through it confirms the address and turns the row into a real account.

That means an unaccepted invitation and an unconfirmed member are the same state, with
nothing to keep in step: the team list shows it as *Invited*, the role and any carrier
assignments are already recorded, and resending is the reset link the page already had.
The link lasts seven days rather than a day, because an invitation has to survive a
holiday, and it grants nothing until it is used.

### Forgotten passwords

Two routes to the same single-use token. An administrator issues one for somebody in
their organisation, and it is **mailed** where a relay is configured — handed back for
them to pass on only where one is not, rather than pretending it was sent. Anyone can ask
for their own at `/forgot`, which is the only route an owner has, since there is nobody
above them.

`/forgot` answers identically for every address, like `/signup`: unknown and deactivated
accounts are sent nothing and told the same thing. It is limited per address as well as
per host, because it puts mail in somebody else's inbox and must not become a way to bury
them in it.

Setting a password from a link also **confirms the address** if it was not already —
clicking a link sent there proves exactly what the confirmation link proves, and without
it somebody who signed up, never confirmed and then forgot their password would be stuck
for good.

### Signing up

Self-serve signup creates an organisation, its owner and its vocabularies through
`provision.createOrganization()` — the same path the CLI and the first-run seed take — and
then mails a link that proves the owner reads the address they typed. Until it is clicked
`users.email_verified_at` is NULL and the password step refuses the account.

**The answer is the same whatever the address turns out to be.** A new address creates an
organisation, an unconfirmed one has its link sent again, a confirmed one gets nothing —
all three return the same screen, so the form cannot be used to ask whether a company is a
customer, and "resend my link" needs no separate route. Signups are rate-limited per IP
(3/hour) on the same table as login throttling.

One address belongs to one organisation. The schema allows the same address in two tenants,
but signing in looks an account up by email alone, so the application refuses to create
one: both `signup.ts` and `team.ts` check across every organisation before inserting a user.

### The audit log

`carrier_activity` answers "what happened to this carrier". `audit_log` answers the
question a customer's security review asks instead: **who signed in, who changed who can
sign in, and who took data out.** Sign-ins and refused sign-ins, lockouts, two-factor
turned on or off, passwords changed, members invited, roles changed, accounts deactivated,
and every CSV export with its row count. Tenant-owned, admin-visible at `/audit`,
append-only — nothing in the application updates or deletes a row.

Two deliberate departures:

- **No composite foreign key to `users`**, unlike every other tenant-owned table. With
  one, removing a user is either blocked by the record of what they did, or — with
  `ON DELETE SET NULL`, which nulls *every* column of a composite key — takes
  `organization_id` with it, and that column is NOT NULL. So `user_id` is a soft reference
  and an `actor` column carries the identity in text. An audit log has to outlive the
  account it describes.
- **Recording never throws.** A write that took down the sign-in it was documenting would
  be a worse failure than the one it set out to record.

The CSV export is also rate-limited per person, at twenty an hour: far above anyone
working, far below a script quietly pulling the customer list on a loop.

### Platform support access

One surface, `/support`, reaches across organisations. Its shape was a decision rather
than a default:

- **Standing access, no customer approval gate.** Support that has to wait for permission
  is not support.
- **Read only — by construction, not by a flag.** The pages under `/support` render markup
  with no forms and import no Server Action, so there is no write path to guard. A shared
  "read-only" flag would not have worked: one process serves many requests at once and the
  flag would leak between them. `can()` additionally denies a support account *everything*
  inside a tenant, so a support session that somehow reached an ordinary page sees nothing.
- **Every view recorded** in `support_access_log` — who, whose data, which path, when —
  written before the data is read, so a render that fails is still a recorded look. The
  table is not tenant-owned and is deliberately **not surfaced in the customer UI**: it
  exists so the access can be reviewed internally.
- **A second factor is required.** `/support` stays shut until the account has one.
- **The role cannot be granted from inside the product.** `team.ts` refuses it and the
  role picker omits it, because an organisation's administrator granting a role that
  crosses organisations would be an escalation out of their own tenant.
  `scripts/support-user.ts` creates one, run by whoever has the server.
- Reads go through the ordinary scoped query functions with an `Org` for the tenant being
  viewed, so the guard and the composite foreign keys still apply — support borrows
  authority, it does not switch it off.

Emergency access that leaves no trace remains out of band: SQL on the server, by someone
with the disk.

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
| **Tenant-owned** | `carriers`, `carrier_notes`, `carrier_activity`, `offboarding_records`, `lookups`, `app_settings`, `users`, `audit_log`, `drivers`, `brokers`, `loads`, `load_stops`, `load_documents`, `load_adjustments`, `invoices`, `invoice_lines`, `leads`, `tasks`, `announcements`, `channels`, `messages`, `channel_reads` | Carry `organization_id`. Every read and write is scoped. `lookups` and `app_settings` are per-tenant so one company retiring a plan or changing a threshold never touches another. The authoritative list is `TENANT_TABLES` in `src/lib/tenant-db.ts` — the guard and the tests both read it, so this row is documentation and that constant is the rule. |
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

- **`/support` is the single documented exception to the isolation invariant** — standing,
  read-only, second-factor-required, and every view recorded in `support_access_log`.
  Built; see the platform support section. Because it is the one cross-tenant surface,
  **every page under it calls `requireSupport()` itself.** A layout cannot gate it: Next
  renders a page concurrently with its layout, so a layout's `notFound()` sets the status
  and the page still runs and streams. See `BUGS.md`.
- **Capacity ceiling: one machine, and it is nearer than the data size suggests.**
  `node:sqlite`'s `DatabaseSync` is synchronous, so every query blocks the event loop —
  one slow query delays *every tenant*, not just the one that asked. And a second Fly
  machine gets its own empty volume, silently splitting the product in two, so scaling out
  is not available as a relief valve.

  The trigger to act is **concurrent tenants, not carrier count**: the first symptom is
  request latency rising across all customers at once, while the database stays small.
  Watch p95 latency rather than row counts. The move when it arrives is Postgres — the
  query layer is plain SQL and `Org` is already threaded through every call site, so it is
  a driver change, not a redesign.

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
runs before any password verification, so a locked account costs no hashing work. A
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
