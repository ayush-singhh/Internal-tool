# Session Handoff — read this first to resume

This file is the resume point for a fresh session. It is kept current at the end of each
working session. For the full picture read, in order: `PRD.md` → `Architecture.md` →
`AI Rules.md` → `Plan.md` → `MIGRATION-PLAN.md`.

**Last updated:** 2026-09-01. The product has a second half now: the **Asterism dispatch
domain**, built from scratch on this codebase. Read `BUGS.md` first — the test suite was
found writing into `data/carrier-hub.db`, and the guard that was meant to prevent that
checked the wrong thing (fixed).

---

## Where things stand

**Product:** Carrier Management Hub — an internal Carrier CRM / operations dashboard for a
trucking dispatch company, now being turned into a **multi-tenant SaaS** sold to many
dispatch companies, and now also the home of **Asterism dispatch** (loads, drivers,
brokers, invoicing).

**Why here and not on the old app:** the previous Asterism app was never past development
and its source is not available, so nothing is being ported — the dispatch domain is new
code on this base. That was the whole point of choosing it: tenancy, auth, audit,
migrations, backups and support access already exist and are tested. Plan and gap analysis:
https://claude.ai/code/artifact/e6c570ce-c726-494e-be02-0d003da4059f (Phase 00 and the
sequencing are now stale — see below).

**Branch:** `multi-tenant` (NOT merged to `main`). `main` is at the single-tenant
"Phase 11 — sellable" state. Do not merge to `main` until the SaaS features below are done.

**Working tree:** clean — Phase 15 (loads, drivers/brokers, documents) is fully committed;
only invoicing remains, blocked on the client. **Tests:** 333 passing (`npm test`) + 11 over
HTTP (`npm run test:http`). **Build:** clean.

**Stack:** Next.js 16 (App Router, RSC + Server Actions), React 19, TypeScript, Tailwind v4,
SQLite via `node:sqlite`. Runtime deps: `next`, `react`, `react-dom`, `server-only`,
`@node-rs/argon2`, `qrcode`.

---

## In flight — pick this up first

Nothing is in flight. Phase 15 (Asterism dispatch: loads, drivers/brokers, documents) is
complete and committed — see "Asterism dispatch — what exists ✅" below for what's there.
Only invoicing remains, still blocked on the two invoice samples (owner-operator,
two-driver) requested from the client.

---

## Asterism dispatch — what exists ✅

- **Migration 15** — `drivers`, `brokers`, `loads`, `load_stops`, every one tenant-owned
  with composite foreign keys, so the database refuses a load pointing at another tenant's
  carrier, driver or broker. Proven by `tests/dispatch-schema.test.ts`.
- **A driver is not a user.** The driver login was dropped, so a driver is a record about a
  person rather than an account. Modelling them as users would force a credential row for
  somebody who will never sign in.
- **Stops are rows, not columns** — up to five pickups and five deliveries, numbered per
  kind. One pick, one drop is simply two rows.
- **Exceptions sit beside the status**, never replacing it: a load can be Delivered *and*
  carry a deduction. The seven statuses stay out of `lookups` because they drive behaviour
  rather than label it.
- **The hundred brokers are seeded per organisation**, like lookups. `seeded = 1` marks the
  shipped ones so an admin can tell them from one a dispatcher typed.
- `loads.ts` / `load-write.ts` — both rates per mile (null, never Infinity), forward-only
  status flow, no dispatch without a driver, pickup/delivery timestamped because invoices
  are built from them.
- `dispatch-admin.ts` — drivers and brokers, the two reference lists a load is built from.
  `/drivers` and `/brokers` screens, with the add/edit split enforced by two permissions,
  not one screen with a hidden button. The driver-deactivation race is closed the same way
  team member deactivation already is: `listDrivers` returns `open_loads` per row, and the
  row's Deactivate button is disabled client-side when it's nonzero; `setDriverActive`
  still refuses server-side regardless, so a stale count fails closed, not open. Migration
  15's 100 seeded brokers only backfill onto orgs created after it — an org from before
  gets the tables but not the seed rows; not fixed, out of scope.
