# Stripe Billing — Design

Turns Carrier Hub into something that can be sold: a fourteen-day trial with a card taken
up front, then a flat monthly or yearly subscription per company. This is the spec;
`docs/superpowers/plans/2026-09-06-stripe-billing.md` is the task-by-task plan.

## 1. Scope — built now, and deliberately not

The subsystem is built **whole but detached**. Everything below ships and works end to end
— an owner can open `/subscription`, start a trial, be charged by Stripe, and manage their
card — but **nothing in the application is gated on any of it**. No page redirects, no
Server Action refuses, no write is blocked. The live tenant runs exactly as it does today.

That is the client's explicit instruction, and it is also the right order. Billing has two
halves with very different risk: the half that talks to Stripe (many moving parts, easy to
test in isolation, harmless if wrong) and the half that decides who gets locked out (few
lines, catastrophic if wrong). Building the first without the second means the payment
machinery can be exercised against a live Stripe test account for as long as it takes,
while the blast radius stays zero.

| | Ships now (Phase A) | Held back (Phase B) |
|---|---|---|
| Schema | migration 24 | — |
| Stripe client, webhook | yes | — |
| `/subscription` page, Checkout, Portal | yes | — |
| `entitlement()` and its tests | yes | — |
| Gate in `requireOrg()` | **no** | yes |
| Read-only write block | **no** | yes |
| Signup starts a trial | **no** | yes |
| `/subscription` in the sidebar | **no** | yes |
| Boot check for Stripe env vars | **no** | yes |

Phase B is a small, separate commit. Section 9 specifies it so that Phase A is built to
receive it, not so that it is written now.

## 2. Why Stripe

The question asked was whether Stripe is right for B2B SaaS. It is, for this shape of
business:

- **ACH is the reason.** At a few hundred dollars a month per company, card interchange
  (2.9% + 30¢) is real money and US freight companies pay by bank transfer anyway. Stripe
  does ACH debit at 0.8% capped at $5. On a $500/month subscription that is $19.50 versus
  $5. Nothing else in reach prices bank debit that well.
- **Billing and the Customer Portal are included.** Trials, proration, dunning, retries,
  card-update emails, invoices and receipts are all Stripe's, not ours. The Portal alone
  removes an entire screen we would otherwise build and get wrong.
- **The webhook contract is stable and documented**, which is what makes a hand-rolled
  client (section 6) reasonable rather than reckless.

What was considered and rejected: **Paddle / Lemon Squeezy** are Merchants of Record — they
become the seller and take on sales-tax registration and remittance worldwide, for roughly
5% + 50¢ and no ACH. That is a good trade for a solo developer selling to fifty countries
and a poor one for US freight dispatch, where the tax exposure is a handful of states and
the payment mix is bank transfer. **Chargebee / Recurly** are billing layers that still
need Stripe underneath; they earn their keep at usage-based pricing and complex entitlement
matrices, neither of which this is. **RevenueCat** is for App Store and Play Store
subscriptions and does not apply.

The one thing Stripe does not do is **register** us for sales tax. Stripe Tax will
calculate and collect once we are registered, but economic-nexus registration in each state
stays a job for whoever holds the company. This is the single reason to revisit the
Merchant-of-Record option, and it becomes pressing only if we sell into the EU or UK.

## 3. Commercial shape

**Flat per company.** One price per organisation per period, whatever the headcount. No
seat counting, no metered usage, no proration arithmetic of our own. A five-person
dispatch office and a fifty-person one pay the same, and adding a colleague never produces
a surprise invoice — which is the behaviour that makes a small operator willing to invite
their whole team, which is what makes the product sticky.

**Two prices, monthly and yearly**, both created in the Stripe dashboard. The amounts live
in Stripe and nowhere else. This codebase must never contain a price: the page renders what
Stripe says it will charge (section 8), so the number on the button and the number on the
card statement cannot drift apart.

**Fourteen days, card up front.** `subscription_data[trial_period_days]=14` on the Checkout
Session. Stripe collects and validates the card at signup, charges nothing, and bills
automatically on day fifteen. The trade-off was taken knowingly: requiring a card cuts trial
starts substantially compared with a no-card trial, and raises the quality of the ones that
remain. For a product sold to businesses rather than to consumers browsing, and where every
trial costs us a real onboarding conversation, filtering early is worth more than volume.

