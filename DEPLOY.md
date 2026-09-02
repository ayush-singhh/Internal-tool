# Putting this in front of someone

For a client who should open a URL, sign up, and tell you what to change.

## What this needs, and what will not work

This is a Next.js server application whose database is a **file that gets written to**.
So it needs a real Node process and a **disk that survives a restart**.

- **GitHub Pages** cannot run it — it serves static files only.
- **Vercel** cannot run it either. Its filesystem is ephemeral, so the database would be
  wiped underneath your client mid-demo. (Moving to Postgres would change that; today
  the app is SQLite via `node:sqlite`.)
- **Anything that runs the `Dockerfile` with a volume at `/data`** works: Railway,
  Fly.io, Render, or your own VPS. The steps below are Railway, because it deploys
  straight from the GitHub repo.

## Hosting it on GitHub itself

**GitHub Pages cannot run this.** Pages serves static files; this app renders on a server
and writes to a database on every save. There is no configuration that changes that.

**GitHub Codespaces can**, and it is a real answer for a demo. A Codespace is a container
with a real Node process, and a forwarded port can be made public — giving a URL anyone
can open, on your existing GitHub account, for nothing.

1. On the repo: **Code → Codespaces → Create codespace on `multi-tenant`**.
2. `.devcontainer/devcontainer.json` installs, seeds the demo organisation and starts the
   app on port 3001. Give it a couple of minutes the first time.
3. **Ports panel → right-click 3001 → Port Visibility → Public.** It is private until you
   do this, and a private URL asks your client to sign in to GitHub.
4. Send them the `https://<codespace-name>-3001.app.github.dev` URL.

What to know before you rely on it:

- **It stops when idle** (30 minutes by default), and the URL goes dead until you reopen
  the Codespace. Fine for a demo you are on a call for; not for "have a poke this week".
- **The free allowance is 60 core-hours a month.** A 2-core machine left running spends it
  in about thirty hours.
- **The data lives in the Codespace.** Delete it and your client's test records go with it.
- **Confirmation emails are printed, not sent.** In development the mailer writes the
  message to the terminal, so if your client signs up you have to copy the link out of the
  Codespace terminal and send it to them. To have it actually send, add `SMTP_URL` and
  `MAIL_FROM` as Codespace secrets — see the SMTP section below.

For anything your client uses unattended, use a real host instead:

## Railway instead

1. **railway.app → New Project → Deploy from GitHub repo → `ayush-singhh/Internal-tool`.**
   Authorise Railway on the repo if it asks — it is private.
2. **Settings → Source → Branch: `multi-tenant`.** Not `main`; `main` is still the old
   single-tenant build.
3. Railway sees the `Dockerfile` and uses it. No build configuration needed.
4. **Add a Volume, mount path `/data`.** Without this every deploy starts from an empty
   database and your client's work vanishes. This is the step people skip.
5. **Settings → Networking → Generate Domain.** Note the URL it gives you.
6. **Variables** — set these, then redeploy:

   | Variable | Value | Why |
   |---|---|---|
   | `APP_URL` | the URL from step 5 | goes into the confirmation links; taken from config, never from the request, so a forged Host header cannot redirect a real token |
   | `ADMIN_EMAIL` | your address | the first administrator, created on first boot |
   | `ADMIN_PASSWORD` | something real | **change it from the default before the first boot** |
   | `SIGNUP_OPEN` | `1` | lets your client create their own organisation |
   | `SMTP_URL` | see below | without it nobody can confirm an address |
   | `MAIL_FROM` | `Carrier Hub <you@gmail.com>` | the visible sender |

   `CARRIER_DB_PATH` and `BACKUP_DIR` are already set by the Dockerfile and point at
   `/data`. Leave them alone.

With `SIGNUP_OPEN=1` and any of `SMTP_URL` / `MAIL_FROM` / `APP_URL` missing, the server
**refuses to start** (`src/instrumentation.ts`) rather than accepting signups it can never
confirm. If the deploy comes up unhealthy, that error is in the logs.

