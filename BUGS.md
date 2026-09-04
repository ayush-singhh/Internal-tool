# Bug ledger

Every defect worth remembering, newest first. A bug earns an entry here when knowing about
it later changes a decision — a security hole, data loss, a wrong result, or a trap in the
codebase that will catch the next person. Typos and half-hour mistakes do not.

`Plan.md` records what was *built*, phase by phase. This records what was *wrong*, and it
is not organised by phase, because the worst bugs are found long after the phase that
introduced them.

**Writing an entry.** Keep the five headings. The one that matters most is **Why it was
missed** — a fix stops one bug, that line stops a category. If a bug is found and not
fixed, still write the entry and mark it `open`, so "we know about it" survives the
conversation it was noticed in.

**Closing one.** A bug is `fixed` only when a test fails without the fix. Name the test in
**Guarded by**; if there is no test, say why not.

---

## 2026-09-04 — `/reports` had no permission check at all

**Severity:** medium · **Status:** fixed · **Reached users:** unknown — the page has been
in the product since Phase 8; nothing recorded who opened it

`src/app/(app)/reports/page.tsx` began:

```ts
const { org } = await requireOrg();
```

`user` was never destructured, so `can()` was never asked. Any signed-in person who typed
`/reports` — or followed a link from anywhere — got thirteen breakdowns of the whole
carrier book: every dispatcher's workload, the plan and pricing distribution, the
onboarding and offboarding history. `sales` in particular is defined by seeing **no
carrier at all**, and this served them the shape of the entire book.

**Not the same bug as the sidebar one below, and that is the point.** Phase 16 fixed the
*navigation* so a role is only offered what it may open. This page was never offered to
sales — and was reachable anyway, because hiding the link is presentation and the page
itself asked nothing. Every other page in the product had already learned this; Reports had
simply never been revisited after the roles arrived.

**Found by:** adding money reports to it. Writing `fee_by_carrier` meant asking who may see
dispatch-fee revenue, which meant reading the page's gate, which turned out not to exist.

**Fixed:** every `ReportDef` now names the `Action` that reveals it — carrier reports
`carrier:view`, dispatch reports `load:view`, money reports `invoice:view`, receivables
ageing `invoice:manage` (the same gate as `/billing`). `visibleReports(user)` builds the
rail, a report the reader may not run falls back to their first rather than 403-ing on a
link they never followed, and `mayRunReport` refuses the CSV route by key. `export:run` was
already checked there and was never enough: it says this person may take data out, not
*which* data.

**Why it was missed:** the permission model arrived in Phase 2 and the roles that make it
bite arrived in Phase 16, but the audit that followed each of them walked the *sidebar*.
A page nobody had linked wrongly looked correct from the sidebar's point of view. **The
list of pages to audit is the router's, never the navigation's** — anything reachable by
URL is reachable, and a filtered menu is evidence about menus only.

**Guarded by:** `tests/reports.test.ts` — "each role sees only the reports its permissions
allow" (sales gets an empty list; a dispatcher may run `fee_by_carrier` but not
`receivables_ageing`), and `tests/http/app.test.ts` — "the reports page has a gate now, and
a role with no reports never reaches it", which checks the redirect *and* the absence of a
carrier name from the body, plus a 403 from the CSV route for a report the caller may not
run.

---

## 2026-09-04 — `transaction()` could not be nested, so reusing a write function broke it

**Severity:** low · **Status:** fixed · **Reached users:** no — caught while building
`convertLead`, before it shipped

`transaction()` in `src/lib/db.ts` issued a bare `BEGIN`. SQLite has no nested
transactions, so `BEGIN` inside an open transaction is an error — which meant any composite
write that wanted to reuse an existing write function was blocked by whether that function
happened to transact internally. `convertLead` has to create a carrier and mark the lead
won together; `createCarrier` already transacts.