## 4. Schema — migration 24

Migration 23 (`working notes`) is the last shipped, so this is 24. Additive only: six
columns on `organizations` and one new global table. No table rebuild, no data movement,
nothing destructive — so the existing production database (three users, twenty-one
carriers) takes it without a backup dance beyond the snapshot the container already takes
on every boot.

```sql
ALTER TABLE organizations ADD COLUMN stripe_customer_id     TEXT;
ALTER TABLE organizations ADD COLUMN stripe_subscription_id TEXT;
ALTER TABLE organizations ADD COLUMN plan                   TEXT;     -- 'monthly' | 'yearly'
ALTER TABLE organizations ADD COLUMN trial_ends_at          TEXT;     -- ISO 8601
ALTER TABLE organizations ADD COLUMN current_period_end     TEXT;     -- ISO 8601
ALTER TABLE organizations ADD COLUMN billing_mode           TEXT NOT NULL DEFAULT 'stripe';

CREATE TABLE IF NOT EXISTS stripe_events (
  id          TEXT PRIMARY KEY,   -- Stripe's evt_… , the idempotency key
  type        TEXT NOT NULL,
  received_at TEXT NOT NULL
);
```

Then, in the same migration:

```sql
UPDATE organizations SET billing_mode = 'comped';
```

**The default and the backfill point in opposite directions on purpose.** The column
defaults to `'stripe'` so that every organisation created from here on is one we expect to
be paid for — a row that slips through some future code path without an explicit billing
mode fails *closed*, into the paying lane, rather than becoming free forever. The one-time
`UPDATE` then grandfathers every organisation that already exists at the moment the
migration runs: the live tenant, the bootstrap admin org, and every fixture. A `comped`
organisation is never paywalled and never talks to Stripe.

`seed()` in `db.ts` — the first-run bootstrap that creates the admin organisation on a
fresh install — inserts `billing_mode = 'comped'` explicitly. Whoever self-hosts this and
bootstraps their own org is not a Stripe customer of ours.

Phase A touches exactly three existing *source* files, and no others: `migrations.ts`
(append migration 24), `db.ts` (that one `seed()` insert), and
`scripts/set-billing-status.ts` (below). Everything else it adds is a new file, and the
only other edits are to `Plan.md` and `DEPLOY.md`.

`organizations` is not in `TENANT_TABLES`, so the isolation guard does not fire on it;
reads and writes still go through `systemQuery()` for the same reason
`scripts/set-billing-status.ts` does — it documents that this is a global table, not a
tenant one. `stripe_events` is global for the same reason and is likewise not added to
`TENANT_TABLES`.

**No `lapsed_at` column.** The date an organisation lost access is always one it already
has: `trial_ends_at` for an expired trial, `current_period_end` for a cancelled
subscription. Deriving it costs one ternary and removes a column that two code paths would
have to remember to write.

`scripts/set-billing-status.ts` gains `comped` and `stripe` as accepted arguments,
writing `billing_mode` rather than `status`. The script's stated job is "set an
organisation's billing standing by hand" and this is billing standing; it does not justify
a second script.

## 5. `entitlement()` — the one place the question is answered

```ts
export type Access = "full" | "read_only" | "none";
export type Entitlement = { access: Access; notice: string | null; until: string | null };
export function entitlement(org: OrgBilling, now?: Date): Entitlement;
```

A pure function of an organisation's six billing columns and the clock. No request context,
no database, no network — so every state below is a unit test that runs in microseconds.
The gate (Phase B), the banner, and the `/subscription` page all read from this, which is
what stops them from disagreeing with each other.

| Condition | `access` | `notice` |
|---|---|---|
| `billing_mode = 'comped'` | full | none |
| no `stripe_subscription_id` | read_only | "Start your free trial" |
| `status = 'active'` | full | none |
| `status = 'past_due'` | full | "Payment failed — update your card" |
| `status = 'trial'`, trial not yet over | full | "Trial ends in N days" |
| lapsed, within 30 days | read_only | "Trial ended" / "Subscription ended" |
| lapsed, over 30 days | none | "Account inactive — resubscribe to restore access" |

