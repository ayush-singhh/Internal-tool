# Carrier Onboarding Portal — Design

**Date:** 2026-09-23
**Status:** G1 approved for build. G2–G6 specified only as far as their boundaries.

## 1. What this is

A carrier signs itself up. It enters a USDOT number, confirms which company that is,
proves it holds the phone number, and fills in its fleet, documents, pricing and
signatures without a staff member typing any of it. At the end the carrier is a real
record in Carrier Hub and Asterism Services LLC is its authorised dispatcher.

Today every carrier is keyed in by staff. This moves the typing to the carrier and
leaves staff with a review queue.

## 2. Scope: six sub-projects, one built now

The request describes one linear journey, but it is six independently buildable
subsystems. Built as one unit, nothing is testable until all of it exists.

| | Sub-project | Delivers | Blocked on |
|---|---|---|---|
| **G1** | **Portal spine** — USDOT lookup, company confirmation, phone-OTP account, resumable application, staff review and conversion | A carrier can onboard itself and appear in Carrier Hub | SMS account |
| G2 | Fleet intake and uploads — drivers, trucks, trailers, equipment, selfie, CDL, truck/trailer photos, MC authority, insurance, NOA, **W-9** | The application carries everything staff need to approve | S3 (built) |
| G3 | Commercial terms — truck-count pricing tiers, add-on services, the quote | The carrier picks and sees what it will pay | G1 |
| G4 | E-signature — the dispatch service agreement | A signed, retained, auditable agreement | G3 |
| G5 | Payment authorisation — card or ACH | Asterism can charge the carrier | Stripe account |
| G6 | Welcome letter | Confirmation of authorised dispatcher | G4 |

**This document specifies G1.** Sections 3–10 are G1. Section 11 fixes the boundaries of
G2–G6 so G1 does not build something they have to tear up, and nothing more.

## 3. The rule this breaks, and how

`AI Rules.md` §2 opens with **"Never invent carrier records."** A public form writing
into `carriers` is the exact thing that rule exists to prevent.

It is not waived. Portal submissions land in a **staging table**, `carrier_applications`.
A staff member reviews one and converts it, and conversion is the only path from portal
input to a `carriers` row.

This is not a new pattern. `leads.ts:174` `convertLead()` already does precisely this:
a lead is staged, an administrator converts it once, a carrier is created at *About to Be
Active*, and the lead survives as the immutable record of how that carrier arrived. An
application behaves the same way and for the same reason.

Two further consequences:

- `PRD.md` §1 says the product is **"not a public-facing product."** This makes it one.
  That sentence is rewritten in the same change (`AI Rules.md` §10).
- `AI Rules.md` §4 says authenticated routes live only under `src/app/(app)/`. The portal
  is a second authentication realm outside it. §4 gains a sentence naming that realm, so
  the rule keeps meaning what it says.

## 4. Two realms, never crossing

| | Staff | Applicant |
|---|---|---|
| Identity | `users` row | `carrier_applications` row |
| Session table | `sessions` | `applicant_sessions` |
| Cookie | `ch_session` | `ch_applicant` |
| Entry | `/login` | `/apply/<org-slug>` |
| Reach | their organisation | **one application** |

An applicant session is an authorisation to edit exactly one application. It is not a
user, holds no role, appears in no team list, and is assignable to nothing. `requireUser()`
never returns one and `requireApplicant()` never returns a staff user — they read different
cookies and query different tables, so neither can be confused for the other.

The portal is served from `src/app/apply/`, a sibling of `(app)` and `support`. Nothing
under `src/app/(app)/` imports from it.

### Per-organisation, and closed by default

`organizations.slug` already exists and is unique, so the portal URL needs no new column:
`/apply/acme-dispatch` resolves to that organisation. An unknown or inactive slug is a 404.

A new `app_settings` key, `portal_open`, gates it, **defaulting to closed**. An
organisation publishes its portal deliberately; it does not acquire a public signup form
by upgrading. When closed the route 404s exactly as an unknown slug does, so the setting
does not leak which organisations exist.