- `documents.ts` / `document-actions.ts` — RC/BOL/POD (plus an "Other" catch-all) attached
  to a load, migration 16, S3-backed via `DOCUMENTS_S3_URL`. `/api/documents/[id]` streams
  the download, gated on `load:view`; upload re-checks `load:manage`. `document-manager.tsx`
  is the Documents card on `/loads/[id]`. Append-only — no delete, ever.
- **Roles** — added `sales` (refused everything: their sidebar has neither Carrier nor Load
  Management). Seven dispatch actions; `load:rate` is separate from `load:view`, `load:close`
  is admin-only, and `broker:create` is separate from `broker:edit` so a dispatcher's typo
  cannot quietly become a permanent broker. Matrix tested exhaustively in
  `tests/security.test.ts`.

**Decided, in `Plan.md`:** no HR module; live truck tracking is V2 and only on request.

**Still needed from the client:** the two invoice samples (one owner-operator, one
two-driver) before invoicing can be built sensibly.

**Postgres is deferred, not cancelled.** I attempted the async conversion and reverted it:
~700 edits across 65 files, automation reaches ~85%, and the remainder has semantic traps
(`assert.throws` must become `await assert.rejects` or the test asserts nothing). My earlier
"several times more expensive later" was overstated — measured, it is roughly 17% more per
phase. Do it as its own dedicated run, not alongside features. File storage for RC/BOL/POD was
the other infrastructure decision blocking progress — it's resolved now (`DOCUMENTS_S3_URL`,
see "Asterism dispatch" above); only invoicing is still waiting on the client.

---

## What is DONE

### Audit — two critical bugs, and what they exposed ✅ (2026-08-30)

**Read `BUGS.md` before touching auth, migrations or SQL.** Each entry leads with *why it
was missed*, which is the part that generalises. In short:

- **`/support` was gated only by its layout.** A layout cannot refuse a request — Next
  runs the page concurrently, so `notFound()` set the status and the page still streamed
  its markup into the 404 body. Any signed-in customer could read every tenant on the
  deployment. Every page under `/support` now calls `requireSupport()` itself. Never
  authorise in a layout.
- **The tenancy migrations destroyed data.** `PRAGMA foreign_keys` is a no-op inside a
  transaction, so migration 6's `OFF` never applied; migration 5 failed outright on a real
  database and migration 6 would have silently emptied notes, activity and offboarding.
  `migrate()` now toggles enforcement outside the transaction and asserts
  `foreign_key_check` per migration.
- Plus three smaller: the report export had no rate limit or audit record, a duplicated
  query desynced its placeholders from its parameters, and `isFirstRun()` asked a
  single-tenant question.

Three gaps the audit made obvious, now closed:

- **`npm run test:http`** — the suite could not have caught either critical bug, because
  every test called a `src/lib` function directly and none had ever looked at a response.
  `tests/http/harness.ts` builds the app, starts it, and drives it over the wire.
  Assertions check the status **and** that the body carries no data the caller was not
  entitled to — a status code is not a denial. Kept out of `npm test` because it needs a
  build; both are fast.
- **Backup outcomes are visible** — `backup_log` (migration 13) records every run as
  `offsite` / `local` / `degraded` / `failed`, shown on `/support`. `degraded` is the one
  that matters: a verified snapshot whose upload was refused used to look exactly like a
  success. The card leads with the last copy that actually left the machine, because that
  is the date a restore takes you back to.
- **A tenancy can end** — `npm run export-org -- <slug>` and
  `npm run delete-org -- <slug> --confirm <slug>`. Out of band like `support-user.ts`.
  Deletion exports first (the `audit_log` and `support_access_log` rows go with the
  tenant, so the file is where that record survives), refuses to remove platform support
  accounts, and rolls back if it would leave a dangling reference.


### Billing decision — settled: manual invoicing ✅

**Nothing in this repository charges anybody**, and that stays true. Every other
"billing" in these docs is the *carriers'* commercial terms, not our customers'
subscriptions. Decided 2026-08-29: manual invoicing, tracked by a status on
`organizations` rather than a payment integration.

- `organizations.status` already existed (migration 5, always `'active'` until now, read
  nowhere) — reused rather than adding a column. `ORG_STATUS` in `constants.ts` gives it
  four values: `trial`, `active`, `past_due`, `suspended`.
