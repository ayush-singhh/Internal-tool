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

- **Carrier** — the central record. Identity, contact, regulatory, equipment, team
  assignment, onboarding, commercial terms, agreement/billing.
- **Team Member (User)** — staff who log in and are assignable as Dispatcher or Account Manager.
- **Carrier Note** — timestamped, attributed internal note. Append-only.
- **Carrier Activity** — automatic audit entry for significant changes.
- **Offboarding Record** — the structured exit record for a departed carrier.
- **Lookups** — controlled vocabularies (status, plan, pricing type, lead source, …).

## 4. Functional Requirements

### 4.1 Dashboard
Live counts from the database: Total, Active, About to Be Active, Pending Investigation,
Inactive, Suspended, Blacklisted, Carrier Back-off, Total Trucks/Trailers, New This Month,
Offboarded This Month.

Charts: by Status, by Dispatcher, by Account Manager, by Lead Source, Plan distribution,
Monthly Onboarding trend, Monthly Offboarding trend.

Plus **Recent Activity** (latest audit entries) and **Needs Attention** (see 4.8).

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
missing billing information.

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
