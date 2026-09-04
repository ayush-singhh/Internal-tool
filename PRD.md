# Carrier Management Hub — Product Requirements

## 1. Purpose

Replace the Google Sheets carrier tracker with an internal **Carrier CRM + Carrier
Operations Dashboard**. One authenticated, database-backed system where dispatch and
account management staff maintain the full lifecycle of every carrier: lead → onboarding
→ active → offboarding, with an auditable history of who changed what.

**Non-goal:** this is not a spreadsheet clone and not a public-facing product. It is an
internal tool for a known set of named employees.

## 2. Users & Roles

| Role | Who | Can |
|---|---|---|
| **Admin** | Ops leadership, system owner | Everything: create/edit/delete carriers, manage team, settings, import, export |
| **Dispatcher** | Assigned to carriers day-to-day | View all carriers; edit carriers assigned to them; add notes; cannot delete, cannot manage team/settings |
| **Account Manager** | Owns the commercial relationship | View all carriers; edit carriers they manage incl. commercial fields; add notes; cannot delete, cannot manage team/settings |
| **Management / Viewer** | Read-only oversight | View carriers, dashboards, reports, export. No writes. |

Authentication is required for every page. There are no public routes except `/login`.

## 3. Core Objects

- **Lead** — a carrier prospect, before there is a carrier record. Owned by the sales rep
  working it. Converts into a Carrier exactly once, and is kept afterwards as the record of
  how that carrier arrived.
- **Carrier** — the central record. Identity, contact, regulatory, equipment, team
  assignment, onboarding, commercial terms, agreement/billing.
- **Team Member (User)** — staff who log in and are assignable as Dispatcher or Account Manager.
- **Carrier Note** — timestamped, attributed internal note. Append-only.
- **Carrier Activity** — automatic audit entry for significant changes.
- **Offboarding Record** — the structured exit record for a departed carrier.
- **Task** — a piece of work with an owner and, usually, a due date. May be about a carrier.
- **Announcement** — a notice to everyone in the organisation.
- **Channel / Message** — an internal room, open to everyone or to one team, and the
  append-only messages in it.
- **Calendar Event** — something on a date that exists nowhere else. Most of what the
  calendar shows is derived from loads, tasks and carriers instead.
- **Lookups** — controlled vocabularies (status, plan, pricing type, lead source, …).

## 4. Functional Requirements

### 4.1 Dashboard
Live counts from the database: Total, Active, About to Be Active, Pending Investigation,
Inactive, Suspended, Blacklisted, Carrier Back-off, Total Trucks/Trailers, New This Month,
Offboarded This Month.

Charts: by Status, by Dispatcher, by Account Manager, by Lead Source, Plan distribution,
Monthly Onboarding trend, Monthly Offboarding trend.

Plus **Recent Activity** (latest audit entries) and **Needs Attention** (see 4.8).

### 4.1b Leads
The sales pipeline, ahead of the carrier database.

A lead carries only what is known before a relationship exists: company, contact, phone,
email, MC/USDOT, fleet size, trailer type, lead source and free notes. No dispatcher, no
plan, no rate, no agreement — those are carrier facts and are filled in after conversion.

**Stages:** New → Contacted → Qualified, with Lost as the exit. **Won is not settable.**
A lead becomes Won only by being converted, so a lead marked Won always has a carrier
behind it.

**Conversion** creates a carrier at *About to Be Active* carrying across exactly what the
lead held, and nothing invented. It happens once. The lead survives, marked Won and
pointing at the carrier, and is read-only from then on — it is the sales history of how
that customer arrived, and rewriting it would make that history say something untrue.

**Who sees what:** a sales rep sees and edits their own leads. Administrators and owners
see the whole pipeline and are the only roles that may convert, because conversion writes
a carrier record. Dispatchers, account managers and viewers have no lead access at all.

### 4.1c Tasks, Announcements and Alerts
The three screens every role has, whatever else their panel carries.

**Tasks** are work with a name and, usually, a date. A task is yours if it is assigned to
you *or* you raised it. Everyone keeps a list; only an administrator may put work on
somebody else's. Open or done, nothing in between — done clears it from every view, and
reopening restores it rather than spawning a second task saying the same thing.

**Announcements** go to everyone in the organisation. Administrators post, everyone reads.
Unread means "published since you last opened the page". Editing a notice does not
re-publish it.

**Alerts** are the summary: overdue and due-today tasks, unread announcements, and the
carrier work queue. **Nothing is stored.** Every alert is a live query against the thing it
describes, so it disappears the moment that thing is resolved — there is no notification to
mark read, expire, or find disagreeing with reality later. Each person sees only the parts
they already have access to: no carrier queue without carrier access, and only their own
tasks unless they manage the board.

### 4.1d Communication
Internal channels. **Nothing here reaches a carrier, a broker or a driver.**

Every organisation starts with three: **General** (everyone), **Dispatch Team** and
**Sales Team**. An administrator may open more, each addressed to everyone or to one role.
Administrators read every channel — this is an internal tool, and ops leadership seeing the
team rooms is the intended behaviour, not a leak.

Reading a channel and posting to it are the same permission: a channel you can read is one
you are part of. A channel you are not part of does not appear, and asking for it by URL
tells you nothing about whether it exists.

**Messages cannot be edited or deleted.** Correct one by sending another. Archiving a
channel keeps everything said in it and accepts nothing new.

Unread is tracked per channel, so opening one does not clear the others.

### 4.1e Brokers — Do Not Use
A broker may be flagged **Do Not Use**, with a required reason.

