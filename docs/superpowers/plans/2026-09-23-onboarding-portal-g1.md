# Onboarding Portal G1 — Implementation Plan

**Spec:** `docs/superpowers/specs/2026-09-23-carrier-onboarding-portal-design.md`

**Goal:** A carrier enters a USDOT, confirms the company, verifies its phone by SMS, and
opens a resumable application; a staff member reviews and converts it into a carrier.

**Architecture:** A second auth realm (`applicant_sessions`) outside `(app)`, writing to a
staging table (`carrier_applications`) that only a staff conversion turns into a `carriers`
row — the `convertLead()` pattern.

## Global constraints

- No new runtime dependencies. Hand-rolled REST, as `s3.ts` / `stripe.ts` (AI Rules §1).
- Never write `carriers` from portal input. Conversion only (AI Rules §2).
- Bound parameters everywhere, including `ORDER BY` allow-lists (AI Rules §4).
- Re-check permission inside every Server Action (AI Rules §4).
- Write logic in a plain module taking explicit ids; the action is a thin auth wrapper (§8).
- Tests: `node --test --conditions=react-server`, temp DB, `CARRIER_DB_PATH` set before any
  import, modules loaded via `await import()` inside `before()` (§8).
- Never edit a shipped migration; 25 is new (§9).
- OTP codes hashed at rest, compared with `timingSafeEqual`, never logged.

---

### Task 1 — Migration 25: the three tables

**Files:** modify `src/lib/migrations.ts`, `src/lib/tenant-db.ts` (TENANT_TABLES),
`src/lib/tenant-lifecycle.ts`. Test: `tests/application-schema.test.ts`.

- [ ] Failing test: tables exist; `carrier_applications` is in `TENANT_TABLES`; the partial
      unique index rejects a second draft for the same `(org, usdot)` but allows one after
      the first is converted; `foreign_key_check` passes; deleting an org clears all three.
- [ ] Implement migration 25 per spec §7. Composite FK to `carriers(organization_id, id)`.
- [ ] Add `carrier_applications` to `TENANT_TABLES`; leave the two session tables out
      (reached before an org is known, like `sessions`).
- [ ] Add all three to `tenant-lifecycle.ts` deletion, children first.
- [ ] Verify, commit.

### Task 2 — `src/lib/sms.ts`

**Files:** create `src/lib/sms.ts`. Test: `tests/sms.test.ts`.

**Produces:** `type Sms`, `type Sender`, `sender(): Sender`, `smsConfigured(): boolean`,
`twilioRequest(sms, creds, fetcher?)` (exported for the test).

- [ ] Failing test: request URL contains the SID; `Authorization` is basic SID:TOKEN;
      body is form-encoded `To`/`From`/`Body`; unconfigured throws in production and logs
      in development; a non-2xx response rejects.
- [ ] Implement, mirroring `mailer.ts`'s configured/unconfigured split exactly.
- [ ] Verify, commit.

### Task 3 — `src/lib/fmcsa.ts`

**Files:** create `src/lib/fmcsa.ts`. Test: `tests/fmcsa.test.ts`.

**Produces:** `type CarrierRecord`, `lookupUsdot(usdot, fetcher?)`.

- [ ] Failing test: parses a QCMobile payload into `CarrierRecord`; unconfigured returns
      `{ok:false,reason:"unconfigured"}`; a 404 and a thrown fetch both return `ok:false`
      without throwing; `allowedToOperate` reflects the payload.
- [ ] Implement with an injectable `fetcher` defaulting to global `fetch`.
- [ ] Verify, commit.

### Task 4 — `src/lib/applicant-otp.ts`

**Files:** create. Test: `tests/otp.test.ts`.

**Produces:** `issueCode(orgId, phoneDigits, now?)` → the plain code (for the sender only),
`verifyCode(orgId, phoneDigits, code, now?)` → `{ok:true} | {ok:false,reason}`.

- [ ] Failing test: a correct code verifies once and cannot be reused; a wrong code
      increments attempts; the 6th attempt fails even with the right code; an expired code
      fails; issuing a second code invalidates the first; **the stored row never contains
      the plain code**.
- [ ] Implement: 6 digits from `randomInt`, SHA-256 at rest, `timingSafeEqual`, 10-minute
      TTL, 5-attempt burn. `systemQuery()` — no org scope available at this layer.
- [ ] Verify, commit.

### Task 5 — `src/lib/applications.ts` + `applicant-auth.ts`

**Files:** create both. Test: `tests/applications.test.ts`.

**Produces:**
`startApplication(orgId, {usdot, legalName, ...})`, `getApplication(orgId, id)`,
`updateApplication(orgId, id, patch)`, `submitApplication(orgId, id)`,
`listApplications(org, status?)`, `convertApplication(org, id, userId)`,
`rejectApplication(org, id, userId, reason)`, `duplicateCarrierFor(org, usdot)`;
and in `applicant-auth.ts`: `openApplicantSession(orgId, applicationId)`,
`currentApplicant()`, `requireApplicant(slug)`, `endApplicantSession()`.

- [ ] Failing test: a draft resumes by phone rather than duplicating; `convertApplication`
      creates a carrier at `STATUS.ABOUT_TO_BE_ACTIVE` carrying only what was collected,
      writes a `carrier_activity` row, and marks the application converted; a converted
      application refuses further edits; `duplicateCarrierFor` finds an existing USDOT;
      reject requires a reason; **no cross-tenant read** (adversarial: org B cannot fetch
      org A's application).
- [ ] Implement. Conversion mirrors `convertLead()` (`leads.ts:174`).
- [ ] Verify, commit.

### Task 6 — The portal UI

**Files:** create `src/app/apply/[slug]/layout.tsx`, `page.tsx`, `verify/page.tsx`,
`application/page.tsx`, `src/lib/apply-actions.ts`, `src/lib/portal.ts` (slug→org,
`portalOpen()`).

- [ ] `portal.ts`: resolve slug to an active org with `portal_open` set; anything else is
      `notFound()` — closed and nonexistent are indistinguishable.
- [ ] Step 1 USDOT → FMCSA confirm-or-correct. Step 2 contact. Step 3 OTP. Step 4 draft.
- [ ] Actions re-validate server-side and rate-limit via `checkBurst`/`recordBurst`.
- [ ] Add `portal_open` to `SETTING_DEFS`, defaulting closed.
- [ ] Manual verification: `npm run build` registers the routes; a closed portal 404s.
- [ ] Commit.

### Task 7 — Staff review queue

**Files:** create `src/app/(app)/applications/page.tsx`,
`src/lib/application-actions.ts`; modify `src/lib/permissions.ts`, `src/lib/nav.ts`.

- [ ] Add `application:view` / `application:convert`; convert held by the roles that may
      convert a lead. Extend the permissions test.
- [ ] List oldest-first; detail shows FMCSA beside typed values and any duplicate warning.
- [ ] Convert and reject actions: `requireOrg()` then `can()` then delegate.
- [ ] Nav entry behind `application:view`.
- [ ] Commit.

### Task 8 — Docs

**Files:** `PRD.md` §1, `AI Rules.md` §4, `Plan.md`, `DEPLOY.md`.

- [ ] PRD §1: the product now has a public surface; say what it is and what it is not.
- [ ] AI Rules §4: name the applicant realm as the one authenticated area outside `(app)`.
- [ ] Plan.md: Phase 24, including what G2-G6 are and that they are not built.
- [ ] DEPLOY.md: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`, `FMCSA_WEB_KEY`.
- [ ] Full suite + `tsc --noEmit` + `npm run build`. Commit.