- Set only by `npm run set-billing-status -- <org-slug-or-id> <status>`, out of band, the
  same shape as `scripts/support-user.ts`. **No write path from `/support` or anywhere a
  customer or a support account can reach** — `/support` is read-only by construction
  (see the platform support section below), and this does not get an exception.
- Shown as a coloured badge in the `/support` tenant list — the one place it's useful to
  see every tenant's standing at a glance.
- **No enforcement.** A `suspended` org still signs in and works exactly as before; this
  is a label for whoever is invoicing to read, not a gate. Building the gate (block
  sign-in, banner, whatever) is a separate, later decision if manual tracking turns out
  not to be enough.

### Server errors are no longer invisible ✅

- Next's `onRequestError` hook (`instrumentation.ts`) catches every uncaught error in a
  Server Component, Route Handler or Server Action and writes it to `error_log`: message,
  digest, path, method, route type, when. **Node-only** — `error_log` needs
  `node:sqlite`, which does not exist on the Edge runtime `proxy.ts` runs on, so a proxy
  error still reaches the platform's own logs but not this table.
- Genuinely global, like `sessions` — a request can fail before any organisation is
  resolved (a broken `/login` attempt, a bad proxy match), so there is often nothing to
  attach it to. Not in `TENANT_TABLES`; queried through `systemQuery()` like the other
  global tables, by convention rather than necessity.
- Surfaced as a third card on `/support` — same audience as the access log already there
  (platform support, MFA required), because a stack trace can name any tenant.
- **Recording never throws**, same reason `audit.record()` doesn't.
- Verified end to end against a real 500: a temporary throwing route, hit over HTTP,
  produced a row with the exact message/digest/path/method/route-type, and the
  `/support` card rendered it.

### Recovery codes can be regenerated ✅

- Settings has a "Get new recovery codes" action next to "Turn off two-factor", behind
  the same proof: a working authenticator code (or an unused recovery code) required
  first, so a borrowed session cannot mint itself a fresh set.
- `regenerateRecoveryCodes()` in `mfa.ts` deletes every existing code — spent or not —
  and inserts ten new ones in one transaction, mirroring `activate()`'s own code-issuing
  step. Shown once, exactly like the original set. Logged as `mfa.recovery_regenerated`.
- This was the "recovery codes cannot be regenerated" item on the smaller-later list;
  it is done and off the list.

### Audit log ✅

- `audit_log` answers what a security review asks: **who signed in, who changed who can
  sign in, who took data out.** Sign-ins, refusals, lockouts, MFA on/off, password
  changes, invitations, role changes, deactivations, and every CSV export with its row
  count. Readable by an administrator at `/audit`, append-only.
- **No composite FK to `users`**, unlike every other tenant-owned table: with one,
  removing a user is either blocked by the record of what they did, or — with
  `ON DELETE SET NULL`, which nulls *every* column of a composite key — takes
  `organization_id` with it, and that is NOT NULL. `user_id` is a soft reference; the
  `actor` column carries the identity in text so the record survives the account.
- **`record()` never throws.** A failed audit write must not take down the sign-in it was
  describing.
- CSV export is rate-limited per person (20/hour) — the one authenticated route that hands
  over the whole book of carriers at once.

**A mistake worth not repeating:** `tests/audit.test.ts` imported `src/lib/audit.ts` at the
top of the file, which loads `db.ts`, which binds `CARRIER_DB_PATH` *at import time* —
before the line that sets it. Seven runs wrote their fixtures into `data/carrier-hub.db`
(empty of real data; backed up and cleaned). `tests/helpers.ts` now refuses to seed
anything unless `CARRIER_DB_PATH` points inside the temp directory, so the next time this
is done it fails loudly instead of quietly.

### Sessions you can see and end ✅

- Settings lists every live session for the account: the browser it was issued to, the
  address it came from, when it was last used, and which one is asking. Sign out one, or
  everything except this browser.
- Revocation is a `DELETE`, so it takes effect on the next request — there is no token
  left working somewhere.
