# Carrier Management Hub

An internal Carrier CRM and operations dashboard for a trucking dispatch company —
the replacement for the Google Sheets carrier tracker.

Authenticated, role-aware, and backed by a real relational database. Every significant
change to a carrier is recorded with who made it and when.

## Running it

```bash
npm install
npm run dev          # http://localhost:3000
```

On first boot the app creates `data/carrier-hub.db`, seeds the controlled vocabularies
and default settings, and creates one administrator:

| | |
|---|---|
| Email | `admin@carrierhub.local` (override with `ADMIN_EMAIL`) |
| Password | `ChangeMe123!` (override with `ADMIN_PASSWORD`) |

**Change that password in Settings after the first sign-in.** For a real deployment set
the environment variables before the first run:

```bash
ADMIN_NAME="Your Name" ADMIN_EMAIL="you@company.com" ADMIN_PASSWORD="…" npm run start
```

### Production

```bash
npm run build
npm start
```

### Other commands

```bash
npm test             # 126 tests, no framework — node --test
npm run seed:demo    # builds data/demo.db with synthetic carriers
npm run dev:demo     # runs the app against data/demo.db
```

`npm run dev:demo` is the safe way to click around a full-looking system. It uses a
**separate database file** and never touches your real data.

## Getting your spreadsheet in

**Settings → Import Data** (administrators only), or `/import`.

1. Export your sheet as CSV and choose the file.
2. Check the column mapping — most columns map themselves.
3. Review the preview: errors, flagged values and duplicate MC/USDOT numbers are all
   listed **before** anything is written.
4. Choose how duplicates are handled, then import.

What the importer guarantees:

- Values are stored exactly as written. Anything that doesn't match a known option is
  **kept and flagged for review**, never guessed or silently corrected.
- An empty cell never erases data already on file.
- The whole file imports in one transaction — a failure leaves nothing behind.
- Existing carriers are only modified if you explicitly choose "update".

Flagged records appear on the dashboard under **Needs Attention → Flagged during import**,
and each carrier profile shows exactly what was flagged.

## Backup

The entire database is one file. Stop the app and copy the `data/` directory.

## Roles

| Role | Can |
|---|---|
| **Admin** | Everything, including team, settings and import |
| **Dispatcher** | View all carriers; edit and offboard the ones assigned to them; add notes; export |
| **Account Manager** | Same, for the carriers they manage |
| **Management / Viewer** | Read-only: carriers, dashboards, reports, export |

Authorization is re-checked on the server for every mutation — hiding a button is
presentation, not a security boundary.

## Documentation

| File | What it covers |
|---|---|
| `PRD.md` | What this is and the business rules behind it |
| `Architecture.md` | Stack, data model, and the reasoning behind each decision |
| `AI Rules.md` | Binding conventions for anyone (or any agent) changing this code |
| `Plan.md` | Build phases, what is done, and what was deliberately deferred |

## Stack

Next.js 16 · React 19 · TypeScript · Tailwind CSS v4 · SQLite via `node:sqlite`.

Runtime dependencies: `next`, `react`, `react-dom`, `server-only`. The database driver
is in the Node standard library, authentication uses `node:crypto`, and the charts, CSV
parser and icons are all hand-written — so there is no dependency tree to keep patched.
