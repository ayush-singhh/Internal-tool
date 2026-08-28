# AI Rules

Conventions for any AI agent or developer working in this repository. Read
`PRD.md` for *what* to build, `Architecture.md` for *how it is put together*, and
`Plan.md` for *what is done and what is next*.

## 1. Dependencies

**Adding a runtime dependency requires justification in the PR/commit message.**
The stack is deliberately `next` + `react` + `react-dom` and nothing else.
Before installing anything, walk the ladder:

1. Does this need to exist at all?
2. Is it already in this codebase? (`src/lib/`, `src/components/` — look first)
3. Does the Node standard library do it? (`node:sqlite`, `node:crypto`, `Intl`, `URLSearchParams`)
4. Does a native platform feature cover it? (`<input type="date">`, CSS Grid, `<details>`, form validation attributes)
5. Only then: the minimum code that works.

Charting, CSV, date formatting, auth and the database layer are all hand-rolled *on
purpose*. Do not replace them with a package without a concrete reason.

## 2. Data Integrity — non-negotiable

- **Never invent carrier records.** Not for demos, not for screenshots, not for tests
  against the real database. Seed data is limited to lookups, settings and the admin user.
- **Never silently normalize imported values.** Preserve the original and set a
  `review_flags` entry. Cleanup is a human decision.
- **Never delete an offboarded carrier.** Status changes; the record and its history stay.
- **Edits must not blank untouched fields.** Update statements set only what the form
  submitted; a missing key means "unchanged", not "clear it".
- `carrier_activity` is append-only. Nothing may update or delete a row in it.

## 3. Controlled Vocabularies

Statuses, plans, pricing types, lead sources, agreement statuses, subscriptions,
onboarding types, trailer types, invoice modes and offboarding reasons come from the
`lookups` table and are seeded from `src/lib/constants.ts`.

- Never render a free-text input where a lookup exists — use a `<select>`.
- Never hardcode a label string in a component; read it from the lookup.
- Adding a value = adding a row to `LOOKUPS` in `constants.ts`. The seed is idempotent
  and re-runs on boot.
- Status slugs are referenced in logic via the `STATUS` constant, never as string literals.

## 4. Security

- Every page under `src/app/(app)/` is authenticated by the layout's `requireUser()`.
  Do not create authenticated routes outside that group.
- **Re-check permission inside every Server Action.** Hiding a button in the UI is
  presentation, never the security boundary.
- All SQL uses bound parameters. No string interpolation into SQL, ever — including
  `ORDER BY`, which must be validated against an allow-list of column names.
- Never log or export password hashes or session IDs.
- Attribute every mutation: `updated_by`, `carrier_activity.user_id`.

## 5. Server / Client Boundary

- Default to Server Components. Add `"use client"` only for genuine interaction
  (filter bars, column pickers, wizards, forms with conditional sections).
- Mutations are Server Actions in `"use server"` files or inline in Server Components —
  not API routes. `src/app/api/` is reserved for file downloads.
- Never import `src/lib/db.ts` from a Client Component.
- After a mutation, call `revalidatePath` for the affected routes.

## 6. Code Style

- TypeScript, no `any` in exported signatures.
- Queries live in `src/lib/*.ts`, not inline in page components — pages compose, they
  don't build SQL.
- Boring over clever. Someone will read this at 3am during a dispatch problem.
- Comment the *why*, not the *what*. Deliberate shortcuts are marked with a
  `ponytail:` comment naming the ceiling and the upgrade path.
- No abstraction with a single caller. No config value that never changes. No
  scaffolding "for later".

## 7. Validation

Validate on the server in the action, even when the input already has `type="email"`,
`min`, `max` or `pattern`. Client attributes are UX; the server rule is the truth.
Rules live in `PRD.md` §5 — MC/USDOT digits only, percentage 0–100, non-negative
integer truck counts, ISO dates.

## 8. Testing

Non-trivial logic — the CSV parser, permission checks, duplicate detection, the
Needs Attention rules, pricing formatting — leaves one runnable check behind:
a small `node --test` file under `tests/`. No framework, no fixtures, no
per-function suites.

**Write logic goes in a plain module; the Server Action is a thin auth wrapper.**
`requireUser()` needs a request context that `node --test` does not have, so a mutation
buried inside an action cannot be tested. Put it in `src/lib/<thing>.ts` taking an explicit
`userId`, and let `src/lib/<thing>-actions.ts` authenticate and delegate
(`notes.ts` / `note-actions.ts` is the reference pair).

Tests run with `node --conditions=react-server` so `server-only` resolves, and set
`CARRIER_DB_PATH` to a temp file before importing anything — **tests never touch
`data/carrier-hub.db`**.

## 9. Schema changes

Schema changes are migrations in `src/lib/migrations.ts` — never edits to an existing
`CREATE TABLE`, and never an ad-hoc `ALTER` at boot. Other companies are running this
now, so a change has to be ordered, recorded and run exactly once.

- Never edit a migration that has shipped. Add a new one.
- Never renumber. The version is the identity.
- Assume the target database already contains real customer records.
- Destructive steps (dropping or rewriting a column) need a backup taken first and a
  note in `Plan.md` saying so.

## 10. Keep the docs honest

Finishing a phase means updating `Plan.md` in the same change. If a decision in
`Architecture.md` stops being true, fix `Architecture.md` — a stale architecture doc is
worse than no architecture doc.
