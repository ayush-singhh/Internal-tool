# Migration Plan — Single-Tenant → Multi-Tenant SaaS (Option B)

Written **before** any schema change, per the rule that production data is not modified
without a plan. This document is the audit and the proposal. It is not yet implemented.

---

## 1. Audit of what exists today

### 1.1 Tables and their classification

| Table | Rows (prod) | Classification | Why |
|---|---|---|---|
| `carriers` | 0 | **Tenant-owned** | The core customer record |
| `carrier_notes` | 0 | **Tenant-owned** | Child of carrier |
| `carrier_activity` | 0 | **Tenant-owned** | Child of carrier; audit trail |
| `offboarding_records` | 0 | **Tenant-owned** | Child of carrier |
| `saved_filters` | 0 | **User-owned, within tenant** | Belongs to a user, scoped by their tenant |
| `users` | 1 | **Tenant-owned** (membership) | A person belongs to an organisation |
| `sessions` | 1 | **User-owned** | Derives tenant from its user |
| `password_resets` | 0 | **User-owned** | Derives tenant from its user |
| `app_settings` | 4 | **Tenant-owned** — *currently global, must change* | Attention thresholds and company name are per-organisation |
| `lookups` | 80 | **Tenant-owned** — *currently global, must change* | Settings lets a tenant retire a value; today that would change every other tenant's dropdowns |
| `login_attempts` | 0 | **Global (deliberately)** | Throttling by email/IP must work *before* a tenant is known |
| `schema_migrations` | 4 | **Global/system** | Schema state of the database itself |

Two reclassifications are load-bearing. `lookups` and `app_settings` look global but are
not: today, one company retiring the "Royal" plan or changing an attention threshold would
silently change it for every other company. That is a cross-tenant integrity bug, not a
cosmetic one.

### 1.2 Access surface

- **~56 SQL statements** across 11 library files. All go through the `all/get/run`
  helpers in `src/lib/db.ts` — there is exactly one choke point, which is what makes a
  centralised guard feasible.
- **17 routes** (15 pages, 2 API endpoints) and **9 Server Action modules**.
- **10 sites** read an id from a request (`params`, `formData`, `searchParams`) — the
  IDOR surface.
- **No background jobs, cron, or queues.** One less place to lose tenant context.
- **4 runtime dependencies.**

### 1.3 Existing data mapping

Production holds **0 carriers and 1 user** (the seeded administrator). A database with a
single organisation's data maps unambiguously to exactly one tenant — nothing is being
guessed. Migration assigns every existing row to one organisation whose name is supplied
explicitly at migration time (`MIGRATION_ORG_NAME`), defaulting to the existing
`company_name` setting. **If any future database is found to contain data that cannot be
attributed to a single organisation, the migration aborts rather than guessing.**

---

## 2. Proposed architecture

### 2.1 Tenant model

```
organizations (id, name, slug, created_at, status)
      │
      ├─< users            (organization_id, role, email UNIQUE per org)
      ├─< carriers         (organization_id)
      ├─< lookups          (organization_id)   ← seeded per organisation
      ├─< app_settings     (organization_id)   ← PK becomes (organization_id, key)
      └─< invitations      (organization_id)
```

### 2.2 Isolation — three independent layers

Defence in depth. Any one of these failing should not leak data.

**Layer 1 — the database refuses it.** Composite foreign keys mean a carrier cannot
reference another tenant's lookup row even if application code tried:

```sql
FOREIGN KEY (organization_id, status_id) REFERENCES lookups (organization_id, id)
```

**Layer 2 — the query layer refuses it.** `src/lib/db.ts` gains a guard: any SQL naming a
tenant-owned table is rejected at runtime unless issued through the tenant-scoped handle.
Fail-closed — a developer who forgets scoping gets an exception, not a leak. A narrow,
explicitly-named `systemQuery()` escape hatch exists for migrations, backups and
session lookup, and its call sites are enumerated in tests.