**Lapsed** means `status` is `trial` with `trial_ends_at` in the past, or `suspended`. The
date it lapsed is `trial_ends_at` in the first case and `current_period_end` in the second.
Where that date is missing — a subscription cancelled before its first period closed — the
organisation is treated as having just lapsed, so it gets read-only and its thirty days
rather than falling straight to `none`. Rows are evaluated top to bottom and the first
match wins, so `comped` outranks everything and a missing subscription outranks any status.

Three of these deserve their reasoning recorded.

**`active` grants full access with no date check.** The obvious-looking alternative — also
requiring `current_period_end` to be in the future — fails in the worst possible direction:
a webhook we miss on renewal night locks out a customer who has just paid us. Trusting the
mirrored status means a missed webhook fails *open* for someone who has paid, which is the
correct way round. `current_period_end` is display only: "renews on the 3rd".

**`past_due` keeps full access.** Stripe's Smart Retries chase a failed card for up to
three weeks before giving up, and a card that expired on the first of the month is the most
ordinary event in subscription billing. Cutting a paying customer to read-only on the first
declined charge is a way to lose them over a clerical error. When Stripe exhausts its
retries it moves the subscription to `canceled` or `unpaid`, we mirror that as `suspended`,
and access degrades then. The length of the grace period is therefore configured once, in
the Stripe dashboard's dunning settings, rather than duplicated as a constant here.

**Trial expiry is checked against the clock as well as the status.** Everywhere else the
mirrored status is trusted; here it is not, because this is the one transition where
trusting it fails open into free service. If the `customer.subscription.updated` webhook
that ends a trial never arrives, the date still ends it.

## 6. The Stripe client — REST, not the SDK

`src/lib/stripe.ts`, in the shape of `src/lib/s3.ts`: form-encoded `POST` over `fetch`
with a Bearer key, and one HMAC-SHA256 from `node:crypto` for webhook signatures. Around
120 lines against a dependency of several megabytes, for four calls:

- `POST /v1/checkout/sessions` — start a trial
- `POST /v1/billing_portal/sessions` — hand off card changes, plan changes, cancellation
- `GET /v1/subscriptions/{id}` — re-read the truth when a webhook arrives
- `GET /v1/prices/{id}` — what the page is allowed to claim we will charge

AI Rules §1 requires a justification for any runtime dependency and names the ladder that
comes first. `fetch`, `URLSearchParams` and `node:crypto` are all stdlib, and s3.ts already
established that a hand-rolled request against a frozen, documented, test-vectored protocol
is the house answer. Stripe's form encoding is bracket notation over nested objects
(`line_items[0][price]=…`), which is one recursive twenty-line flattener.

The client is a thin transport: it signs, sends, and throws with Stripe's own error message
on a non-2xx. It holds no business logic, so it needs no knowledge of trials, plans or
organisations. Price lookups are memoised in a module-level `Map` with a ten-minute TTL —
the page renders on every request and the price changes about once a year.

## 7. The webhook

`src/app/api/stripe/webhook/route.ts`. AI Rules §5 reserves `src/app/api/` for file
downloads, and this is a **deliberate, documented exception**: a webhook is an unauthenticated
POST from another machine, which is precisely what a Server Action is not. The rule's intent
— that our own mutations go through Server Actions rather than hand-rolled endpoints — is
untouched. A comment in the file says so, so the next reader does not have to relitigate it.

Four things, in order:

1. **Verify the signature.** `Stripe-Signature: t=…,v1=…`; HMAC-SHA256 of `${t}.${rawBody}`
   keyed with the endpoint secret, compared with `timingSafeEqual`. Read the body as raw
   text before any parsing — a re-serialised JSON body will not match its own signature.
2. **Reject a stale timestamp.** Outside a five-minute tolerance the request is refused,
   so a captured payload cannot be replayed later.
3. **Dedupe on `stripe_events.id`.** Stripe retries, and its at-least-once delivery means
   the same event arrives more than once as a matter of routine. The primary key is the
   whole mechanism: an insert that conflicts means we have already handled it, and the
   handler returns 200 without doing the work twice.
