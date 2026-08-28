# Session Handoff — read this first to resume

This file is the resume point for a fresh session. It is kept current at the end of each
working session. For the full picture read, in order: `PRD.md` → `Architecture.md` →
`AI Rules.md` → `Plan.md` → `MIGRATION-PLAN.md`.

**Last updated:** 2026-08-28, end of multi-tenant Phase 2.

---

## Where things stand

**Product:** Carrier Management Hub — an internal Carrier CRM / operations dashboard for a
trucking dispatch company, now being turned into a **multi-tenant SaaS** sold to many
dispatch companies.

**Branch:** `multi-tenant` (NOT merged to `main`). `main` is at the single-tenant
"Phase 11 — sellable" state. Do not merge to `main` until the SaaS features below are done.

**Working tree:** clean. **Tests:** 170 passing (`npm test`). **Build:** clean.

**Stack:** Next.js 16 (App Router, RSC + Server Actions), React 19, TypeScript, Tailwind v4,
SQLite via `node:sqlite`. Runtime deps: `next`, `react`, `react-dom`, `server-only`,
`@node-rs/argon2`, `qrcode`.

---

## What is DONE (multi-tenant Phase 2 — tenant isolation)

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

1. **Password hashing scrypt → argon2id.** `@node-rs/argon2` is installed and verified
   (produces `$argon2id$` hashes). `src/lib/password.ts` still uses scrypt; migrate with a
   verify-then-rehash-on-login path so existing hashes keep working.
2. **TOTP MFA + recovery codes.** `qrcode` installed (render the otpauth URI to a data: URI
   server-side — secret never leaves the server). Enrollment → verify-before-activate →
   require OTP at login → hashed recovery codes → rate-limited OTP → replay prevention
   (store last-used step). New `mfa_*` tables via a new migration.
3. **Secure signup + organisation creation + email verification.** `createOrganization()`
   in `provision.ts` already builds an org+owner+vocabularies atomically. Needs a signup
   route, email verification tokens, and SMTP (see decision 3 below).
4. **Invitations** — single-use, tenant-bound, expiring tokens (mirror `reset.ts`).
5. **Session hardening** — rotation on privilege change, device/session list, revoke.
6. **RBAC UI** for owner/admin/member.
7. **Generalised audit log** + rate limiting beyond login (throttle.ts is login-only today).
8. **Security headers / CSP.**
9. **Platform support role** — see decision 4.

---

## Decisions already made (do not re-litigate)

1. **Password hashing:** Argon2id via `@node-rs/argon2` (prebuilt binaries; installed).
2. **TOTP QR:** the `qrcode` package, rendered server-side (installed).
3. **Email:** hand-rolled pluggable SMTP over `node:tls` behind a `Mailer` interface,
   configured by `SMTP_URL`; refuse to start in production if unset. (Not built yet.)
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
| `src/lib/migrations.ts` | versioned migrations incl. 5 (tenancy) and 6 (composite FKs) |
| `src/lib/provision.ts` | `createOrganization()` + `seedOrganizationData()` — the only place an org is made |
| `src/lib/auth.ts` | `requireOrg()` → `{ user, org }` from the session |
| `tests/cross-tenant.test.ts` | the 16-attack adversarial isolation suite |
| `tests/helpers.ts` | `seedOrg()` / `lookupId()` fixtures for multi-tenant tests |

GitHub: `git@github.com:ayush-singhh/Internal-tool.git` (the `main` branch is pushed; the
`multi-tenant` branch is local only unless pushed).