- Every query in `sessions.ts` is scoped by `user_id`. A session id is unguessable, but
  unguessable is not an authorisation check, and this is the one place other people's
  session ids are handled at all.
- `last_seen_at` is written at most once every five minutes, not once per request.
- The device name is a dozen lines of pattern matching, not a UA-parsing dependency, and
  the raw string is kept so nobody has to trust it. It is a label, never a check.

**RBAC UI was already built** — the Team page assigns roles, invites, deactivates and
resets, and `can()` is the one matrix. That item was stale. What was genuinely missing
turned up while checking it: `updateTeamMember` checked email uniqueness only *within* an
organisation while creation checked across all of them, so an **edit** could still create
the same address in two tenants — which sign-in, finding an account by address alone,
cannot resolve. Fixed, and pinned by a test.

### Automated, verified, off-machine backups ✅

- A timer in `src/instrumentation.ts` runs them daily (`BACKUP_EVERY_HOURS`). Not on boot:
  a restart loop would otherwise fill the disk. A timer in the server rather than cron,
  because the process holding the file is the only thing that can copy it.
- Each snapshot is `VACUUM INTO` (safe while the database is written to), then **reopened**
  — integrity-checked, row-counted, ledger read — before it is accepted.
- **`BACKUP_S3_URL` is what makes it a backup.** Uploads speak the S3 API through
  hand-rolled SigV4 in `src/lib/s3.ts` (~60 lines, no AWS SDK), so R2, B2, Wasabi, MinIO
  and AWS all work. **The signer is asserted against AWS's own published test vector** —
  otherwise a wrong signature only shows up as a 403 from a provider at 3am.
- A failed upload never costs the local copy and never stops the schedule; it is reported
  loudly, and `npm run backup` exits non-zero on it.
- `npm run restore -- <file>` verifies the backup *before* replacing anything, moves the
  live database aside instead of deleting it, and clears the stale WAL so SQLite cannot
  replay the old tail onto the restored file. **Rehearsed once, for real:** every carrier
  deleted from a copy of the demo database, restored, all 46 back.
- Fixed on the way: backup filenames had minute resolution, so two in one minute failed
  with a raw `VACUUM INTO` error — exactly what you would hit re-running after a failure.

### Platform support role ✅ — built as agreed, not as first asked

- `/support` is the only cross-tenant surface: an organisation list, one tenant's
  carriers, one carrier's full record.
- **Read-only by construction.** Those pages have no form and import no Server Action, so
  there is no write path to guard. This matters: `filter-actions.ts` has two write actions
  with *no* permission check by design (saved filters are user-owned), so `can()` alone
  would not have made a session read-only — and a shared flag could not work either, since
  one process serves many requests at once and it would leak between them.
- `can()` denies a support account **everything** inside a tenant, view included.
- **Every view recorded** in `support_access_log` (who, whose data, path, when), written
  before the data is read. Not tenant-owned, and not surfaced in the customer UI — it is
  the internal record that makes standing access reviewable.
- **Second factor required**: `/support` redirects to `/support/account` until it is on.
- **Ungrantable from inside the product** — `team.ts` refuses the role and the picker omits
  it, or a customer's administrator could escalate out of their own organisation.
  `npm run support-user -- email@example.com "Name"` creates one, out of band.
- Reads use the ordinary scoped queries with an `Org` for the tenant being viewed, so the
  guard and composite FKs still apply. Verified over HTTP: a customer's admin gets **404**,
  a support account without MFA is sent to enrol, and both views landed in the log.

### Security headers / CSP ✅

- `src/proxy.ts` — **not `middleware.ts`**, which Next 16 deprecated and renamed. Sets the
  headers on every response.
- The CSP mints a **nonce per request** and uses `'strict-dynamic'`: only scripts carrying
  that nonce run, so `script-src` allows no inline script at all. `style-src` does allow
  inline, because a nonce cannot cover the `style={{…}}` attributes React emits — a
  deliberate trade, and commented as one.
- Plus `frame-ancestors 'none'` + `X-Frame-Options`, `nosniff`, `Referrer-Policy`,
  `Permissions-Policy`, and HSTS in production only, without `preload`.