## 5. The applicant journey (G1)

Four steps. Each one persists before advancing, so a carrier that closes the tab resumes
where it stopped rather than starting again.

**Step 1 — USDOT.** Digits only, validated server-side (`validate.ts` `digitsOnly`).
Looked up via FMCSA (§6). The result is shown for confirmation — legal name, DBA, state,
status — and the carrier either confirms or corrects the company name by hand. **The
looked-up name is never accepted silently**: an FMCSA record can be stale or wrong, and
`AI Rules.md` §2 forbids normalising a value without a human deciding. Where FMCSA is
unconfigured or unreachable, the step degrades to manual entry and says so.

**Step 2 — Contact.** Phone and email. Both validated server-side. The phone is stored
as entered *and* as `phone_digits`, matching `carriers` and `drivers`.

**Step 3 — Verify the phone.** A six-digit code, sent by SMS, valid for ten minutes.

- The code is **hashed with SHA-256 before storage** and never logged, and compared with
  `timingSafeEqual` — the same treatment `password_resets` gives its token
  (`reset.ts:27`, `reset.ts:134`; `AI Rules.md` §4).
- Five wrong attempts burns the code. Requesting a new one invalidates the previous.
- Sending is rate-limited per phone and per IP through the existing `checkBurst()` /
  `recordBurst()` in `throttle.ts`. No new throttling machinery.
- Verification is what creates the `applicant_sessions` row. Before it, there is no
  session and the application is unreachable.

**Step 4 — Application opened.** The application exists at `status = 'draft'` and the
carrier is returned to it on any later visit that proves the same phone number.

In G1 the journey ends here and the applicant submits. G2 inserts the fleet, document and
selfie steps between 4 and submission; G3–G5 follow them. The `step` column records the
furthest point reached, so adding steps later does not disturb applications already open.

### What "verified" means here

**OTP proves the phone number and nothing else.** It does not establish that the person
holds authority over the USDOT. The selfie in G2 is stored for a staff member to compare
against the CDL by eye — it is evidence for a human, not automated identity verification.
Actual verification (liveness, document matching) is a vendor product — Stripe Identity,
Persona — and is not in any sub-project here. The UI says "phone verified", never
"identity verified", because the second would be a claim the system cannot support.

## 6. Two external services

Both follow the hand-rolled-REST-client convention (`AI Rules.md` §1) already used by
`s3.ts` (SigV4) and `stripe.ts`. No SDKs, no new runtime dependencies.

### `src/lib/sms.ts` — Twilio

Modelled line-for-line on `mailer.ts`:

```ts
export type Sms = { to: string; body: string };
export type Sender = (sms: Sms) => Promise<void>;
export function sender(): Sender;
export function smsConfigured(): boolean;
```

`POST https://api.twilio.com/2010-04-01/Accounts/{SID}/Messages.json`, HTTP basic auth,
form-encoded `To` / `From` / `Body`. Env: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_FROM`.

Unconfigured behaviour is `mailer()`'s exactly: **throw in production**, and in
development return a sender that logs the message. A developer can complete the whole
flow with no Twilio account by reading the code off the console.

**This is the one thing that must be bought.** Roughly $0.0079 per SMS plus about $1.15/mo
for the number. Without it the portal cannot verify a phone in production.

### `src/lib/fmcsa.ts` — USDOT lookup

```ts
export type CarrierRecord = {
  usdot: string; legalName: string; dbaName: string | null;
  state: string | null; allowedToOperate: boolean;
};
export async function lookupUsdot(
  usdot: string, fetcher?: Fetcher,
): Promise<{ ok: true; carrier: CarrierRecord } | { ok: false; reason: string }>;
```

FMCSA QCMobile: `GET https://mobile.fmcsa.dot.gov/qc/services/carriers/{usdot}?webKey=…`.
Env `FMCSA_WEB_KEY` — **free**, registration only. Unconfigured returns
`{ ok: false, reason: "unconfigured" }` and step 1 falls back to manual entry, so the
portal works without it. The injectable `fetcher` is the `stripe.ts` pattern, and is how
this is tested without network.