## SMTP: it must be port 465

The mailer speaks implicit TLS on **465** only. That is the whole compatibility list to
check — a provider without 465 will not work no matter what else you configure.

| Provider | Works | `SMTP_URL` |
|---|---|---|
| Gmail (app password) | yes | `smtps://you%40gmail.com:APP_PASSWORD@smtp.gmail.com:465` |
| SendGrid | yes | `smtps://apikey:SG.xxxx@smtp.sendgrid.net:465` |
| Resend | yes | `smtps://resend:re_xxxx@smtp.resend.com:465` |
| Amazon SES | yes | `smtps://USER:PASS@email-smtp.us-east-1.amazonaws.com:465` |
| **Postmark** | **no** | 25 / 587 / 2525 only — no implicit TLS port |

Gmail is the least setup for one client: Google account → 2-Step Verification → App
passwords → generate one for "Mail". Use the 16-character password, not your own. Any `@`
or `:` in a username or password must be percent-encoded (`@` → `%40`).

Nothing sends 465 for you in development: with no `SMTP_URL` the message is printed to the
terminal, link included, which is how to test the flow locally.

## Give them something to look at

A fresh signup lands in an empty organisation. Seed a populated one alongside it so your
client can see the product working before they start typing:

```bash
# in the Railway shell, once, after the first deploy
node --conditions=react-server scripts/seed-demo.ts
```

That creates **Demo Dispatch Co** — 46 synthetic carriers across every status, 7 people,
12 offboarding records — as an organisation of its own, isolated from every real tenant
exactly like a customer's would be. Sign-in: `dana@demo.local` / `demo1234`.

The carriers are invented. That is the only place in this system where that is allowed,
and it is why they live in their own organisation: real carrier records only ever arrive
through the Import screen or the Add Carrier form.

## What to tell your client

- The URL, and that they should **create their own account** — company name, their name,
  their work email — then click the link in the confirming email.
- That `dana@demo.local` / `demo1234` shows a company that has been running for a while,
  if they want to see it populated first.
- That their data is theirs: their organisation cannot see the demo one, and neither can
  see the other. That is enforced by the database, not by a filter someone might forget.

## After the demo

- **Turn signup off** (`SIGNUP_OPEN=0`, redeploy) once they have their account. While it
  is on, anyone with the URL can create an organisation.
- **Back up before you change anything**: `node scripts/backup.ts` in the shell writes a
  verified snapshot to `/data/backups`.
- Deleting the demo organisation is a row in `organizations`; everything it owns is
  removed with it by the composite foreign keys.

## Growing on it

The thing that decides everything here is that **the database is a file**. Not a server —
a file, on a disk, attached to one machine.

**What that costs you.** Two instances writing one SQLite file over a network volume
corrupts it, so there is exactly one machine, and each deploy has a few seconds of
downtime while the volume moves to the new one. The limit you will hit is *availability*,
never throughput: SQLite does thousands of writes a second on a laptop, and a CRM for
dispatch companies is nowhere near that. Do not move off it because of load. Move off it
when a few seconds of deploy downtime, or a second region, actually costs you something.

**What it buys you.** Customer two through two hundred share the same container and the
same database file. Your hosting cost is flat while your revenue is not, and there is no
per-tenant infrastructure to provision, monitor or forget about. That is the payoff from
the isolation work — every query is scoped, the guard refuses one that is not, and the
composite foreign keys mean the database itself will not let one tenant reference another.

**Where it will actually hurt, in order.**

1. **Backups are on the same disk as the thing they back up.** `npm run backup` is sound —
   `VACUUM INTO`, integrity-checked, reopened and counted before it is accepted — but
   nothing runs it on a schedule and nothing copies it off the machine. Lose the volume
   and you lose both. Before there is money involved: a cron job and a copy to somewhere
   else. This is the single highest-value hour you can spend, and it is the agreed next
   piece of work — see item 0 in `Plan.md`.
