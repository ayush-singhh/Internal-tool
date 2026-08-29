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

## Railway, once

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

## Fly.io instead

Same Dockerfile, no repo connection:

```bash
brew install flyctl && fly auth signup
fly launch --no-deploy               # keep the Dockerfile it finds
fly volumes create carrier_data --size 1
# fly.toml: mount carrier_data at /data
fly secrets set ADMIN_EMAIL=... ADMIN_PASSWORD=... APP_URL=https://<app>.fly.dev \
  SIGNUP_OPEN=1 SMTP_URL=... MAIL_FROM=...
fly deploy
```
