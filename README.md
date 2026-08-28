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
npm test             # 147 tests, no framework — node --test
npm run migrate      # apply pending schema migrations (idempotent)
npm run backup       # snapshot the database, verify it, rotate old ones
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

```bash
npm run backup
```

Writes a verified snapshot to `data/backups/` and keeps the newest 14
(`BACKUP_KEEP=30` to change that, `BACKUP_DIR=/mnt/vol` to put it elsewhere).

It uses SQLite's `VACUUM INTO`, which snapshots a database that is being written to
right now. **Do not back up by copying the file while the app is running** — that can
capture a half-written page, and you find out only when you try to restore. Each backup
is reopened, integrity-checked and row-counted before it is accepted; the counts are
printed so you can see what you actually captured.

To restore: stop the app, copy a backup over `data/carrier-hub.db`, delete any stale
`-wal` / `-shm` files beside it, start the app. Run a restore for real once before you
need to.

Put it on a schedule:

```bash
0 2 * * *  cd /path/to/app && /usr/local/bin/npm run backup >> data/backups/backup.log 2>&1
```

## Deploying with Docker

```bash
docker build -t carrier-hub .
docker volume create carrier-hub-data
docker run -d --name carrier-hub -p 3000:3000 \
  -v carrier-hub-data:/data \
  -e ADMIN_EMAIL=you@company.com \
  -e ADMIN_PASSWORD='a real password' \
  carrier-hub
```

The volume at `/data` is not optional — the database is a file, and without a volume
every carrier record is lost when the container restarts. Migrations run before the
server accepts traffic.

## Security

- **Login throttling.** Five failed attempts on an account lock it for 15 minutes; a
  network gets 30 before it is throttled. A successful sign-in clears the account's own
  lock at once. Counts survive restarts.
- **Password resets are one-time links.** An administrator opens Team → *Password* →
  *Generate reset link* and sends the link over. They never learn the password. Links work
  once, expire in 24 hours, and completing one signs that account out everywhere. Only the
  token's hash is stored, so a stolen database cannot be replayed into an account.
- **Set `ADMIN_PASSWORD`** before the first boot of any deployment. The fallback
  (`ChangeMe123!`) is documented here and in the source — treat it as public.
- The app has no rate limit on anything but login, no 2FA, and no self-serve signup.
  Before putting it on the open internet, consider whether it belongs behind a VPN or an
  identity proxy instead.

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