- **A nonce cannot be baked into a prerendered page**, so every route now renders per
  request (`/forgot` needed `force-dynamic`). Next's built-in 404 is the one exception and
  stays static — its scripts are blocked, which costs nothing, as there is nothing there to
  hydrate. **Do not make a route with something to click static** while this is in force.
- The policy is data in `src/lib/security-headers.ts` so it can be asserted: `proxy.ts`
  imports `next/server`, which does not resolve under `node --test`, and security headers
  are exactly the thing that rots one `'unsafe-inline'` at a time.

### Invitations ✅

- Adding a team member **sends a link** instead of inventing a password and handing it
  over. Seven-day expiry — an invitation has to survive a holiday, and it grants nothing
  until it is used.
- **No new table.** `createTeamMember` with no password creates the account with 32 random
  bytes as its password and no confirmed address, so it cannot be signed into; accepting
  the link sets the password and confirms the address in one step. An unaccepted
  invitation and an unconfirmed member are therefore the same state, with nothing to keep
  in step — the list shows *Invited*, and resending is the reset link the page already had.
- The direct-password route still exists for an account with no mailbox: invite, then
  "set a password directly" in the same dialog.

### Self-serve password reset ✅

- `/forgot` asks for a link. Same answer for every address, like `/signup` — unknown and
  deactivated accounts are sent nothing and told the same thing.
- Limited **per address** as well as per host: the endpoint puts mail in someone else's
  inbox, so it must not become a way to bury them in it. `throttle.ts` grew a generic
  `checkBurst`/`recordBurst` for this; signup now uses it too.
- The administrator's link from the Team page is **mailed** where a relay is configured,
  and only handed back to be passed on where one is not. A send failure falls back to the
  link with the reason attached, rather than losing the reset they asked for.
- Consuming a reset link **confirms the address** if it was not already. Clicking a link
  sent there proves what the confirmation link proves, and without this someone who signed
  up, never confirmed and then forgot their password was stuck for good.

### Self-serve signup + email verification ✅

- `/signup` creates an organisation, its owner and its vocabularies through
  `provision.createOrganization()` — the same path the CLI and first-run seed use — then
  mails a confirmation link. `users.email_verified_at` stays NULL until it is clicked, and
  the password step refuses the account meanwhile (without locking it out).
- **The answer is the same whatever the address is**: new → created, unconfirmed → link
  resent, already a customer → nothing sent. So the form cannot enumerate customers, and
  signing up again *is* the resend. Only the newest link works.
- `src/lib/mailer.ts` is SMTP over `node:tls` (implicit TLS on 465, AUTH PLAIN, one
  recipient). Header-injection safe, base64 bodies. With no `SMTP_URL` it prints the
  message instead, so local development can read the link.
- `SIGNUP_OPEN=1` gates the route — it 404s otherwise, so a self-hosted install cannot
  have strangers creating organisations on it.
- `src/instrumentation.ts` runs before the server serves anything and refuses to start a
  production build with signup open and no `SMTP_URL` / `MAIL_FROM` / `APP_URL`.
- **One address belongs to one organisation.** The schema allows the same address in two
  tenants, but sign-in looks an account up by email alone, so `signup.ts` and `team.ts`
  both check across every organisation before inserting a user.

### Two-factor authentication (TOTP) ✅

- Self-service in Settings: enrol → scan → **confirm with a code before it activates**
- `src/lib/totp.ts` is pure RFC 6238 (~40 lines of `node:crypto`), pinned to the RFC's
  own test vectors; `src/lib/mfa.ts` holds enrolment, the sign-in check and recovery codes
- A password on an enrolled account creates a **pending** session (`sessions.mfa_pending`,
  10-minute expiry). `getCurrentUser()` refuses one, so it opens nothing. `/login` renders
  the code prompt for that browser — same route, no second URL to guard
- Confirming issues a fresh session id; the pending one is deleted
- Replay: `users.mfa_last_step` only moves forward, so a code works once
- 10 recovery codes, 80 bits each, SHA-256 stored, single-use, shown once at activation
- Code guesses run on the existing login throttle (account + IP)
- `src/lib/login.ts` was split out of `auth.ts` so the sign-in rules are testable — auth.ts
  imports `next/headers` and cannot be imported by `node --test`