4. **Re-fetch the subscription from Stripe rather than trusting the event body.** Stripe
   does not guarantee delivery order, and an out-of-order pair — a cancellation arriving
   before the update that preceded it — is the classic way an account ends up in a state
   nobody chose. Reading the current subscription makes ordering irrelevant: whatever the
   event was, we write what is true now.

Events subscribed: `checkout.session.completed` (link the customer and subscription to the
organisation), `customer.subscription.updated`, `customer.subscription.deleted`. The
organisation is found by `stripe_customer_id`, or on the first event by the
`client_reference_id` we set to the organisation id when creating the Checkout Session.

`plan` is written here too, by comparing the subscription's price id against
`STRIPE_PRICE_MONTHLY` and `STRIPE_PRICE_YEARLY`; a price matching neither — an older price
still attached to a long-standing customer — leaves `plan` null, which the page renders as
"Custom plan" rather than guessing.

Status mapping, the only translation between Stripe's vocabulary and `ORG_STATUS`:

| Stripe | `organizations.status` |
|---|---|
| `trialing` | `trial` |
| `active` | `active` |
| `past_due`, `incomplete` | `past_due` |
| `canceled`, `unpaid`, `incomplete_expired` | `suspended` |

`ORG_STATUS` has existed since the multi-tenant work and has never had anything write to
it but a manual script. This is the wiring it was defined for.

A webhook that cannot find its organisation returns 200 and logs. Returning an error would
make Stripe retry an event that will never succeed, for days.

## 8. `/subscription`

`/billing` is already taken — it is the tenant's own receivables from their carriers — so
the SaaS subscription screen is `/subscription`. The collision would be genuinely confusing
in a product whose customers also invoice people.

The page lives under `(app)` and calls `requireOrg()` itself, as every page there does —
the layout's call is defence in depth, never the boundary, for the reason section 9 gives.
It renders:

- **Where you stand**, straight from `entitlement()`: days left in the trial, the renewal
  date, or what lapsed and when.
- **Two plan cards**, monthly and yearly, with the amounts fetched from Stripe at render.
- **One button.** No subscription yet: "Start 14-day free trial" → Checkout. Subscribed:
  "Manage billing" → Customer Portal, which owns card changes, plan switches, invoice
  history and cancellation. We build none of those screens.

**Everyone may view the page; only `settings:manage` may act.** Viewing is deliberately
ungated so that a dispatcher who finds the app read-only in Phase B can read what happened
and who to ask, rather than meeting a blank 403. Both Server Actions re-check
`settings:manage` themselves — AI Rules §4, and BUGS.md records what happened the two times
a check was left to the UI. `settings:manage` resolves to owner and admin, which is the
right pair for who holds the company card; no new `Action` is added to `permissions.ts`.

The write logic lives in `src/lib/subscription.ts` (plain module: read the billing row,
build a Checkout Session, build a Portal session) with `src/lib/subscription-actions.ts`
as the thin auth wrapper, following the `notes.ts` / `note-actions.ts` pair that AI Rules
§8 names as the reference.

Both actions end in `redirect()` to a Stripe URL. Stripe returns the customer to
`/subscription?checkout=success`, which is a display hint only — **the page never treats a
return from Checkout as proof of payment.** Only the webhook writes billing state. A user
can type that query string.

## 9. Phase B — the enforcement, specified but not built

Recorded here so Phase A is shaped to receive it.

**The gate belongs in `requireOrg()`, not in a layout.** `auth.ts` already carries the
comment explaining why, and it was written the expensive way: enforcing `/support` in its
layout let any signed-in user read every other tenant's carriers out of the body of a 404,
because Next renders a layout and its page concurrently and `notFound()` in a layout stops
neither. `requireOrg()` is the single funnel that 42 of 49 Server Actions and every tenant
page already pass through. The seven actions on `requireUser()` alone — MFA enrolment and
session management — stay reachable by design, so nobody is locked inside a session they
cannot end.