A carrier whose FMCSA record says it is not allowed to operate is **not blocked** — it is
recorded on the application and surfaced to the reviewing staff member. Whether to onboard
is a commercial decision, not one this code makes.

## 7. Schema — migration 25

Three tables. Only `carrier_applications` joins `TENANT_TABLES`; the other two are
session-layer tables reached before an organisation is known, exactly like `sessions` and
`password_resets`, and are queried through `systemQuery()`.

```
carrier_applications
  id, organization_id, usdot, legal_name, dba_name, operating_state,
  allowed_to_operate INTEGER, name_source TEXT ('fmcsa'|'manual'),
  phone, phone_digits, email,
  status TEXT NOT NULL DEFAULT 'draft',      -- draft|submitted|approved|rejected
  step TEXT NOT NULL DEFAULT 'account',      -- furthest step reached
  review_notes, rejected_reason,
  converted_carrier_id, converted_at, converted_by,
  created_at, updated_at, submitted_at
  FOREIGN KEY (organization_id) REFERENCES organizations(id)
  FOREIGN KEY (organization_id, converted_carrier_id)
    REFERENCES carriers(organization_id, id)

applicant_sessions
  id TEXT PRIMARY KEY, organization_id, application_id, created_at, expires_at

applicant_otps
  id, organization_id, phone_digits, code_hash, expires_at,
  attempts INTEGER NOT NULL DEFAULT 0, consumed_at, created_at
```

A **partial unique index** on `(organization_id, usdot) WHERE status IN ('draft',
'submitted')` allows exactly one open application per carrier per organisation, while
leaving any number of historical converted or rejected ones.

Duplicate USDOTs against *existing carriers* are **not** blocked. Conversion warns the
staff member that a carrier with that USDOT is already on file and lets them decide —
matching how import handles duplicates, and `AI Rules.md` §2's rule that cleanup is a
human decision.

`tenant-lifecycle.ts` deletes all three tables, in order, when an organisation is removed.

## 8. Staff side

A new page, `/applications`, inside the `(app)` group and therefore behind
`requireUser()`. Two new permissions, `application:view` and `application:convert`.
Conversion writes a carrier, so it is held by the same roles that may convert a lead —
administrators and owners. Everyone with carrier access may view the queue.

The list shows open applications oldest-first, because the oldest is the one most likely
to be going cold. Opening one shows everything submitted, the FMCSA record beside what
the carrier typed where they differ, and any duplicate-USDOT warning.

Conversion creates a carrier at **About to Be Active** (`STATUS.ABOUT_TO_BE_ACTIVE`),
carrying across legal name, USDOT, phone, `phone_digits` and email — and **nothing
invented**. Fields the portal did not collect are left null for staff to complete. It
writes a `carrier_activity` entry attributing the origin, the same way `convertLead()`
does. The application survives, marked converted and pointing at the carrier, read-only
from then on.

Rejection requires a reason and is equally final.

## 9. Security

- **Rate limiting.** OTP sends and verification attempts both go through `throttle.ts`'s
  existing burst limiter, keyed on phone digits and on IP.
- **No code in a log, ever.** The OTP is hashed at rest, and `AI Rules.md` §4's rule
  against logging credentials covers it.
- **Enumeration.** A closed portal and a nonexistent organisation return the same 404. A
  wrong OTP and an expired OTP return the same message.
- **Bound parameters everywhere**, including the status filter on the applications list
  (`AI Rules.md` §4).
- **Uploads are not in G1.** G2 adds them, and inherits `documents.ts`'s existing
  content-type allow-list and size cap rather than inventing a second one.
- **The applicant session reaches one application.** Every query is scoped by both
  `organization_id` and `application_id` from the session row — never from the URL.
- **Re-check permission inside every Server Action** (`AI Rules.md` §4). The convert and
  reject actions both call `can()` after `requireOrg()`.

## 10. Testing