This is not the same as retiring one. Retiring (`Active → Retired`) hides a broker nobody
needs to think about again. **DNU keeps them visible** — at the top of the brokers page,
in the load form marked and unselectable — because the point is that the next person about
to book them learns why not, rather than finding a name mysteriously absent and adding it
back under a slightly different spelling.

No new load can be created against a flagged broker, and the refusal says why. **Loads
already booked with them are untouched** — a decision made today does not rewrite what has
already run.

Clearing the flag removes the reason with it. Only an administrator may flag or clear.

### 4.1f Planning Calendar
A month view that is **both** a window onto what already exists and a place to put things
that do not exist anywhere else.

**Derived, read-only:** pickup and delivery dates (from a load's stops), open task due
dates, and insurance expiries for live carriers. These appear because the record says so
and vanish when it changes — completing a task clears its date from the month. A derived
entry links to its record; you change the date *there*, not here, so there is one source of
truth and the calendar never becomes a second way to edit a load.

**Typed in:** events — a meeting, a yard closure, a driver's holiday. These are the only
entries the calendar itself owns, and the only ones that can be edited or removed on it.
An event may span days, and may carry a time.

Everyone sees only what they already have access to: no pickups without load access, no
insurance expiries without carrier access, and only your own task due dates unless you
manage the task board.

Administrators and dispatchers only. A dispatcher edits the events they raised; an
administrator edits all of them.

### 4.2 Carrier Database
Sortable, filterable, searchable table with user-selectable visible columns.

- **Quick filters:** All | Active | About to Be Active | Investigation | Inactive | Suspended | Blacklisted | Back-off
- **Advanced filters:** status, dispatcher, account manager, lead source, onboarding type,
  trailer type, pricing type, agreement status, subscription, invoice collection mode,
  onboarding date range, first load date range
- **Global search** across legal name, owner name, phone, email, MC, USDOT, address
- **Saved filters** — name and recall a filter set
- Sort by any major field

### 4.3 Carrier Profile
Sections: Overview, Contact, Regulatory/Equipment, Onboarding, Commercial,
Offboarding *(only when applicable)*, Internal Notes, Activity History.

### 4.4 Add / Edit Carrier
Multi-section form (Basic, Contact, Regulatory, Equipment, Team, Lead/Onboarding,
Commercial, Agreement/Billing, Notes). Dropdowns and date pickers over free text.
Editing never destroys unedited fields.

### 4.5 Status System
Seven controlled statuses, each with a distinct badge. Any status change writes an
Activity entry automatically. Moving to Inactive / Suspended / Blacklisted / Carrier
Back-off offers the offboarding workflow.

### 4.6 Pricing System
Structured, never one free-text blob: Pricing Type, Rate (numeric), Percentage (0–100),
Billing Frequency, Plan Name. Rendered as one human-readable string in tables and profile.

### 4.7 Offboarding
Captures date, reason, category, handler, final status, last load date, outstanding
balance, subscription cancelled, agreement closed, can-return, notes.
**Offboarded carriers are never deleted.** Their full record and history remain.

### 4.8 Needs Attention
Rule-driven work queue with thresholds configurable in Settings:
about-to-be-active longer than *N* days, agreement not signed, plan not pitched,
missing first load date, missing MC/USDOT, pending investigation past *N* days,
missing billing information, **insurance expired**, **insurance expiring within
*N* days**.

### 4.12 Insurance
Each carrier carries a certificate-of-insurance expiry date and the insurer's name.
A lapsed certificate on a live carrier is the highest-urgency item in the queue —
dispatching a load against one is a liability, not an administrative slip. Expiring
and expired are separate rules because they call for different actions: chase the
broker, versus stop giving that carrier loads.

Carriers with no expiry recorded are **not** flagged. Every existing record is empty
the day this ships, and a queue that opens with several hundred meaningless rows
teaches people to ignore it.

### 4.9 Reports
Active by dispatcher, active by account manager, by status, by lead source, by plan,
by percentage band, by trailer type, by fleet size, monthly onboarding, monthly
offboarding, retention, offboarding reasons, revenue/pricing distribution.
Date filtering. CSV export.

### 4.10 Import / Export
Import CSV with column mapping, row preview, duplicate MC/USDOT detection, a duplicate
handling choice (skip / create anyway / update existing), an error report before commit,
and no destruction of existing records. Export respects the current filter set.

### 4.11 Duplicate Protection
MC Number is the primary business identifier; USDOT is secondary. Creating a carrier with
either already on file raises a warning that links to the existing record — the user may
review and then proceed deliberately.

## 5. Data Quality Rules

- MC and USDOT: digits only
- Phone: auto-formatted, validated
- Email: validated
- Percentage: numeric, 0–100
- Truck/trailer count: non-negative integer
- Dates: real date inputs, stored ISO `YYYY-MM-DD`
- Statuses and other vocabularies: constrained to lookup values, never free text

## 6. Migration Rules

The existing spreadsheet is the initial data source. **No carrier records are invented.**
During import, values are preserved exactly as they appear. Where a value is inconsistent,
misspelled, or unmatched against a controlled vocabulary, the original is preserved and
the row is **flagged for review** rather than silently corrected.

## 7. Design Direction

Modern premium B2B SaaS admin. Dark sidebar, light content canvas, cards, dense tables,
clear status badges, strong hierarchy, subtle borders and shadows. Restrained palette,
no heavy gradients, no cartoon illustration. Desktop-first with a working mobile layout.
Information density is a feature.

## 8. Success Criteria

Adding a carrier is measurably easier than adding a spreadsheet row — dropdowns, date
pickers, formatting, validation, and defaults mean nobody hand-formats a value. Every
significant change is attributable. The team stops opening the spreadsheet.