2. **Nothing tells you when it breaks.** A customer hitting a 500 is invisible from here.
3. **Deploys are not zero-downtime** and cannot be while the volume is attached to one
   machine. Deploy when nobody is dispatching.
4. **A forgotten password is a dead end** for an owner who signed up themselves. First
   item in `Plan.md`.

**If you do outgrow it**, the move is Postgres, and it is contained on purpose: every
query lives in `src/lib/*.ts`, pages compose them and never build SQL. Fly.io also has
LiteFS if you want SQLite replicas instead — the reason to prefer Fly over the others is
that it leaves both doors open.

## Fly.io, once

`fly.toml` is committed, so this is mostly copy and paste. Install the CLI first:
`brew install flyctl && fly auth signup`.

```bash
fly launch --no-deploy --copy-config     # keeps the committed fly.toml, creates the app
fly volumes create carrier_data --size 1 --region iad    # the disk the database lives on

# Secrets never go in fly.toml — it is in git. These are set once and remembered.
fly secrets set \
  ADMIN_EMAIL=you@yourcompany.com \
  ADMIN_PASSWORD='something you have not used anywhere else' \
  SMTP_URL='smtps://you%40gmail.com:APP_PASSWORD@smtp.gmail.com:465' \
  MAIL_FROM='Carrier Hub <you@gmail.com>'

fly deploy
fly scale count 1        # see the warning below — check this after every scaling change
fly open                 # your URL
```

Then edit `APP_URL` in `fly.toml` to the URL `fly open` gave you and `fly deploy` again —
it is what goes into confirmation emails, and it starts out as a guess at your app name.

Give your client something to look at:

```bash
fly ssh console -C "node --conditions=react-server /app/scripts/seed-demo.ts"
```

### The one thing that will bite you

**Never run more than one machine.** The database is a file on that volume, and a volume
attaches to exactly one machine. A second machine does not share it — it gets its own
empty volume and its own database. Nothing errors, nothing corrupts; you simply have two
half-populated copies of your product and customers landing randomly in one or the other,
which you will discover from a support email a fortnight later.

`fly scale count 1` after any scaling change. `fly status` should always show one machine.

To grow, grow *upward*: `fly scale vm shared-cpu-2x --memory 1024`.

### Everyday commands

```bash
fly logs                 # what it is doing, and the reason it refused to start
fly ssh console          # a shell inside the running machine
fly status               # machine count — should be 1
fly deploy               # ship; a few seconds of downtime while the volume moves
fly ssh console -C "node /app/scripts/backup.ts"    # a verified snapshot, now
```

Backups also run on a timer inside the server (`BACKUP_EVERY_HOURS`, daily by default) and,
where `BACKUP_S3_URL` is set, are copied off the machine. **Check them from `/support`** —
the Backups card leads with the last copy that actually reached off-machine storage, which
is the date a restore would take you back to. A card showing `degraded` means the snapshot
was fine and the upload was refused: the copy is on the same disk as the database, so
losing the volume loses both.

`DOCUMENTS_S3_URL` is the same idea for a different feature: **optional**, same
`https://KEY:SECRET@endpoint/bucket` shape, but a separate bucket and credentials from
`BACKUP_S3_URL` — it's where uploaded load documents (RC/BOL/POD) live, not backups.
Leave it unset and the Documents card on a load simply doesn't offer an upload form.

### Ending a tenancy

Out of band, like `support-user.ts` — `/support` is read-only and gets no exception for the
most destructive operation in the product.

```bash
npm run export-org -- <slug>                      # everything they own, as JSON
npm run delete-org -- <slug>                      # shows what would go; deletes nothing
npm run delete-org -- <slug> --confirm <slug>     # does it, exporting first
```

The export excludes password hashes and two-factor secrets, so it is safe to hand to the
customer. Deletion writes its own export first and refuses without one: the tenant's
`audit_log` and `support_access_log` rows go with them, and that file is where the record
survives.

