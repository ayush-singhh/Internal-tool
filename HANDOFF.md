# Session Handoff — read this first to resume

This file is the resume point for a fresh session. It is kept current at the end of each
working session. For the full picture read, in order: `PRD.md` → `Architecture.md` →
`AI Rules.md` → `Plan.md` → `MIGRATION-PLAN.md`.

**Last updated:** 2026-08-29, after self-serve signup and email verification.

---

## Where things stand

**Product:** Carrier Management Hub — an internal Carrier CRM / operations dashboard for a
trucking dispatch company, now being turned into a **multi-tenant SaaS** sold to many
dispatch companies.

**Branch:** `multi-tenant` (NOT merged to `main`). `main` is at the single-tenant
"Phase 11 — sellable" state. Do not merge to `main` until the SaaS features below are done.

**Working tree:** clean. **Tests:** 216 passing (`npm test`). **Build:** clean.

**Stack:** Next.js 16 (App Router, RSC + Server Actions), React 19, TypeScript, Tailwind v4,
SQLite via `node:sqlite`. Runtime deps: `next`, `react`, `react-dom`, `server-only`,
`@node-rs/argon2`, `qrcode`.

---

## What is DONE

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

In `Plan.md` under "Phase 12 … Still to do". Suggested order:

1. **Self-serve password reset.** Only an administrator can issue a reset link today, so a
   signup owner who forgets their password has nobody to ask. Every piece exists —
   `reset.ts` issues and consumes the tokens, `mailer.ts` can send them — it needs a
   "forgot password" route with the same no-enumeration answer `/signup` gives.
2. **Invitations** — single-use, tenant-bound, expiring tokens (mirror `reset.ts`).
3. **Session hardening** — device/session list and revoke. (Rotation on sign-in and on
   completing MFA is already done.)
4. **RBAC UI** for owner/admin/member.
5. **Generalised audit log** + rate limiting beyond login and signup.
6. **Security headers / CSP.**
7. **Platform support role** — see decision 4.

---

## Decisions already made (do not re-litigate)

1. **Password hashing:** Argon2id via `@node-rs/argon2` (prebuilt binaries). **Done.**
2. **TOTP QR:** the `qrcode` package, rendered server-side. **Done.**
3. **Email:** hand-rolled SMTP over `node:tls`, configured by `SMTP_URL`, refusing to
   start in production when signup is open without it. **Done** — `src/lib/mailer.ts`.
4. **Platform support role:** the owner asked for standing access to look inside any
   tenant's data. They requested it be **unlogged and hidden from customers**. That specific
   design (deliberately concealed, tamper-free cross-tenant access to third-party PII) was
   **declined**. What to build instead, agreed as the workable version: **standing,
   read-only access to any tenant, always available (no customer approval gate), with an
   internal server-side audit log that is NOT surfaced in the customer UI, MFA required, no
   write access.** Emergency no-trace access is out-of-band (direct SQL on the server).
   This role is **not built yet** — until it exists there is no cross-tenant path at all.

---

## How to run / verify

```bash
npm test                         # 170 tests, node --test, no framework
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
- **Regenerating recovery codes is not built.** Running out means turning the second
  factor off with the last one and enrolling again.
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

GitHub: `git@github.com:ayush-singhh/Internal-tool.git` (the `main` branch is pushed; the
`multi-tenant` branch is local only unless pushed).