**The trap, not the error.** The failure mode is not the visible throw. It is the *fix a
person reaches for*: seeing "cannot start a transaction within a transaction", the obvious
move is to drop the outer `transaction()` and run the two writes in sequence. That
compiles, passes a happy-path test, and quietly gives up atomicity — a carrier created with
no lead pointing at it, or a lead marked won with no carrier behind it. The second-most
obvious move, inlining a copy of `createCarrier`'s INSERT, duplicates the activity-logging
it does and drifts from it later.

**Why it was missed:** every previous caller transacted at exactly one level, so the
constraint never showed. `transaction()` reads like a general-purpose combinator and gives
no hint that it composes with nothing — the kind of limitation that stays invisible until
the first feature genuinely built from two others, which is precisely when someone is least
inclined to go and change a shared primitive.

**Fixed:** nested calls join the outer transaction through a `SAVEPOINT` and release it,
rather than beginning a second one. An outer rollback still discards everything the inner
call wrote — the savepoint only makes an inner failure recoverable, it does not let an
inner success survive an outer failure. The savepoint name interpolates a private counter,
which is the one interpolation SQLite leaves no parameter for; nothing caller-supplied
reaches it.

**Guarded by:** three cases in `tests/leads.test.ts` — nesting joins rather than throws, an
outer rollback discards the nested writes, and a caught inner failure loses only the inner
writes.

---

## 2026-09-04 — the sidebar showed every non-administration page to every role

**Severity:** medium · **Status:** fixed · **Reached users:** no known instance — `sales`
was added in Phase 15 and no customer is known to have created one before this fix

`AppShell` decided the sidebar with a single `canAdmin` boolean and a hardcoded list of four
hrefs:

```ts
group.items.filter((item) => canAdmin || !["/team","/audit","/settings","/import"].includes(item.href))
```

The list is an *administration* deny-list, so the rule it actually encoded was "anyone who
is not an administrator sees everything except these four." Every other page — All Carriers,
Active, Onboarding, Offboarded, Investigations, Loads, Drivers, Brokers, Invoices, Reports —
was shown to **every** signed-in role unconditionally. That included `sales`, whose entire
definition in `constants.ts` is that it "sees no rate, no load and no invoice — the sales
sidebar has no Carrier or Load Management on it at all," and whose `can()` branch returns
`false` for every action. The nav had simply never asked `can()`.

Two more instances of the same root cause turned up while fixing it, both affordances that
never asked `can()`:

- the header's "Add Carrier" button was shown to a `viewer`, which has no `carrier:create`;
- the dashboard's **empty state** (`m.total === 0`) led with "Import spreadsheet" for every
  role, so a dispatcher opening a fresh organisation was pointed at `/import`, a page
  `import:run` refuses them. This one was invisible to the sidebar work and to
  `tests/nav.test.ts` — it is not in the nav at all — and was caught only because the HTTP
  test asserted on the whole rendered page rather than on the nav data structure.

Server-side authorization was never bypassed: `can()`/`assertCan()` still refused the
actions, and the pages themselves re-check. The exposure was the **navigation surface** —
a sales user saw, and could click through to, carrier and load screens they had no business
knowing existed. Whether each destination page then refused them was never the sidebar's
decision to make.

**Fix.** Every nav item now names the `Action` that reveals it, and `visibleNav(user)` in
`src/lib/nav.ts` filters with `can()`, dropping groups left empty. The header's search and
Add Carrier are gated on `carrier:view` / `carrier:create` in the layout, and the dashboard
empty state gates each of its two buttons (and its copy) the same way. `AppShell` renders
what it is handed and decides nothing.

**Why it was missed.** The filter was written in Phase 2, when four roles existed and all
four legitimately saw carriers, so "not an administrator" and "may see this page" were the
same set and the deny-list was correct. Phase 15 added `sales` — a role defined by what it
*cannot* see — and the nav was not revisited, because nothing connects the two files: the
comment on `AppShell`'s prop even claims the layout decides "so a new role never has to be
remembered here," which was true of that one boolean and false of the list beside it.
**A deny-list of routes silently grants every route added after it, and every role added
after it. Gate navigation on the same permission the action is gated on, never on a
role-shaped boolean** — then adding a role is one edit to `permissions.ts`, and forgetting
the sidebar is impossible.