`node --test`, temp database per file, `CARRIER_DB_PATH` set before any import, modules
loaded with `await import()` inside `before()` (`AI Rules.md` §8).

| File | Covers |
|---|---|
| `tests/application-schema.test.ts` | migration 25 shape, the partial unique index, tenant-lifecycle cleanup |
| `tests/otp.test.ts` | issue, verify, expiry, attempt burn, reissue invalidates, hash-at-rest |
| `tests/fmcsa.test.ts` | parsing, unconfigured, network failure, not-allowed-to-operate — all via injected `fetcher` |
| `tests/sms.test.ts` | Twilio request shape and auth header, unconfigured dev/prod behaviour |
| `tests/applications.test.ts` | draft lifecycle, resume, convert→carrier, duplicate warning, reject, converted-is-read-only |

Write logic lives in plain modules taking an explicit id; the Server Action is a thin auth
wrapper (`AI Rules.md` §8).

## 11. Boundaries of G2–G6

Fixed here only so G1 does not build something these must undo.

- **G2 — fleet and documents.** Drivers, trucks, trailers, equipment and every upload,
  including the selfie **and the W-9** (see the decision below). Needs a repeating child
  table (`application_drivers`) and a document table generalised from `load_documents`.
  **G1 must not** assume an application has exactly one driver or a fixed document set.
- **G3 — pricing.** Tiers by truck count: 1–3 → 5%, 4–10 → 3.75%, 11+ → 2.75%. These are
  `lookups` rows (`AI Rules.md` §3), never hardcoded labels; the count→tier rule is code
  with a test. Add-ons: Safety & Compliance $50/truck/mo, After Hours $250 flat,
  IFTA/accounting $100/truck/mo. Truck count comes from G2, so G3 follows it.
- **G4 — e-signature.** The dispatch service agreement, and nothing else. Hand-rolled:
  typed name, explicit consent checkbox, IP, user-agent, timestamp, and a SHA-256 of the
  exact rendered document, so what was signed can be proven later. An ordinary commercial
  contract signed electronically is what the ESIGN Act exists for; this carries no special
  compliance burden.

### The W-9 is collected, not signed here — decided 2026-09-24

The original design had the carrier e-sign a W-9 in the portal. **It no longer does.**

A W-9 is certified *under penalty of perjury*, and the IRS attaches specific requirements
to accepting one electronically — including being "reasonably certain the person
submitting is the person named on the form". Phone OTP proves somebody holds a phone. It
does not establish that the signer is an officer of the carrier authorised to certify a
TIN, and closing that gap means buying identity verification.

So the portal stops hosting the signature. Every carrier already has a W-9 its accountant
prepared; G2 asks them to upload it alongside MC authority, insurance and the NOA. What is
needed is the *information* and a retained copy — not a signature ceremony this product is
responsible for. This removes the compliance surface rather than managing it, costs
nothing, adds no vendor, and matches what a dispatcher does today.

The alternatives, recorded so the decision is legible later: a vendor W-9 flow
(Dropbox Sign, DocuSign — roughly $15-40/month, keeps the carrier inside the portal), or
building to the IRS requirements directly, which needs identity verification and therefore
collapses into paying a vendor anyway.
- **G5 — payment authorisation.** Card or ACH, letting Asterism charge the carrier. This
  is a *different* Stripe integration from the parked subscription billing, which bills
  the organisation for using Carrier Hub. Different payer, different objects. They share
  only `stripe.ts`'s transport.
- **G6 — welcome letter.** Confirmation that Asterism Services LLC is the authorised
  dispatcher. Small, and folds into G4's completion.

## 12. Not built, and deliberately

- Automated identity verification. The selfie is evidence for a human.
- Any carrier-facing surface after onboarding. The portal is for becoming a carrier, not
  for being one.
- Editing an application after conversion. It is history, like a converted lead.
- Email verification. G1 verifies the phone, which is what was asked for. The email is
  recorded and used later, not proven now.
- Resuming by email link. Resumption proves the phone, the same way entry did.
