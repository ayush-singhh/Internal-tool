# Load documents (RC / BOL / POD) — design

**Status:** implemented
**Date:** 2026-09-02
**Branch:** `multi-tenant`
**Amended:** during the implementation plan's pre-flight scan — `DOCUMENT_MAX_BYTES`
lowered from 15MB to 10MB (see the note beside the constant). The design's other
approved decisions are unchanged.

## Context

Phase 15 (Asterism dispatch domain, `HANDOFF.md`) has loads, drivers and brokers built.
Two things remain: invoicing (blocked on invoice samples from the client) and documents.
Documents are unblocked and are the subject of this spec.

`Plan.md`'s "Deferred by design" table has carried this line since the single-tenant phase:

> File attachments (agreements, COIs) — Not in scope — **Document storage is requested**

That line is now true. This spec scopes the first slice of it.

## Goals

- A dispatcher can attach a Rate Confirmation, Bill of Lading, Proof of Delivery, or an
  "Other" document to a load.
- Anyone who can see the load (`load:view`) can see and download what's attached.
- Files live in S3-compatible object storage, not the SQLite database or the app server's
  disk.

## Non-goals (for this slice)

- **Carrier-side attachments** (agreements, COI scans) — the `Plan.md` deferral covers
  these too, but they're a separate record type with their own screen. Not built here.
  Revisit once this slice ships; the storage/download primitives below don't need to
  change to support it, only a second table keyed on `carrier_id` instead of `load_id`.
- **Per-stop document scoping.** A document attaches to the load as a whole, never to one
  of its up-to-five pickup/delivery stops. Multiple documents of the same `kind` are
  allowed, so multiple POD photos on a multi-stop load just live together, unlabeled by
  which stop produced them.
- **Deletion.** No delete action, anywhere. A wrong upload is superseded by uploading the
  correct file, never removed — same rule as `carrier_activity` (AI Rules §2), and for the
  same reason: a POD/RC is potential evidence in a payment dispute.
- **Audit-log entries for uploads/downloads.** Unlike a CSV export (a bulk, broad
  data-out event), viewing one document on a load the user can already see in full is not
  a new class of exposure. Not logged.
- **A configurable size/type allow-list.** Fixed constants (below), not a Settings screen.
  Expand the constant if a real file type needs it; don't build a picker nobody asked for.

## Data model

### Migration 16

```sql
CREATE TABLE IF NOT EXISTS load_documents (
  id              INTEGER PRIMARY KEY,
  organization_id INTEGER NOT NULL,
  load_id         INTEGER NOT NULL,
  -- 'rate_confirmation' | 'bol' | 'pod' | 'other' — see DOCUMENT_KIND in constants.ts.
  -- A fixed industry taxonomy, not a per-tenant vocabulary, so it stays out of `lookups`
  -- the same way LOAD_STATUS and LOAD_EXCEPTION do.
  kind            TEXT NOT NULL,
  -- The name as uploaded, for display and for the download's Content-Disposition. Never
  -- used to build the storage key or any filesystem/URL path.
  filename        TEXT NOT NULL,
  storage_key     TEXT NOT NULL,
  content_type    TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  uploaded_by     INTEGER NOT NULL,
  created_at      TEXT NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations (id),
  FOREIGN KEY (organization_id, load_id)     REFERENCES loads (organization_id, id),
  FOREIGN KEY (organization_id, uploaded_by) REFERENCES users (organization_id, id)
);
CREATE INDEX IF NOT EXISTS idx_load_documents_org ON load_documents (organization_id);
CREATE INDEX IF NOT EXISTS idx_load_documents_load ON load_documents (organization_id, load_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_load_documents_org_id ON load_documents (organization_id, id);
```

Matches migration 15's conventions exactly: `id INTEGER PRIMARY KEY` (no `AUTOINCREMENT` —
SQLite's rowid alias already behaves that way), composite FKs to every tenant table it
references, the `(organization_id, id)` unique index every tenant table carries.

`load_documents` is added to `TENANT_TABLES` in `tenant-db.ts` — Layer 2, the fail-closed
query guard, refuses any query against it that doesn't constrain `organization_id`.

### `constants.ts`