The empty-state instance adds a second lesson: **a unit test over the nav data structure
cannot see an affordance that is not in the nav.** The `/import` button was found only by
asserting against the whole rendered HTML over HTTP, which is the same reason
`tests/http/` exists at all (see the `/support` leak in the 2026-08-30 entry).

**Guarded by.** `tests/nav.test.ts` — nine cases pinning all three panels.
`"regression: the old admin-href deny-list served sales the carrier and load pages"`
reconstructs the deny-list rule and asserts it both leaks `/carriers`, `/loads` and
`/invoices` **and** disagrees with the permission-gated nav, so the defect stays executable
rather than only described here. `"sales sees only the dashboard and its own activity"`
pins the exact href list, and `"a deactivated administrator loses every gated item"` covers
the `!user.active` path the old boolean never consulted.

Three cases in `tests/http/app.test.ts` assert the rendered page rather than the data
structure, which is what caught the empty-state `/import` button:
`"a sales agent's page carries no carrier, load or invoice link, and no carrier data"`,
`"a dispatcher's sidebar keeps carriers and dispatch but drops Administration"` (the one
that failed on `/import`), and `"My Activity is reachable by every role and shows only
that user's own entries"`.

---

## 2026-09-02 — `AdjustmentManager`'s "Kind" select reused an `id` already on the page

**Severity:** low · **Status:** fixed · **Reached users:** no (caught in this session's own
browser verification, before commit)

The new Adjustments card on `/loads/[id]` (invoicing, Phase 15) gave its "Kind" `<select>`
`id="kind"`. `DocumentManager`'s Documents card, already on the same page, has used
`id="kind"` for its own "Kind" `<select>` since Phase 15's Load Documents work. Two elements
with the same `id` is invalid HTML: `<label htmlFor="kind">` is now ambiguous, so clicking
either card's "Kind" label could focus the wrong select depending on DOM order, and a
`document.getElementById("kind")` call would silently return only the first one.

Surfaced as a React hydration-mismatch console warning
(`caret-color: transparent` appearing on inputs across the page after a client-side
navigation) rather than as an obvious visual bug — the actual defect (a duplicate `id`) is
several inference steps away from that symptom, and the warning's own text lists five
unrelated causes before "invalid HTML" without naming duplicate ids specifically. Chasing it
took ruling out two other candidates first: `page.screenshot({ fullPage: true })` in the
verification script turned out to *also* independently trigger a cosmetic version of the
same console warning (a Playwright/headless-Chromium screenshot-capture artifact, confirmed
by A/B testing with and without the screenshot calls) — real, but unrelated to the shipped
code, and a false lead that had to be ruled out before the actual duplicate-id cause was
findable by diffing hydration errors against `git stash` of the new page changes.

**Fix.** Renamed the Adjustments card's fields to `adjustment-kind` / `adjustment-description`
/ `adjustment-amount`, with matching `htmlFor` updates. General rule: a form component meant
to be composed onto a page alongside other forms needs ids namespaced to that component, not
generic field names — `DocumentManager` got away with `id="kind"` only because nothing else
on `/loads/[id]` used it yet.

**Why it was missed.** Duplicate DOM ids produce no error or warning by default in React
dev mode or in the browser — the only visible signal was an indirect, generically-worded
hydration warning several steps removed from the actual cause, and the initial hypothesis
(browser/tooling noise) was reasonable given a `fullPage` screenshot really was contributing
noise in the same investigation. **When two client components render on the same page,
check their field ids for collisions explicitly** — nothing else will flag it.