**Read-only is enforced in `run()` and `exec()`**, refusing writes and bypassed by
`systemQuery()` exactly as the tenant guard is, so sessions, the audit log, the error log
and the webhook itself keep working while a tenant is read-only. The subtlety is that this
state is per-request: a module-level flag in the shape of `bypassGuard` works only because
`bypassGuard` wraps synchronous `node:sqlite` calls and never spans an `await`. A
request-scoped flag does span awaits, and in a shared Node process it would leak between
concurrent requests belonging to different organisations. It therefore lives in
`AsyncLocalStorage` (`node:async_hooks`, stdlib), about twenty lines.

The alternative — an explicit `requireOrg({ write: true })` at 42 call sites — is less
machinery and was rejected: it is forgettable, and this codebase has twice shipped a
missing check of exactly that kind, including `/reports` going fourteen phases with no
`can()` at all. A chokepoint cannot be forgotten at a site nobody remembered to visit.

Phase B also: starts new signups on `billing_mode = 'stripe'` (already the column default,
so this is only the trial hand-off after email verification), adds `/subscription` to the
sidebar, and adds `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` / `STRIPE_PRICE_MONTHLY` /
`STRIPE_PRICE_YEARLY` to the boot check in `src/instrumentation.ts` behind
`BILLING_ENFORCED=1`. No boot check ships in Phase A: a deploy without Stripe keys must
keep starting, because that is what production is today.

## 10. Configuration

| Variable | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_…` now, `sk_live_…` later |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…`, from the endpoint's own page |
| `STRIPE_PRICE_MONTHLY` | `price_…` |
| `STRIPE_PRICE_YEARLY` | `price_…` |
| `BILLING_ENFORCED` | Phase B only; unset and unread in Phase A |

Set with `fly secrets set`, never in `fly.toml`, which is in git. `stripe.ts` throws a clear
error naming the missing variable when a call is attempted without one — which is the whole
of Phase A's failure mode, since nothing calls it unless somebody opens `/subscription`.

Amounts appear in no file. They are set once in the Stripe dashboard by whoever owns the
account.

## 11. Testing

Unit, `node --test --conditions=react-server`, temp database per file as every existing
test does:

- **`entitlement()` across every row of the section 5 table**, including the two that
  matter most: a `comped` organisation keeps full access under every combination of the
  other columns, and an `active` subscription with a `current_period_end` in the past still
  grants full access.
- **Signature verification** against a payload signed with a known secret; a forged
  signature, a truncated one, and a timestamp outside tolerance are each rejected.
- **Idempotency**: the same event delivered twice writes the organisation once.
- **Out-of-order delivery**: a `deleted` event followed by a stale `updated` leaves the
  organisation suspended, because both re-read from Stripe.
- **Form encoding**: nested objects flatten to the bracket notation Stripe documents.
- **Migration 24**: applied to a database holding organisations, every pre-existing row
  comes out `comped`, and a row inserted afterwards comes out `stripe`.

Stripe's HTTP is injected rather than imported, the way `startSignup` takes its `Mailer`,
so no test reaches the network.

Phase A adds **no** test asserting that anything is blocked, because nothing is. The gate
tests — a locked organisation redirected to `/subscription`, a read-only organisation
refused a write and permitted a read — belong to Phase B and are written with it.

## 12. What is explicitly not built

- **No enforcement anywhere.** Section 1.
- **No seats, no usage metering, no per-carrier pricing.** Flat per company was the
  decision; the schema does not block adding a seat count later.
- **No coupons, no referral codes, no annual-prepay discount logic.** Stripe issues
  coupons from its own dashboard against the same prices, which covers every case we can
  currently name without a line of code here.
- **No invoice or receipt rendering.** The Customer Portal has both.
- **No dunning emails of our own.** Stripe's are better and already written.
- **No self-serve plan switching UI.** The Portal does it.
- **No Stripe Tax.** It is a flag on the Checkout Session and costs nothing to add, but
  turning it on before we are registered anywhere would collect tax we cannot remit.
- **No audit-log entry for starting or changing a subscription.** It would mean a new
  `AUDIT` constant and a fourth modified file, to record something Stripe already records
  better — its dashboard knows who paid, when, with which card, and what changed. Add one
  if a customer ever asks who on their team started the subscription.
- **No hard delete of a lapsed tenant's data.** `none` means the account is dormant and
  the data is retained. `tenant-lifecycle.ts` already owns deletion, and it stays a
  deliberate act by a person.