```ts
export const DOCUMENT_KIND = {
  RATE_CONFIRMATION: "rate_confirmation",
  BOL: "bol",
  POD: "pod",
  OTHER: "other",
} as const;
export type DocumentKind = (typeof DOCUMENT_KIND)[keyof typeof DOCUMENT_KIND];

export const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  rate_confirmation: "Rate Confirmation",
  bol: "Bill of Lading",
  pod: "Proof of Delivery",
  other: "Other",
};

export const DOCUMENT_KIND_TONE: Record<DocumentKind, Tone> = {
  rate_confirmation: "blue",
  bol: "slate",
  pod: "green",
  other: "slate",
};

/** Content-Type allow-list. Reject anything else at upload — never trust the browser's
 *  declared type alone for what gets served back to a browser later. */
export const DOCUMENT_ALLOWED_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
// 10MB, not 15MB: next.config.ts already caps Server Action bodies at 12mb (raised from
// the 1MB default for CSV import), and the multipart/form-data envelope around the file
// adds overhead beyond the raw bytes. 10MB leaves headroom under that ceiling rather than
// raising a limit shared by every Server Action in the app for one feature.
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
```

## Storage layer

### `s3.ts`

Add `getObject`, the GET counterpart to the existing `putObject`. Same `signRequest`
helper, no new dependency:

```ts
export async function getObject(dest: Destination, key: string): Promise<Response> {
  const url = new URL(`${dest.base.pathname.replace(/\/+$/, "")}/${key}`, dest.base);
  const headers = signRequest("GET", url, Buffer.alloc(0), dest.credentials, new Date(), {
    "x-amz-content-sha256": sha256(Buffer.alloc(0)),
  });
  const response = await fetch(url, { method: "GET", headers });
  if (!response.ok) {
    throw new Error(`Download of ${key} was refused (${response.status}): ${(await response.text()).slice(0, 300)}`);
  }
  return response;
}
```

### Env var

`DOCUMENTS_S3_URL`, same shape and same `destination()` parser as `BACKUP_S3_URL`
(`https://KEY:SECRET@endpoint/bucket`). Separate from the backup bucket/credentials —
documents are customer-facing content with different access patterns than an operational
backup.

`documentsConfigured(): boolean` in a small `documents-config.ts` (or inline in
`documents.ts`) — `true` iff `DOCUMENTS_S3_URL` is set. No `instrumentation.ts`
boot-refusal like `SIGNUP_OPEN` gets: this is an optional feature, not a security gate, so
an unset var just means the feature doesn't render. Nothing to refuse.

### Storage key

`${org.id}/loads/${loadId}/${crypto.randomUUID()}` — no dependency on the original
filename (which is never trusted for a path), unique without needing to check for
collisions.

## Upload — Server Action

`src/lib/documents.ts` (plain module, per AI Rules §8 — testable without request context):

```ts
export function listLoadDocuments(org: Org, loadId: number): DocumentRow[]

/** Tenant-scoped single-row lookup by id — what the download route resolves against.
 *  Undefined for a missing id or one that belongs to another tenant; the route turns
 *  either into the same 404, so it never distinguishes "not found" from "not yours". */
export function getLoadDocument(org: Org, id: number): DocumentRow | undefined

export async function uploadLoadDocument(
  org: Org,
  loadId: number,
  kind: DocumentKind,
  file: { name: string; type: string; size: number; buffer: Buffer },
  userId: number,
): Promise<Result> // { ok: true; id: number } | { ok: false; error: string }
```

`uploadLoadDocument`:
1. Confirms `loadId` belongs to `org` (mirrors every other write in `dispatch-admin.ts`).
2. Rejects an unknown `kind`, a `content_type` outside `DOCUMENT_ALLOWED_TYPES`, or a size
   over `DOCUMENT_MAX_BYTES` — all server-side, regardless of what the `<input accept>`
   or client already filtered (AI Rules §7).
3. Refuses if `!documentsConfigured()`.
4. Uploads to S3 first via `putObject`. Only inserts the `load_documents` row once that
   succeeds — an S3 failure must not create a row pointing at nothing.

`src/lib/document-actions.ts` (`"use server"`, thin wrapper — AI Rules §8's
`notes.ts`/`note-actions.ts` pairing):