**Fixed on the way:** `can()` in `permissions.ts` never knew the `owner` role that the
multi-tenant phase introduced, so every new tenant's owner was locked out of Settings,
Team and Import. `owner` now holds everything `admin` does, the shell asks `can()` instead
of comparing role strings, and the team page's "last administrator" guard counts owners
the way `team.ts` already did.

### Password hashing — Argon2id ✅

- `src/lib/password.ts` hashes with Argon2id via `@node-rs/argon2`, at the library's
  defaults, which are already the OWASP parameters (m=19456, t=2, p=1)
- Old `scrypt$…` hashes still verify, so no existing account is locked out
- `needsRehash()` flags them; `signIn()` re-hashes to argon2id on the next successful
  login (`src/lib/auth.ts`) — the only moment the plaintext exists
- Covered end to end by `tests/login.test.ts` once `login.ts` was split out of `auth.ts`

### Multi-tenant Phase 2 — tenant isolation ✅

The data layer is fully multi-tenant and isolation is proven by an adversarial test suite.

- `organizations` table + `organization_id` on all 8 tenant-owned tables (migration 5)
- Composite foreign keys — the DB itself refuses cross-tenant references (migration 6, **Layer 1**)
- Fail-closed query guard in `src/lib/db.ts` — any tenant-table query missing an
  `organization_id` predicate throws; `systemQuery()` is the only bypass (**Layer 2**)
- `Org` (from `requireOrg()`, session-derived) threaded through all ~56 query sites (**Layer 3**)
- Per-tenant vocabularies (`lookups`) and settings (`app_settings`); per-tenant email uniqueness
- Per-tenant provisioning in `src/lib/provision.ts`; `owner` role added
- Migration backfills one org for existing data; refuses ambiguous data; fresh installs seed a bootstrap org
- **`tests/cross-tenant.test.ts` — 16 attacks, all denied.** Also verified in a real browser:
  org A opening org B's carrier by id → 404.

Table classification (global / tenant-owned / user-owned) is documented in
`Architecture.md` → "Multi-tenancy (Option B) — implemented".

---

## What is NEXT (later SaaS phases — not started)

Mirrored in `Plan.md` under "Phase 12 … Still to do".

**Everything on the numbered list is done.** What remains is small, and listed below.

Smaller, and only worth a detour when they get in the way:

- `next build` fails with `ENOTEMPTY` on `.next/standalone` on a rebuild often enough to
  notice; `rm -rf .next` fixes it (sometimes twice). Next's bug, not ours.

---

## Decisions already made (do not re-litigate)

1. **Password hashing:** Argon2id via `@node-rs/argon2` (prebuilt binaries). **Done.**
2. **TOTP QR:** the `qrcode` package, rendered server-side. **Done.**
3. **Email:** hand-rolled SMTP over `node:tls`, configured by `SMTP_URL`, refusing to
   start in production when signup is open without it. **Done** — `src/lib/mailer.ts`.
4. **Hosting: Fly.io**, chosen 2026-08-29. One machine, one volume at `/data`, config in
   `fly.toml`. Not Vercel (ephemeral disk destroys a SQLite database) and not GitHub Pages
   (static only). **Never scale past one machine** — a second gets its own empty volume
   and silently splits the product in two. `DEPLOY.md` has the walkthrough.
5. **Platform support role:** the owner asked for standing access to look inside any
   tenant's data. They requested it be **unlogged and hidden from customers**. That specific
   design (deliberately concealed, tamper-free cross-tenant access to third-party PII) was
   **declined**. What to build instead, agreed as the workable version: **standing,
   read-only access to any tenant, always available (no customer approval gate), with an
   internal server-side audit log that is NOT surfaced in the customer UI, MFA required, no
   write access.** Emergency no-trace access is out-of-band (direct SQL on the server).
   **Built** — see the platform support section above. `/support` is the only cross-tenant
   path in the product, and every page under it calls `requireSupport()` for itself.

---

## How to run / verify

