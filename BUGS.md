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