**Layer 3 — the repository enforces it.** Tenant-owned reads and writes go through
`tenantDb(user)`, which injects `organization_id` into every statement. Application code
never writes the predicate by hand.

Tenant is derived **only** from the server-side session. No request field is ever trusted.

### 2.3 Authentication

```
Email + password  →  MFA (TOTP)  →  session (rotated)  →  tenant authorization  →  app
```

- Password hashing: see Decision 1
- TOTP (RFC 6238), recovery codes hashed, replay prevented by storing the last used step
- Session rotation on privilege change; revocation on password reset
- Rate limits on login, OTP, reset, verification, invitation

### 2.4 Roles

`owner` › `admin` › `member` (dispatcher / account manager / viewer become member
sub-roles, preserving today's carrier-level scoping). Evaluated server-side only.

---

## 3. Risks and breaking changes

| Risk | Severity | Mitigation |
|---|---|---|
| A query site missed during conversion leaks data | **Critical** | Layer 2 fails closed — a missed site throws rather than returning another tenant's rows |
| Composite FK requires rebuilding `carriers` | High | SQLite cannot add an FK to an existing table; the migration creates the new table, copies, swaps, inside one transaction. Backup taken first |
| `lookups`/`app_settings` becoming per-tenant changes existing IDs | High | Migration remaps `status_id` etc. per row; verified by comparing label-for-label before and after |
| Existing sessions become invalid | Medium (breaking) | All sessions are revoked on migration; everyone signs in again. Correct, since sessions predate tenancy |
| MFA lockout for the sole admin | Medium | Recovery codes issued at enrolment; documented break-glass procedure |
| Email transport absent | **Blocks email verification and invitations** | See Decision 3 |

**Breaking changes:** every user signs in again; email uniqueness becomes per-organisation;
`app_settings` primary key changes; `lookups` ids are rewritten.

---

## 4. Sequenced implementation

Each phase ends green — tests passing, build clean — so nothing is half-migrated.

1. **Organisations + tenant columns** (migration, additive; backfill; abort-if-ambiguous)
2. **Layer 2 guard + `tenantDb`** — convert all ~56 query sites, fail-closed
3. **Composite FKs + per-tenant lookups/settings** (table rebuild in a transaction)
4. **Signup, organisation creation, email verification**
5. **TOTP MFA + recovery codes**
6. **Session hardening, active-session management, revocation**
7. **RBAC rework: owner/admin/member**
8. **Invitations**
9. **Audit log**
10. **Rate limiting generalised beyond login**
11. **Security headers, CSP**
12. **Adversarial cross-tenant test suite**
13. **Docs**

---

## 5. Decisions required before implementation

Resolved with the product owner:

1. **Password hashing:** Argon2id via `@node-rs/argon2` (prebuilt binaries — no compiler
   at install). True Argon2id, satisfies a buyer's security review by name.
2. **TOTP QR:** the `qrcode` package, rendered server-side to a `data:` URI so the secret
   never leaves the server; manual key shown as fallback.
3. **Email:** a small pluggable SMTP client over `node:tls` behind a `Mailer` interface,
   configured by `SMTP_URL`; refuses to start in production if unset rather than silently
   dropping verification mail.
4. **System-wide access:** a **platform support role** — standing, **read-only**, MFA
   required. Access is recorded to a **server-side internal audit log that is not surfaced
   to customers**. It is not customer-gated. Write access across tenants is deliberately
   not built: the role can read to support and diagnose, never silently alter another
   tenant's records. Emergency access with no application trace is out-of-band (direct SQL
   on the server, logged at the OS level).

   **Security invariant, restated precisely:** a user authenticated to Tenant A has no
   application path and no database path (composite foreign keys) to Tenant B's data. The
   sole exception is the platform support role, which is read-only, MFA-gated, and audited
   internally. This exception is stated here rather than hidden, because a security claim
   that is not exactly true is a worse liability than the access it conceals.