```bash
npm test                         # unit tests, node --test, no framework
npm run test:http                # builds, then drives a real server over HTTP
npm run build                    # production build (Turbopack)
npm run dev                      # http://localhost:3000  (uses data/carrier-hub.db)
npm run migrate                  # apply pending migrations (idempotent)
npm run backup                   # snapshot + verify + rotate

# Self-serve signup (off by default). With no SMTP_URL the confirmation mail is printed
# to the terminal instead of sent, which is how to test the flow locally:
SIGNUP_OPEN=1 APP_URL=http://localhost:3000 npm run dev

# Two-tenant demo (build it, then run against it):
CARRIER_DB_PATH=data/two.db ADMIN_ORG="Alpha" ADMIN_EMAIL=alpha@test.local \
  ADMIN_PASSWORD=alpha-pass-123 node scripts/migrate.ts
# then seed two orgs with provision.createOrganization(...) and run:
CARRIER_DB_PATH=data/two.db npm run dev
```

Tests run with `node --conditions=react-server` (set in the `test` script) so `server-only`
resolves and Node's type-stripping works. Test DBs use a temp `CARRIER_DB_PATH` — **tests
never touch `data/carrier-hub.db`**.

---

## Gotchas learned this session (avoid re-discovering)

- **No TS parameter properties** (`constructor(readonly id: number)`) — Node's type-stripping
  loader rejects them. Use a plain field + assignment. (Bit us on the `Org` class.)
- **The query guard is fail-closed.** Any new query on a tenant table MUST include
  `organization_id` in its SQL, or it throws. Genuinely global access goes through
  `systemQuery()`. This applies to test-side assertion queries too.
- **`src/lib/auth.ts` cannot be imported by a test** — it imports `next/headers`, which
  does not resolve outside the Next runtime. Logic that needs a test goes in a module
  auth.ts imports, not in auth.ts.
- **`qrcode` ships no types** — `src/types/qrcode.d.ts` declares the one call used, rather
  than adding `@types/qrcode`.
- **`carrierNotes` lives in `activity.ts`**, not `notes.ts` (easy to mis-import).
- **Migration ordering:** migration 5 only creates/backfills an org when data already
  exists; a fresh DB gets its bootstrap org from `seed()` in `db.ts`. Don't make both create one.
- Repo docs at root; queries live in `src/lib/*.ts` (pages compose, they don't build SQL);
  write logic is split from Server Actions so it's testable (`notes.ts` vs `note-actions.ts`).

---

## Key files (multi-tenant)

| File | Role |
|---|---|
| `src/lib/tenant-db.ts` | `Org` class + `tenantTablesLackingScope()` (the guard's predicate) + `TENANT_TABLES` |
| `src/lib/db.ts` | connection, the fail-closed `guard()`, `systemQuery()`, `all/get/run`, per-org settings helpers |
| `src/lib/migrations.ts` | versioned migrations incl. 5 (tenancy), 6 (composite FKs), 7 (MFA) |
| `src/lib/provision.ts` | `createOrganization()` + `seedOrganizationData()` — the only place an org is made |
| `src/lib/auth.ts` | sessions and cookies: `requireOrg()`, `getPendingLogin()`, `completeSecondFactor()` |
| `src/lib/login.ts` | the sign-in rules with no request context — the testable half of `signIn()` |
| `src/lib/totp.ts` / `src/lib/mfa.ts` | RFC 6238 codes / enrolment, the sign-in check, recovery codes |
| `tests/cross-tenant.test.ts` | the 16-attack adversarial isolation suite |
| `tests/helpers.ts` | `seedOrg()` / `lookupId()` fixtures for multi-tenant tests |

Deploying it for someone to try: **`DEPLOY.md`**. Short version — it needs a Node server
with a disk that survives a restart (Railway/Fly/a VPS running the Dockerfile with a volume
at `/data`); GitHub Pages and Vercel cannot run it. Open signup needs an SMTP relay on
**port 465** (the mailer does implicit TLS only — Postmark has no 465 and will not work).
`npm run seed:demo` builds a populated *Demo Dispatch Co* organisation, isolated like any
other tenant, so a new visitor has something to look at.

GitHub: `git@github.com:ayush-singhh/Internal-tool.git` (the `main` branch is pushed; the
`multi-tenant` branch is pushed).
