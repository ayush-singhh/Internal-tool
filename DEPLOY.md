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