**Guarded by.** Nothing automated — this was one instance of a general authoring discipline
(namespace a reusable form component's ids), not a rule worth a bespoke lint or test for a
single occurrence. Verified by hand: re-ran the full Playwright flow (add an adjustment,
create an invoice, mark it paid) after the rename with zero console errors, including a
screenshot-free isolation run that specifically confirmed the duplicate id — not the
screenshot artifact — was the fix that mattered.

---

## 2026-09-02 — `load_documents` was never added to tenant deletion or export

**Severity:** moderate · **Status:** fixed · **Reached users:** no (caught in final review, before merge)

Migration 15 added `drivers`, `brokers`, `loads` and `load_stops`, and correctly added all
four to `tenant-lifecycle.ts`'s `OWNED` list plus an explicit delete for the three that
don't cascade. **Migration 16 added `load_documents` and did neither.** Nothing in the
load-documents diff touches `tenant-lifecycle.ts`, which is exactly why eight per-task
reviews of that feature never saw it.

Proven against a throwaway database seeded with one org, one carrier, one load and one
document:

- `exportOrganization` — the file's own header calls this "everything one organisation
  owns," a data-subject deliverable — silently omitted every document row. The export ran,
  printed its counts, and the missing table was invisible unless you already knew to look
  for it.
- `deleteOrganization` threw `FOREIGN KEY constraint failed` deleting from `loads`, because
  `load_documents.load_id` references `loads (organization_id, id)` with **no
  `ON DELETE CASCADE`** (unlike `load_stops`, which has one) and the database runs with
  `PRAGMA foreign_keys = ON`. Any tenant that had ever attached a single document could no
  longer be offboarded.

Fails closed on deletion — the transaction rolls back, so no data loss and no cross-tenant
exposure, which is why this is moderate rather than critical. The export miss is the
sharper half: a wrong answer that nothing flags as wrong.

**Fix.** `load_documents` added to `OWNED`, ordered before `loads` (both because a reader
would expect it near the table it documents, and because it now has to be deleted first).
`deleteOrganization` gained `del("load_documents", ...)` immediately before
`del("loads", ...)`.

**Why it was missed.** The load-documents review package was scoped to its own diff, and
`tenant-lifecycle.ts` is not in it — a diff-scoped review finds defects *inside* a change;
this one lived in a caller the change forgot, which is by definition outside it. Finding it
took asking a different question than "does this diff look right": *what else in this repo
enumerates tenant-owned tables, and did this migration update it the way the last one did?*
Every new table, constant or route needs that same outward walk, not just a read of its own
diff.

**Guarded by.** `tests/tenant-lifecycle.test.ts` — "every tenant-owned table is exported and
deleted with the tenant": asserts every entry in `tenant-db.ts`'s `TENANT_TABLES` (the
fail-closed query guard's own source of truth) also appears in `OWNED`, so the next
migration that adds a tenant table and forgets this file fails a test instead of shipping
quietly. The existing "deleting one tenant leaves the neighbour intact" test was also
extended: its fixture seeded no loads at all, so even with the drift guard in place that
test would not have proven deletion actually worked for `load_documents` — it now seeds a
load and a document per organisation and tracks both tables in the neighbour-untouched
assertion.

---

## 2026-09-02 — a non-Latin-1 filename made a document permanently undownloadable

**Severity:** high · **Status:** fixed · **Reached users:** no (caught in final review, before merge)

`/api/documents/[id]/route.ts` built its `Content-Disposition` header as
`` `attachment; filename="${doc.filename.replace(/[\x00-\x1f"]/g, "")}"` `` — a regex that
strips C0 control characters and double quotes and nothing else. HTTP header values must be
**ByteStrings**: every character ≤ U+00FF. Any filename with a CJK, Cyrillic, Arabic,
Hebrew, Greek or Thai character, or an emoji throws inside the `Response` constructor
(`TypeError: Cannot convert argument to a ByteString because the character ... is greater
than 255`), and the route 500s.

The document uploads successfully, appears in the Documents card with its correct name and
size, and is then unreachable forever — this feature is deliberately append-only with no
delete, so the only recourse is uploading a second copy under a Latin-1 name and leaving the
dead row on the load permanently.

This is the same line that already took a mid-plan fix round. The original finding was
control characters in a filename; the fix widened the regex from stripping `"` alone to
stripping `\x00-\x1f` as well, and the re-review that closed it verified exactly that — the
regex boundaries were correct for `0x00`–`0x1f` inclusive. `提单.pdf` still 500s after that
fix shipped; nothing about the regex touches characters above `\x1f`.

**Fix.** RFC 5987/6266: an ASCII fallback in `filename=`, the real name percent-encoded in
`filename*=UTF-8''...`. Both halves are pure ASCII, so the ByteString constraint holds —
old clients take the fallback, every current browser prefers `filename*` and shows the real
name. The same root cause was fixed at the write side too: `documents.ts` stored
`file.name.slice(0, 200)`, and `.slice` counts UTF-16 code units, so a 200-character
boundary landing inside a surrogate pair stores an unpaired surrogate — also > U+00FF, also
a 500 on download, just rarer. Replaced with codepoint-safe truncation
(`Array.from(name).slice(0, 200).join("")`).

**Why it was missed.** A fix round that verifies a patch against the *reported symptom* —
here, C0 control characters — instead of the *general rule* the symptom was one instance
of — here, HTTP header values must be ByteStrings, ≤ U+00FF — closes the specific instance
and leaves the broader category open. The widened regex passed its own re-review cleanly
while every non-Latin-1 filename kept failing identically. The question that catches this
class of bug is never "does the fix cover what the report named," it is "what is the actual
rule here, and does the fix cover *that*."

**Guarded by.** `tests/http/app.test.ts` — "a legitimate load:view user downloads their own
document, non-ASCII filename included": drives a real production server end to end through
a fake S3 backend, with a document filed under `提单.pdf`, and asserts a 200 with the exact
bytes. 500s immediately against the unfixed header line.

---

## 2026-09-01 — the test suite wrote into the development database (twice)

**Severity:** high · **Status:** fixed · **Reached users:** no (a developer's database, not a customer's)

`db.ts` binds `CARRIER_DB_PATH` **at module load**. Any static import that reaches it —
directly, or through another module — pins the connection before a test file's
`process.env.CARRIER_DB_PATH = DB` line ever runs. The tests then seed into
`data/carrier-hub.db`.

This is the second time. The first was recorded in `HANDOFF.md`: a test imported
`src/lib/audit.ts` at the top of the file, seven runs wrote fixtures into the developer's
database, and `assertThrowawayDatabase()` was added to stop it happening again.

**It did not stop it happening again, because it checked the wrong thing.** The guard
asserted that `process.env.CARRIER_DB_PATH` pointed inside the temp directory. That
variable was set correctly. The *connection* was already pinned somewhere else. The guard
passed on every run while the fixtures went into the wrong database.

Found by accident: a load test failed because `seedOrg` returned organisation id 86 on
what should have been an empty database. `PRAGMA database_list` showed the open file was
`data/carrier-hub.db`, holding **105 organisations, 111 users, 10,400 brokers, 11 drivers
and 5 loads** of accumulated fixtures. Organisation 1 — the real bootstrap — still had its
admin, its 80 lookups and its 4 settings, and no carriers: every one of the 47 belonged to
a fixture organisation.

The trigger this time was mine. `tests/helpers.ts` gained
`import { seedOrganizationData } from "../src/lib/provision.ts"` so fixtures would use the
real provisioning instead of repeating it — a good intention that reached `db.ts` through
`provision.ts`.

**Fix.** Two parts, because either alone would leave the trap armed:

- `tests/helpers.ts` imports nothing that reaches `db.ts`. It seeds from `constants.ts`,
  which holds no connection. `tests/dispatch-schema.test.ts` asserts the seeded broker
  count, so drift between the fixture and real provisioning fails a test instead of
  passing quietly — which is what the import was for.
- `assertThrowawayDatabase()` now reads `PRAGMA database_list` and checks **the file the
  connection actually has open**, resolving symlinks on both sides (macOS `/var` is a link
  to `/private/var`, so a naive prefix test rejects a database that is exactly where it
  should be).

**Why it was missed.** The guard tested the intent rather than the outcome. An environment
variable is what you *asked* for; the open file handle is what you *got*, and only one of
them can be wrong while looking right. **Assert on the effect, not on the input that was
supposed to produce it** — the same reason the `/support` tests assert on the response body
rather than the status code.

**Guarded by.** `tests/helpers.ts` itself, on every call to `seedOrg`. Verified by
reinstating the offending import: all 8 tests in `tests/audit.test.ts` fail immediately
with the open path named, instead of passing and writing to the wrong database.

**Still outstanding.** `data/carrier-hub.db` still holds the accumulated fixtures. A backup
was taken (`data/carrier-hub.db.before-cleanup-*`); the cleanup itself needs whoever owns
that database to run it.

---

## 2026-08-30 — `/support` pages were authorised only by their layout

**Severity:** critical · **Status:** fixed · **Reached users:** no (never exposed to real
customers — confirmed by the operator)

Every page under `/support` called `requireUser()` and left the `isSupport()` check to
`src/app/support/layout.tsx`. **A layout cannot refuse a request.** Next renders a page
concurrently with its layout, so `notFound()` in the layout set the status code but never
stopped the page: its queries ran and its markup was streamed into the body of that 404.

Reproduced against a production build, signed in as an ordinary owner of an unrelated
tenant — no privilege inside their own organisation required, a `viewer` worked as well as
an owner:

| Request | Status | Body actually contained |
|---|---|---|
| `GET /support` | 404 | Every organisation on the deployment, the whole support access log, and `recentErrors()` — server error text, which can carry fragments of any tenant's data |
| `GET /support/<orgId>` | 404 | That tenant's carriers: legal name, owner, phone, MC, status |
| `GET /support/<orgId>/carriers/<id>` | 404 | Full record, notes, activity history, offboarding detail |

`orgId` and carrier `id` are sequential integers, so it enumerated. The data was in the
response body — recoverable with `curl` or view-source, not necessarily painted on screen,
which lowered the odds of accidental discovery but not the severity.

It also let any signed-in user write rows into `support_access_log` — the append-only
record that is the entire justification for standing cross-tenant access.

**Fix.** `requireSupport()` in `src/lib/auth.ts`, called by every page for itself. The MFA
gate moved off the `x-pathname` request header onto a parameter (`/support/account` is the
one page that opens without a second factor), because the proxy only sets that header on
requests it matches and it is otherwise the caller's to choose. `src/proxy.ts` no longer
sets it at all.

**Why it was missed.** Every page under `(app)` calls `requireOrg()` for itself; `/support`
was the single place that delegated upward, and the delegation looked like it worked — the
status code really was 404. Nothing short of reading the response body reveals otherwise.
**A layout is chrome, not a gate.** Authorisation belongs in the page, the Server Action,
or the route handler — the thing that actually touches the data.

**Guarded by.** Two tests, deliberately at different levels:

- `tests/http/app.test.ts` — "/support is invisible to a customer, and serves them
  nothing", which drives a real production server and asserts the status **and** that the
  body does not contain the other tenant's data. This is the test that reproduces the
  original bug; reverting the fix fails it with *"Victim Logistics" was in the response
  body — a status code is not a denial*.
- `tests/support.test.ts` — "no page under /support relies on its layout to authorise the
  request": walks `src/app/support/**/page.tsx` and requires each to call
  `requireSupport()`. A source check, because it is a rule about how these files are
  written, and it catches a new page the HTTP test does not know exists yet.

---

## 2026-08-30 — the tenancy migrations destroyed data on any real database

**Severity:** critical · **Status:** fixed · **Reached users:** no (failed closed)

`PRAGMA foreign_keys` is a **no-op inside a transaction**, and `migrate()` wraps every
migration in one — so migration 6's `PRAGMA foreign_keys = OFF` never took effect.
Migrations 5 and 6 change table constraints, which SQLite can only do by rebuilding the
table, and `DROP TABLE` with enforcement on performs an implicit `DELETE` that fires the
children's `ON DELETE CASCADE`.

On a version-4 database holding real data:

- **Migration 5 failed outright** — `FOREIGN KEY constraint failed`, because `carriers`
  → `users` is `NO ACTION`. The upgrade simply refused to run.
- **Migration 6 would have silently emptied** `carrier_notes`, `carrier_activity` and
  `offboarding_records` — and reported success, because its own `foreign_key_check` found
  nothing wrong. Empty tables are referentially perfect.

Failing closed at 5 is the only reason no data was lost. The trap was the obvious next
move: read the error as "migration 5 has a bug", fix just that, rerun, and migration 6
quietly deletes three tables' worth of history.

Fresh deployments were never at risk — nothing to cascade. The exposed paths were the two
that matter commercially: migrating the existing single-tenant customer, and restoring an
old backup, since starting the app on a restored file triggers `migrate()` on boot.

**Fix.** `migrate()` toggles enforcement around the whole run, outside the transaction
where the pragma actually works, and asserts `PRAGMA foreign_key_check` per migration
*inside* its transaction so a migration that leaves a dangling reference rolls back.
Migration 6's dead pragmas and its now-redundant local check were removed.

**Why it was missed.** The migration reported success and its own integrity check passed,
so every signal said it worked. Tests only ever ran migrations against an empty database,
where there is nothing to cascade. **A migration test that starts from an empty file tests
the schema, not the migration.** Seed real rows at the old version first.

**Guarded by.** `tests/migrations.test.ts` — "a single-tenant database keeps all of its
data through the tenancy migrations": fills a v4 database with carriers, notes, activity
and an offboarding record, upgrades it, and asserts every row survived, every row was
attributed to the organisation, `foreign_key_check` is clean, and enforcement was switched
back on. Confirmed to fail against the unfixed runner.

---

## 2026-08-30 — the report CSV export was neither rate-limited nor audited

**Severity:** moderate · **Status:** fixed · **Reached users:** n/a

`/api/export` has both, and the reasoning in that file is explicit: *"who took a copy of
the customer list" should have an answer*. `/api/export/report` had neither.

It serves aggregates rather than the carrier book, but the date-range parameters slice
finely — walk `from`/`to` across the calendar on `by_status` or `offboarding_reasons` and
you reconstruct a good deal of the business, with nothing written to `audit_log`. A quiet
channel through a control advertised as complete.

Secondary: `node:sqlite` is synchronous, so every query blocks the event loop. An
unthrottled endpoint running `GROUP BY` over the carrier table is a modest availability
lever — modest, and not the main reason to fix it.

**Fix.** `checkBurst`/`recordBurst` against the existing `EXPORT_RULE` (20/hour) under its
own key `report:${user.id}`, so a morning of reports cannot spend the carrier export's
budget and vice versa. Plus a new `AUDIT.EXPORT_REPORT` action recording who, which report,
and the date range.

**Why it was missed.** The two export routes were written at different times and never read
side by side. **When one route gets a control, the sibling route needs the same decision
made out loud** — even if the answer is "not this one, and here's why".

**Guarded by.** `tests/http/app.test.ts` — "the report export is rate-limited and every
pull is recorded": drives a real server, asserts a CSV comes back, that the pull lands in
`audit_log`, that the limit eventually returns 429, that a refused export is *not* recorded
as one, and that spending the report budget leaves `/api/export` still working.

---

## 2026-08-30 — `offboardingReasons` built placeholders and parameters by different rules

**Severity:** low, latent · **Status:** fixed · **Reached users:** no (unreachable)

`reports.ts` carried a second copy of the `offboardingReasons` query. The copy chose how
many placeholders to write with `from ? … : null` and how many parameters to bind with
`v !== null` — two different notions of empty. An empty-string bound produced a surplus
parameter and threw `column index out of range`, i.e. a 500 rather than a wrong number,
which is the better of the two failure modes.

Unreachable in practice: both callers regex-check `YYYY-MM-DD`, and `dated` is false for an
empty `from` anyway, so it needed `from=""` *and* a valid `to`. A trap for the third
caller, not a live bug.

**Fix.** Deleted the duplicate rather than patching it. The dated and undated paths are one
function in `stats.ts` where each bound pushes its clause and its parameter on the same
line, so the two cannot drift apart. `reports.ts` lost 12 lines.

**Why it was missed.** It was a copy. The original was correct and the copy diverged, and
nothing compares them. **A SQL clause and its parameter belong on the same line**; when
they are built by two expressions, they will eventually disagree.

**Guarded by.** `tests/reports.test.ts` — "a blank date bound is simply no bound", covering
five blank-bound shapes. Confirmed to fail against the old shape with the original error.

---

## 2026-08-30 — `isFirstRun()` asked a single-tenant question

**Severity:** cosmetic · **Status:** fixed · **Reached users:** no

It counted users and sessions across the whole deployment and returned `users === 1 &&
sessions === 0`, which meant "is there exactly one user account anywhere" — not the same
question once a second tenant exists. An empty new organisation alongside a one-person
bootstrap org answered yes.

No credential disclosure: the login hint it drives is wrapped in
`process.env.NODE_ENV !== "production"`, so the seeded `ADMIN_EMAIL` / `ChangeMe123!` text
never renders on a real deployment. That is the only reason this is cosmetic.

**Fix.** One query instead of three, with the organisation count added so the predicate says
what it means: one organisation, one user, nobody has ever signed in.

**Why it was missed.** Written before tenancy and never revisited. **Multi-tenancy turns
every global `COUNT(*)` into a question worth re-reading** — the query still runs, still
returns a number, and quietly answers something else.

**Guarded by.** Nothing automated — `auth.ts` imports `next/headers` and cannot be loaded
by `node --test`, and it is a two-line predicate over three counts. Verified by hand: the
hint correctly does not appear on a multi-organisation deployment.

---

## 2026-08-30 — a failed backup was reported only to stdout

**Severity:** high · **Status:** fixed · **Reached users:** no

The backup machinery was sound — `VACUUM INTO`, every copy reopened and verified, SigV4
asserted against AWS's own test vector, and a restore rehearsed for real. The reporting
was not. A failed scheduled run did this and nothing else:

```js
console.error("SCHEDULED BACKUP FAILED:", (error as Error).message);
```

Not in `error_log`, not on `/support`, no alert, and nowhere in the product showing when a
backup last succeeded. On one machine with one volume the backup *is* the disaster plan,
so the failure mode was: expired R2 credentials, every nightly upload refused, and the
first person to find out is whoever needs a restore.

Worse than a plain outage, the *partial* failure was invisible by design — a snapshot that
verified fine and simply never left the disk looked identical to a complete success in
every signal available.

**Fix.** Migration 13 adds `backup_log`, and `runBackup()` records the outcome of every run
as one of four states rather than ok/not-ok: `offsite` (the only fully good one), `local`
(no destination configured), `degraded` (**configured and refused** — the quiet one), and
`failed`. Surfaced on `/support` next to the error card, leading with the last run that
actually reached off-machine storage, because that is the date a restore would take you
back to. The recording wraps the work inside `backup.ts` rather than sitting in each
caller — "remember to log the outcome" is precisely the instruction that gets forgotten.

**Why it was missed.** The tests asserted the backup *worked*, never that a failure was
**visible**. **A control is not finished when it works; it is finished when its failure is
noticeable.** For anything on a timer, ask where the bad news appears and who reads it.

**Guarded by.** `tests/backup.test.ts` — "every backup records its outcome, and a refused
upload is not called a success", plus "a backup that throws is recorded as failed rather
than vanishing". The sharp assertion is that a `degraded` run must not advance the
last-good marker, so a week of refused uploads cannot read as a week of good backups.

---

# Considered and accepted

Not bugs. Recorded so they are not re-reported.

### `can(user, "export:run")` returns true for `viewer`

A read-only account can export the whole carrier book as CSV. Raised 2026-08-30 and
**kept as designed** — a viewer is a colleague who can already read every carrier on
screen, and the export is rate-limited and audited either way. Revisit only if `viewer`
ever becomes a role given to someone outside the company.