```ts
export async function uploadDocumentAction(_prev: AdminState, form: FormData): Promise<AdminState> {
  const { user, org } = await requireOrg();
  if (!can(user, "load:manage")) return { error: "Only dispatch can attach documents." };
  // read loadId, kind, file from form; file.arrayBuffer() -> Buffer
  // delegate to uploadLoadDocument; revalidatePath(`/loads/${loadId}`)
}
```

## Download — Route Handler

AI Rules §5: `src/app/api/` is reserved for file downloads; this is one.

`src/app/api/documents/[id]/route.ts`:

```ts
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, org } = await requireOrg();
  if (!can(user, "load:view")) return new Response(null, { status: 404 });
  const doc = getLoadDocument(org, Number((await params).id)); // tenant-scoped lookup
  if (!doc) return new Response(null, { status: 404 });
  if (!documentsConfigured()) return new Response(null, { status: 404 });
  const upstream = await getObject(destination(process.env.DOCUMENTS_S3_URL!), doc.storage_key);
  return new Response(upstream.body, {
    headers: {
      "content-type": doc.content_type,
      // Forces download rather than inline render — same-origin uploaded content is not
      // something the app should ever let a browser execute or render as HTML/SVG. The
      // global `nosniff` header (security-headers.ts) covers the rest.
      "content-disposition": `attachment; filename="${doc.filename.replace(/"/g, "")}"`,
    },
  });
}
```

A 404 for both "not found" and "wrong tenant" and "not authorized" — same non-distinguishing
pattern the rest of the app already uses (carriers, loads) so a probe can't tell which case
it hit.

**No rate limit here, decided out loud.** `BUGS.md`'s report-export entry concludes that
when one route gets a control, the sibling route needs the same decision made explicitly —
even when the answer is "not this one." `/api/export` is rate-limited and audited because it
is a bulk, broad data-out event: one request can reconstruct a large slice of the carrier
book. A single document download is neither: it is one indexed lookup by primary key
(`getLoadDocument`, `organization_id` + `id`) plus one streamed fetch from object storage,
scoped to a document the caller already has `load:view` on — the same content they can
already see rendered on the load's page. There is no aggregation to throttle and no bulk
extraction the limiter on `/api/export` exists to catch.

## UI

A "Documents" card on `/loads/[id]`, below the existing status/detail sections:

- Table: kind badge (`DOCUMENT_KIND_TONE`), filename, uploaded-by, uploaded-at, a
  `<a href="/api/documents/{id}">` download link. Visible to anyone with `load:view` —
  same audience as the rest of the load detail page.
- An upload form (kind `<select>` + `<input type="file">`) visible only when
  `can(user, "load:manage") && documentsConfigured()`. No dead upload button on a
  deployment that hasn't set `DOCUMENTS_S3_URL`.
- No delete affordance anywhere, matching the append-only decision.
- Empty state: "No documents yet" when the load has none, matching `EmptyState` usage
  elsewhere.

## Permissions

Reuses `load:view` (see/download) and `load:manage` (upload) — no new `Action` added to
`permissions.ts`. Same reasoning as reusing `driver:manage` rather than inventing a
one-off verb: nothing here needs a permission distinct from "can see this load" /
"can manage this load."

## Testing

`tests/documents.test.ts`, following AI Rules §8 and the existing
`tests/backup.test.ts` pattern for exercising the S3 path — a real `node:http` server
standing in for S3 in the test, not a mocking library:

- Content-type outside the allow-list is rejected.
- Size over `DOCUMENT_MAX_BYTES` is rejected.
- Tenant isolation: org A cannot fetch org B's document by id (via `getLoadDocument`).
- Upload against a load that doesn't belong to the org is refused.
- A successful upload round-trips through the local fake-S3 server and lands in
  `load_documents` with the right `kind`/`filename`/`size_bytes`.
- `getObject` against the fake server: success and a non-2xx rejection, mirroring
  `putObject`'s existing coverage.

`s3.ts`'s `getObject` addition also gets exercised by this suite rather than a separate
one — there's no reason to stand up two fake servers for two S3 verbs used by one feature.

## Rollout

New migration (16), so `npm run migrate` picks it up on any existing database — no
backfill needed since the table starts empty. Nothing in this feature is destructive
(AI Rules §9's backup-first rule for destructive migrations doesn't apply — this is
additive only).

`DEPLOY.md` should note `DOCUMENTS_S3_URL` as optional, same section as `BACKUP_S3_URL`,
once this ships.
