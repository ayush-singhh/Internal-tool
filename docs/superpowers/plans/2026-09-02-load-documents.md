# Load Documents (RC/BOL/POD) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a dispatcher attach a Rate Confirmation, Bill of Lading, Proof of Delivery, or
Other document to a load, stored in S3-compatible object storage, downloadable by anyone
who can see the load.

**Architecture:** A new tenant-owned `load_documents` table (migration 16) records
metadata; the file bytes live in S3, uploaded via a Server Action and downloaded through a
`src/app/api/` Route Handler that streams the bytes back after re-checking auth. Append-only
— no delete path anywhere. The feature is entirely absent (no upload button) on a
deployment that hasn't set `DOCUMENTS_S3_URL`.

**Tech Stack:** Next.js 16 (App Router, Server Actions + Route Handlers), TypeScript,
`node:sqlite`, the existing hand-rolled SigV4 signer in `src/lib/s3.ts` — no new dependency.

**Spec:** `docs/superpowers/specs/2026-09-02-load-documents-design.md`

## Global Constraints

- **No new runtime dependency.** File upload/download uses Web APIs (`File`, `FormData`,
  `fetch`, `Response`) and the existing `s3.ts` signer.
- **`load_documents` is tenant-owned.** Every query constrains `organization_id`, or the
  Layer-2 guard in `db.ts` throws. It's added to `TENANT_TABLES` in `tenant-db.ts`.
- **Append-only.** No update or delete function/action/route exists for a document, ever.
- **Content-Type allow-list at upload:** `application/pdf`, `image/jpeg`, `image/png`.
  Reject anything else server-side regardless of what the client declared.
- **Size cap:** 10MB (`10 * 1024 * 1024` bytes), enforced server-side. Not 15MB: `next.config.ts`
  already caps every Server Action body at 12mb (raised from the 1MB default for CSV
  import), and the multipart envelope around the file adds overhead beyond the raw bytes —
  10MB leaves headroom under that shared ceiling instead of raising it for one feature.
- **Feature gating:** `DOCUMENTS_S3_URL` unset ⇒ no upload UI, no working upload action.
  Not a boot-time refusal like `SIGNUP_OPEN` — just an absent feature.
- **Permissions:** reuses `load:view` (see/download) and `load:manage` (upload). No new
  `Action` added to `permissions.ts`.
- **Write logic lives in a plain module** (`src/lib/documents.ts`); the Server Action
  (`src/lib/document-actions.ts`) is a thin `requireOrg()` + `can()` wrapper, per AI Rules §8
  — mirrors `notes.ts` / `note-actions.ts` and this session's own `dispatch-admin.ts` /
  `dispatch-admin-actions.ts`.
- **A 404 never distinguishes "not found" from "not yours" from "not authorized."** Same
  pattern the rest of the app already uses for carriers and loads.

---

### Task 1: Schema — migration 16, `TENANT_TABLES`, constants

**Files:**
- Modify: `src/lib/migrations.ts` (append migration 16 to the `MIGRATIONS` array, after
  version 15's closing `},` and before the array's closing `];`)
- Modify: `src/lib/tenant-db.ts` (add `"load_documents"` to `TENANT_TABLES`)
- Modify: `src/lib/constants.ts` (insert after `LOAD_EXCEPTION_LABELS`, before the "A stop
  is a pickup or a delivery" comment)
- Test: `tests/dispatch-schema.test.ts` (extend — this is the file that already holds
  "the dispatch tables, held to the same standard as the carrier tables")

**Interfaces:**
- Produces: `DOCUMENT_KIND` (`{RATE_CONFIRMATION: "rate_confirmation", BOL: "bol", POD:
  "pod", OTHER: "other"}` as const), `type DocumentKind`, `DOCUMENT_KIND_LABELS`,
  `DOCUMENT_KIND_TONE`, `DOCUMENT_ALLOWED_TYPES` (`["application/pdf", "image/jpeg",
  "image/png"] as const`), `DOCUMENT_MAX_BYTES` (`10 * 1024 * 1024`) — all from
  `src/lib/constants.ts`, consumed by Tasks 3, 4, 6.
- Produces: the `load_documents` table (columns: `id`, `organization_id`, `load_id`,
  `kind`, `filename`, `storage_key`, `content_type`, `size_bytes`, `uploaded_by`,
  `created_at`) — consumed by Task 3's queries.

- [ ] **Step 1: Write the failing tests**

Open `tests/dispatch-schema.test.ts`. Add this test right after the existing "stops belong
to a load in the same tenant, and go when it goes" test (before "the fail-closed guard
covers the dispatch tables too"):

```ts
test("a load document cannot reference another tenant's load", () => {
  db.run(
    `INSERT INTO loads (organization_id, carrier_id, status, created_at, updated_at)
     VALUES (?, ?, 'created', ?, ?)`,
    [alpha.id, alphaCarrier, now(), now()],
  );
  const load = db.get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id;
  const betaOwner = db.get<{ id: number }>(
    "SELECT id FROM users WHERE organization_id = ?", [beta.id])!.id;

  assert.throws(
    () =>
      db.run(
        `INSERT INTO load_documents (organization_id, load_id, kind, filename, storage_key,
                                      content_type, size_bytes, uploaded_by, created_at)
         VALUES (?, ?, 'other', 'x.pdf', 'key', 'application/pdf', 10, ?, ?)`,
        [beta.id, load, betaOwner, now()],
      ),
    /FOREIGN KEY constraint failed/,
    "another tenant cannot attach a document to this load",
  );
});
```

Then edit the existing "the fail-closed guard covers the dispatch tables too" test —
change its table list from:

```ts
  for (const table of ["drivers", "brokers", "loads", "load_stops"]) {
```

to:

```ts
  for (const table of ["drivers", "brokers", "loads", "load_stops", "load_documents"]) {
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="load document|fail-closed guard covers"`

Expected: FAIL — `no such table: load_documents` (first test) and the guard-coverage test
fails its `TENANT_TABLES.includes("load_documents")` assertion.

- [ ] **Step 3: Add the migration**

In `src/lib/migrations.ts`, find the migration array entry with `version: 15` — it ends
with:

```ts
      db.exec("CREATE INDEX IF NOT EXISTS idx_stops_load ON load_stops (load_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_stops_org ON load_stops (organization_id)");
    },
  },
];
```

Replace that closing `];` with a new migration 16 entry, then the closing `];`:

```ts
      db.exec("CREATE INDEX IF NOT EXISTS idx_stops_load ON load_stops (load_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_stops_org ON load_stops (organization_id)");
    },
  },
  {
    version: 16,
    name: "load documents: RC, BOL, POD, Other",
    up: (db) => {
      // Load-scoped, not per-stop: a multi-stop load's PODs just live together, unlabeled
      // by which delivery produced them. Append-only — no update/delete column or path
      // anywhere, the same rule carrier_activity already follows, for the same reason: a
      // POD or RC is potential evidence in a payment dispute.
      //
      // `kind` is a fixed four-value taxonomy (see DOCUMENT_KIND in constants.ts), kept
      // out of `lookups` the same way LOAD_STATUS and LOAD_EXCEPTION are: it's not a
      // per-tenant vocabulary a customer would rename or retire.
      db.exec(`
        CREATE TABLE IF NOT EXISTS load_documents (
          id              INTEGER PRIMARY KEY,
          organization_id INTEGER NOT NULL,
          load_id         INTEGER NOT NULL,
          kind            TEXT NOT NULL,
          -- The name as uploaded. Display and download filename only — never used to
          -- build the storage key or any filesystem/URL path.
          filename        TEXT NOT NULL,
          storage_key     TEXT NOT NULL,
          content_type    TEXT NOT NULL,
          size_bytes      INTEGER NOT NULL,
          uploaded_by     INTEGER NOT NULL,
          created_at      TEXT NOT NULL,
          FOREIGN KEY (organization_id) REFERENCES organizations (id),
          FOREIGN KEY (organization_id, load_id)     REFERENCES loads (organization_id, id),
          FOREIGN KEY (organization_id, uploaded_by) REFERENCES users (organization_id, id)
        )`);
      db.exec("CREATE INDEX IF NOT EXISTS idx_load_documents_org ON load_documents (organization_id)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_load_documents_load ON load_documents (organization_id, load_id)");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_load_documents_org_id ON load_documents (organization_id, id)");
    },
  },
];
```

In `src/lib/tenant-db.ts`, add `"load_documents"` to the `TENANT_TABLES` array (after
`"load_stops"`):

```ts
export const TENANT_TABLES = [
  "carriers",
  "carrier_notes",
  "carrier_activity",
  "offboarding_records",
  "saved_filters",
  "users",
  "lookups",
  "app_settings",
  "audit_log",
  "drivers",
  "brokers",
  "loads",
  "load_stops",
  "load_documents",
] as const;
```

In `src/lib/constants.ts`, insert after the `LOAD_EXCEPTION_LABELS` block (right before
the `/** A stop is a pickup or a delivery. ... */` comment):

```ts
/**
 * A document attached to a load — Rate Confirmation, Bill of Lading, Proof of Delivery, or
 * anything else dispatch needs on file (a lumper receipt, a scale ticket, damage photos).
 * Kept out of `lookups` for the same reason LOAD_STATUS and LOAD_EXCEPTION are: a fixed
 * industry taxonomy, not something a tenant customizes.
 */
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

/** Reject anything else at upload — never trust a browser's declared type alone for what
 *  gets served back to a browser later. */
export const DOCUMENT_ALLOWED_TYPES = ["application/pdf", "image/jpeg", "image/png"] as const;
// 10MB, not 15MB: next.config.ts already caps every Server Action body at 12mb (raised
// from the 1MB default for CSV import); this leaves headroom under that shared ceiling
// for the multipart envelope rather than raising it for one feature.
export const DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`

Expected: all tests pass, including the two touched/added above. Also run
`npx tsc --noEmit` (after `npx next typegen` if it complains about route types) to confirm
the new constants compile clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/migrations.ts src/lib/tenant-db.ts src/lib/constants.ts tests/dispatch-schema.test.ts
git commit -m "Add load_documents schema: migration 16, tenant guard, DOCUMENT_KIND"
```

---

### Task 2: `s3.ts` — `getObject`

**Files:**
- Modify: `src/lib/s3.ts` (add `getObject`, after the existing `putObject`)
- Create: `tests/documents.test.ts`

**Interfaces:**
- Consumes: `Destination`, `signRequest` (existing exports of `s3.ts`).
- Produces: `getObject(dest: Destination, key: string): Promise<Response>` — consumed by
  Task 5's Route Handler.

- [ ] **Step 1: Write the failing test**

Create `tests/documents.test.ts`:

```ts
/**
 * Load documents — RC, BOL, POD, Other. Held to the same S3-round-trip standard
 * `tests/backup.test.ts` already set for `putObject`: a real `node:http` server standing
 * in for S3, not a mocking library.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { destination, getObject } from "../src/lib/s3.ts";

const DB = path.join(tmpdir(), `carrier-hub-documents-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});

// ── a fake S3, the same shape backup.test.ts uses ──────────────────────────────

function fakeS3(status = 200, body = ""): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(status).end(status === 200 ? body : "<Error>AccessDenied</Error>");
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as { port: number }).port }),
    );
  });
}

test("getObject returns what the server sends", async () => {
  const { server, port } = await fakeS3(200, "pdf bytes here");
  try {
    const dest = destination(`http://KEY:SECRET@127.0.0.1:${port}/docs`);
    const res = await getObject(dest, "1/loads/1/some-key");
    assert.equal(await res.text(), "pdf bytes here");
  } finally {
    server.close();
  }
});

test("a refused download says what the provider said", async () => {
  const { server, port } = await fakeS3(403);
  try {
    const dest = destination(`http://KEY:SECRET@127.0.0.1:${port}/docs`);
    await assert.rejects(() => getObject(dest, "missing-key"), /403[\s\S]*AccessDenied/);
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- --test-name-pattern="getObject|refused download"`

Expected: FAIL — `getObject is not a function` (it's not exported from `s3.ts` yet).

- [ ] **Step 3: Implement `getObject`**

In `src/lib/s3.ts`, add this after `putObject` (which ends with `return url.toString(); }`):

```ts
/** Downloads one object. Throws with the provider's own words when it refuses — same
 *  shape as putObject's failure, so a caller handles both the same way. */
export async function getObject(dest: Destination, key: string): Promise<Response> {
  const url = new URL(`${dest.base.pathname.replace(/\/+$/, "")}/${key}`, dest.base);
  const headers = signRequest("GET", url, Buffer.alloc(0), dest.credentials, new Date(), {
    "x-amz-content-sha256": sha256(Buffer.alloc(0)),
  });
  const response = await fetch(url, { method: "GET", headers });
  if (!response.ok) {
    throw new Error(
      `Download of ${key} was refused (${response.status}): ${(await response.text()).slice(0, 300)}`,
    );
  }
  return response;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --test-name-pattern="getObject|refused download"`

Expected: PASS, both tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/s3.ts tests/documents.test.ts
git commit -m "s3.ts: add getObject, the GET counterpart to putObject"
```

---

### Task 3: `documents.ts` — list, get, upload

**Files:**
- Create: `src/lib/documents.ts`
- Modify: `tests/documents.test.ts` (extend)

**Interfaces:**
- Consumes: `Org` (`tenant-db.ts`), `all`/`get`/`run` (`db.ts`), `destination`/`putObject`
  (`s3.ts`), `DOCUMENT_KIND`/`DOCUMENT_ALLOWED_TYPES`/`DOCUMENT_MAX_BYTES`/`DocumentKind`
  (`constants.ts`, Task 1).
- Produces (consumed by Task 4's action and Task 5's route):
  - `type DocumentRow = { id: number; organization_id: number; load_id: number; kind:
    DocumentKind; filename: string; storage_key: string; content_type: string;
    size_bytes: number; uploaded_by: number; uploaded_by_name: string; created_at: string }`
  - `type Result = { ok: true; id: number } | { ok: false; error: string }`
  - `listLoadDocuments(org: Org, loadId: number): DocumentRow[]`
  - `getLoadDocument(org: Org, id: number): DocumentRow | undefined`
  - `documentsConfigured(): boolean`
  - `uploadLoadDocument(org: Org, loadId: number, kind: string, file: { name: string; type:
    string; size: number; buffer: Buffer }, userId: number): Promise<Result>`

- [ ] **Step 1: Write the failing tests**

Append to `tests/documents.test.ts`, after the `getObject` tests, and change its top-of-file
imports and setup. Change the top of the file from:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { destination, getObject } from "../src/lib/s3.ts";

const DB = path.join(tmpdir(), `carrier-hub-documents-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});
```

to:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { destination, getObject } from "../src/lib/s3.ts";
import { seedOrg, lookupId, type TestOrg } from "./helpers.ts";

const DB = path.join(tmpdir(), `carrier-hub-documents-${process.pid}.db`);
process.env.CARRIER_DB_PATH = DB;

let db: typeof import("../src/lib/db.ts");
let docs: typeof import("../src/lib/documents.ts");
let write: typeof import("../src/lib/load-write.ts");
let alpha: TestOrg;
let beta: TestOrg;
let alphaLoad: number;
let betaLoad: number;

const now = () => new Date().toISOString();

before(async () => {
  db = await import("../src/lib/db.ts");
  docs = await import("../src/lib/documents.ts");
  write = await import("../src/lib/load-write.ts");
  const { Org } = await import("../src/lib/tenant-db.ts");

  alpha = seedOrg(db, "Alpha Dispatch");
  beta = seedOrg(db, "Beta Dispatch");

  for (const org of [alpha, beta]) {
    db.run(
      `INSERT INTO carriers (organization_id, legal_name, status_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      [org.id, `Carrier ${org.id}`, lookupId(db, org.id, "status", "active"), now(), now()],
    );
  }
  const alphaCarrier = db.get<{ id: number }>(
    "SELECT id FROM carriers WHERE organization_id = ?", [alpha.id])!.id;
  const betaCarrier = db.get<{ id: number }>(
    "SELECT id FROM carriers WHERE organization_id = ?", [beta.id])!.id;

  const alphaOrg = new Org(alpha.id);
  const betaOrg = new Org(beta.id);
  alphaLoad = (write.createLoad(alphaOrg, {
    carrierId: alphaCarrier, stops: [{ kind: "pickup", city: "Dallas" }, { kind: "delivery", city: "Newark" }],
  }, alpha.ownerId) as { id: number }).id;
  betaLoad = (write.createLoad(betaOrg, {
    carrierId: betaCarrier, stops: [{ kind: "pickup", city: "Reno" }, { kind: "delivery", city: "Tulsa" }],
  }, beta.ownerId) as { id: number }).id;
});

after(() => {
  for (const s of ["", "-wal", "-shm"]) rmSync(`${DB}${s}`, { force: true });
});
```

Note: `getObject`/`putObject`'s tests above don't need `db` at all, and Node's test runner
runs `before()` once for the whole file before any test — that's fine, it mirrors
`backup.test.ts`'s own shape (its `before()` sets up `db` even though the signing tests
that run first never touch it).

Now append these tests at the end of the file:

```ts
// ── validation ───────────────────────────────────────────────────────────────

test("an unknown document kind is rejected", async () => {
  const { Org } = await import("../src/lib/tenant-db.ts");
  const result = await docs.uploadLoadDocument(
    new Org(alpha.id), alphaLoad, "invoice",
    { name: "x.pdf", type: "application/pdf", size: 10, buffer: Buffer.from("x") },
    alpha.ownerId,
  );
  assert.deepEqual(result, { ok: false, error: "Unknown document kind." });
});

test("a content type outside the allow-list is rejected", async () => {
  const { Org } = await import("../src/lib/tenant-db.ts");
  const result = await docs.uploadLoadDocument(
    new Org(alpha.id), alphaLoad, "other",
    { name: "x.exe", type: "application/x-msdownload", size: 10, buffer: Buffer.from("x") },
    alpha.ownerId,
  );
  assert.equal(result.ok, false);
});

test("a file over the size limit is rejected", async () => {
  const { Org } = await import("../src/lib/tenant-db.ts");
  const { DOCUMENT_MAX_BYTES } = await import("../src/lib/constants.ts");
  const result = await docs.uploadLoadDocument(
    new Org(alpha.id), alphaLoad, "other",
    { name: "x.pdf", type: "application/pdf", size: DOCUMENT_MAX_BYTES + 1, buffer: Buffer.from("x") },
    alpha.ownerId,
  );
  assert.equal(result.ok, false);
});

test("upload against another tenant's load is refused", async () => {
  const { Org } = await import("../src/lib/tenant-db.ts");
  const result = await docs.uploadLoadDocument(
    new Org(alpha.id), betaLoad, "other",
    { name: "x.pdf", type: "application/pdf", size: 10, buffer: Buffer.from("x") },
    alpha.ownerId,
  );
  assert.deepEqual(result, { ok: false, error: "Unknown load." });
});

test("upload is refused when document storage is not configured", async () => {
  const { Org } = await import("../src/lib/tenant-db.ts");
  delete process.env.DOCUMENTS_S3_URL;
  const result = await docs.uploadLoadDocument(
    new Org(alpha.id), alphaLoad, "other",
    { name: "x.pdf", type: "application/pdf", size: 10, buffer: Buffer.from("x") },
    alpha.ownerId,
  );
  assert.equal(result.ok, false);
  assert.equal(docs.documentsConfigured(), false);
});

// ── the round trip ──────────────────────────────────────────────────────────

test("a successful upload round-trips through storage and lists back with the uploader's name", async () => {
  const { Org } = await import("../src/lib/tenant-db.ts");
  const { server, port } = await fakeS3();
  process.env.DOCUMENTS_S3_URL = `http://KEY:SECRET@127.0.0.1:${port}/docs`;
  try {
    const org = new Org(alpha.id);
    const result = await docs.uploadLoadDocument(
      org, alphaLoad, "pod",
      { name: "signed-pod.pdf", type: "application/pdf", size: 9, buffer: Buffer.from("pdf-bytes") },
      alpha.ownerId,
    );
    assert.equal(result.ok, true);

    const [row] = docs.listLoadDocuments(org, alphaLoad);
    assert.equal(row!.kind, "pod");
    assert.equal(row!.filename, "signed-pod.pdf");
    assert.equal(row!.size_bytes, 9);
    assert.ok(row!.uploaded_by_name.length > 0, "the uploader's name is joined in");

    const fetched = docs.getLoadDocument(org, row!.id);
    assert.equal(fetched!.storage_key, row!.storage_key);
  } finally {
    delete process.env.DOCUMENTS_S3_URL;
    server.close();
  }
});

test("one tenant cannot fetch another tenant's document by id", async () => {
  const { Org } = await import("../src/lib/tenant-db.ts");
  const { server, port } = await fakeS3();
  process.env.DOCUMENTS_S3_URL = `http://KEY:SECRET@127.0.0.1:${port}/docs`;
  try {
    const alphaOrg = new Org(alpha.id);
    const betaOrg = new Org(beta.id);
    const result = await docs.uploadLoadDocument(
      alphaOrg, alphaLoad, "bol",
      { name: "bol.pdf", type: "application/pdf", size: 3, buffer: Buffer.from("bol") },
      alpha.ownerId,
    );
    assert.equal(result.ok, true);
    const id = (result as { ok: true; id: number }).id;

    assert.equal(docs.getLoadDocument(betaOrg, id), undefined);
    assert.equal(docs.listLoadDocuments(betaOrg, alphaLoad).length, 0);
  } finally {
    delete process.env.DOCUMENTS_S3_URL;
    server.close();
  }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --test-name-pattern="document kind|content type|size limit|another tenant|not configured|round-trip|cannot fetch"`

Expected: FAIL — `Cannot find module '../src/lib/documents.ts'`.

- [ ] **Step 3: Implement `documents.ts`**

Create `src/lib/documents.ts`:

```ts
import "server-only";
import { randomUUID } from "node:crypto";
import { all, get, run } from "./db.ts";
import type { Org } from "./tenant-db.ts";
import { destination, putObject } from "./s3.ts";
import { DOCUMENT_ALLOWED_TYPES, DOCUMENT_KIND, DOCUMENT_MAX_BYTES, type DocumentKind } from "./constants.ts";

export type DocumentRow = {
  id: number;
  organization_id: number;
  load_id: number;
  kind: DocumentKind;
  filename: string;
  storage_key: string;
  content_type: string;
  size_bytes: number;
  uploaded_by: number;
  uploaded_by_name: string;
  created_at: string;
};

export type Result = { ok: true; id: number } | { ok: false; error: string };

export function documentsConfigured(): boolean {
  return Boolean(process.env.DOCUMENTS_S3_URL);
}

const SELECT = `
  SELECT d.*, u.name AS uploaded_by_name
    FROM load_documents d
    JOIN users u ON u.organization_id = d.organization_id AND u.id = d.uploaded_by
`;

export function listLoadDocuments(org: Org, loadId: number): DocumentRow[] {
  return all<DocumentRow>(
    `${SELECT} WHERE d.organization_id = ? AND d.load_id = ? ORDER BY d.created_at DESC`,
    [org.id, loadId],
  );
}

/** Tenant-scoped single-row lookup by id — what the download route resolves against.
 *  Undefined for a missing id or one that belongs to another tenant; the route turns
 *  either into the same 404, so it never distinguishes "not found" from "not yours". */
export function getLoadDocument(org: Org, id: number): DocumentRow | undefined {
  return get<DocumentRow>(`${SELECT} WHERE d.organization_id = ? AND d.id = ?`, [org.id, id]);
}

export async function uploadLoadDocument(
  org: Org,
  loadId: number,
  kind: string,
  file: { name: string; type: string; size: number; buffer: Buffer },
  userId: number,
): Promise<Result> {
  if (!Object.values(DOCUMENT_KIND).includes(kind as DocumentKind)) {
    return { ok: false, error: "Unknown document kind." };
  }
  if (!get("SELECT 1 FROM loads WHERE organization_id = ? AND id = ?", [org.id, loadId])) {
    return { ok: false, error: "Unknown load." };
  }
  if (!(DOCUMENT_ALLOWED_TYPES as readonly string[]).includes(file.type)) {
    return { ok: false, error: "Only PDF, JPEG or PNG files are accepted." };
  }
  if (file.size > DOCUMENT_MAX_BYTES) {
    return { ok: false, error: "File is larger than 10MB." };
  }
  if (!documentsConfigured()) {
    return { ok: false, error: "Document storage is not configured." };
  }

  // No filename in the key: the original name is never trusted for a path, and a
  // random key needs no collision check.
  const key = `${org.id}/loads/${loadId}/${randomUUID()}`;
  await putObject(destination(process.env.DOCUMENTS_S3_URL!), key, file.buffer);

  run(
    `INSERT INTO load_documents
       (organization_id, load_id, kind, filename, storage_key, content_type, size_bytes, uploaded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [org.id, loadId, kind, file.name.slice(0, 200), key, file.type, file.size, userId, new Date().toISOString()],
  );
  return { ok: true, id: get<{ id: number }>("SELECT last_insert_rowid() AS id")!.id };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`

Expected: all tests pass, including every one added in this task and Task 2.

- [ ] **Step 5: Commit**

```bash
git add src/lib/documents.ts tests/documents.test.ts
git commit -m "documents.ts: list/get/upload a load's documents, S3-backed"
```

---

### Task 4: `document-actions.ts` — the Server Action

**Files:**
- Create: `src/lib/document-actions.ts`

**Interfaces:**
- Consumes: `requireOrg` (`auth.ts`), `can` (`permissions.ts`), `uploadLoadDocument`
  (`documents.ts`, Task 3), `DocumentKind` (`constants.ts`, Task 1).
- Produces: `type DocumentState = { error?: string; ok?: string }`,
  `uploadDocumentAction(_prev: DocumentState, form: FormData): Promise<DocumentState>` —
  consumed by Task 6's `document-manager.tsx` via `useActionState`.

No test file: per AI Rules §8, `requireOrg()` needs request context `node --test` doesn't
have, which is exactly why the write logic lives in `documents.ts` (tested in Task 3) and
this file stays a thin wrapper. Verified by `tsc` and the browser check in Task 7 — same
reasoning `dispatch-admin-actions.ts` and `note-actions.ts` already rest on.

- [ ] **Step 1: Implement `document-actions.ts`**

Create `src/lib/document-actions.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { requireOrg } from "./auth.ts";
import { can } from "./permissions.ts";
import { uploadLoadDocument } from "./documents.ts";
import type { DocumentKind } from "./constants.ts";

export type DocumentState = { error?: string; ok?: string };

export async function uploadDocumentAction(_prev: DocumentState, form: FormData): Promise<DocumentState> {
  const { user, org } = await requireOrg();
  if (!can(user, "load:manage")) return { error: "Only dispatch can attach documents." };

  const loadId = Number(form.get("load_id"));
  if (!Number.isInteger(loadId) || loadId <= 0) return { error: "Unknown load." };

  const kind = String(form.get("kind") ?? "") as DocumentKind;
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a file." };

  const buffer = Buffer.from(await file.arrayBuffer());
  const result = await uploadLoadDocument(
    org, loadId, kind,
    { name: file.name, type: file.type, size: file.size, buffer },
    user.id,
  );
  if (!result.ok) return { error: result.error };
  revalidatePath(`/loads/${loadId}`);
  return { ok: "Document attached." };
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/document-actions.ts
git commit -m "document-actions.ts: the upload Server Action, re-checking load:manage"
```

---

### Task 5: Route Handler — `/api/documents/[id]`

**Files:**
- Create: `src/app/api/documents/[id]/route.ts`
- Modify: `tests/http/app.test.ts` (extend)

**Interfaces:**
- Consumes: `requireOrg` (`auth.ts`), `can` (`permissions.ts`), `getLoadDocument` /
  `documentsConfigured` (`documents.ts`, Task 3), `destination` / `getObject` (`s3.ts`,
  Task 2).

- [ ] **Step 1: Write the failing tests**

Open `tests/http/app.test.ts`. Add these two tests after the existing "the CSV exports
refuse an unauthenticated caller" test:

```ts
test("the document route refuses an unauthenticated caller", async () => {
  const res = await app.get("/api/documents/1");
  assert.equal(res.status, 307, "redirects rather than serving");
  assert.match(res.location ?? "", /\/login/);
});

test("one tenant cannot download another tenant's document", async () => {
  const now = new Date().toISOString();
  const { seedOrg, lookupId } = await import("../helpers.ts");
  const { Org } = await import("../../src/lib/tenant-db.ts");
  const owner = seedOrg(app.db, "Doc Owner Dispatch", "docowner@doctest.test");

  app.db.run(
    `INSERT INTO carriers (organization_id, legal_name, status_id, created_at, updated_at)
     VALUES (?, 'Doc Test Carrier', ?, ?, ?)`,
    [owner.id, lookupId(app.db, owner.id, "status", "active"), now, now],
  );
  const carrierId = app.db.get<{ id: number }>(
    "SELECT id FROM carriers WHERE organization_id = ?", [owner.id])!.id;
  const { createLoad } = await import("../../src/lib/load-write.ts");
  const loadResult = createLoad(new Org(owner.id), {
    carrierId, stops: [{ kind: "pickup", city: "Dallas" }, { kind: "delivery", city: "Newark" }],
  }, owner.ownerId) as { ok: true; id: number };

  app.db.run(
    `INSERT INTO load_documents
       (organization_id, load_id, kind, filename, storage_key, content_type, size_bytes, uploaded_by, created_at)
     VALUES (?, ?, 'pod', 'CONFIDENTIAL-POD.pdf', 'unused-key', 'application/pdf', 5, ?, ?)`,
    [owner.id, loadResult.id, owner.ownerId, now],
  );
  const documentId = app.db.get<{ id: number }>(
    "SELECT id FROM load_documents WHERE organization_id = ?", [owner.id])!.id;

  const res = await app.get(`/api/documents/${documentId}`, outsider);
  assert.equal(res.status, 404);
  assertNoVictimData(res.body, `/api/documents/${documentId}`);
  assert.ok(!res.body.includes("CONFIDENTIAL-POD"), "the filename never reaches an outsider either");
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:http`

Expected: the unauthenticated-caller test FAILS — with no route yet, `/api/documents/1`
404s via Next's default not-found rather than the 307-to-`/login` the test expects, so the
status/location assertions don't match. The tenant-isolation test **passes vacuously** —
a nonexistent route already 404s everyone, which happens to be the status this test wants.
That's expected and fine for a denial-shaped test; Step 4 is what proves it passes for the
right reason (the route's own tenant-scoped lookup) rather than by accident.

- [ ] **Step 3: Implement the route**

Create `src/app/api/documents/[id]/route.ts`:

```ts
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { documentsConfigured, getLoadDocument } from "@/lib/documents";
import { destination, getObject } from "@/lib/s3";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, org } = await requireOrg();
  if (!can(user, "load:view")) return new Response(null, { status: 404 });

  const id = Number((await params).id);
  if (!Number.isInteger(id)) return new Response(null, { status: 404 });

  const doc = getLoadDocument(org, id);
  if (!doc || !documentsConfigured()) return new Response(null, { status: 404 });

  const upstream = await getObject(destination(process.env.DOCUMENTS_S3_URL!), doc.storage_key);
  return new Response(upstream.body, {
    headers: {
      "content-type": doc.content_type,
      // Forces a download rather than an inline render — same-origin uploaded content is
      // not something the app should ever let a browser execute or render as HTML/SVG.
      // The global `nosniff` header (security-headers.ts) covers the rest.
      "content-disposition": `attachment; filename="${doc.filename.replace(/"/g, "")}"`,
    },
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test:http`

Expected: PASS, both new tests, and the whole suite (this rebuilds the app first).

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/documents/[id]/route.ts" tests/http/app.test.ts
git commit -m "Add /api/documents/[id]: streamed, tenant-scoped, load:view-gated download"
```

---

### Task 6: UI — the Documents card on `/loads/[id]`

**Files:**
- Modify: `src/lib/format.ts` (add `formatBytes`)
- Create: `src/components/document-manager.tsx`
- Modify: `src/app/(app)/loads/[id]/page.tsx`

**Interfaces:**
- Consumes: `DocumentRow` / `listLoadDocuments` / `documentsConfigured` (`documents.ts`, Task 3),
  `uploadDocumentAction` / `DocumentState` (`document-actions.ts`, Task 4),
  `DOCUMENT_KIND_LABELS` / `DOCUMENT_KIND_TONE` (`constants.ts`, Task 1), `Badge` /
  `Banner` / `EmptyState` (`ui.tsx`).
- Produces: `formatBytes(n: number): string` in `format.ts`, and the `DocumentManager`
  component (`{ loadId: number; documents: DocumentRow[]; canUpload: boolean }`).

No dedicated test file: `format.ts`'s existing helpers (`formatDate`, `formatMoney`,
`pluralize`) have none either — this matches that established precedent for small, pure
display formatters. Verified by `tsc`, `npm run build`, and the browser check in Task 7.

- [ ] **Step 1: Add `formatBytes`**

In `src/lib/format.ts`, add after `pluralize` (the file's last export):

```ts
/** "240 KB" / "2.4 MB" — a file size is always shown human-scaled, never raw bytes. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
```

- [ ] **Step 2: Create `document-manager.tsx`**

Create `src/components/document-manager.tsx`:

```tsx
"use client";

import { useActionState } from "react";
import { uploadDocumentAction, type DocumentState } from "@/lib/document-actions";
import type { DocumentRow } from "@/lib/documents";
import { DOCUMENT_KIND_LABELS, DOCUMENT_KIND_TONE } from "@/lib/constants";
import { formatBytes, formatDateTime } from "@/lib/format";
import { Badge, Banner, EmptyState } from "./ui";

export function DocumentManager({
  loadId,
  documents,
  canUpload,
}: {
  loadId: number;
  documents: DocumentRow[];
  canUpload: boolean;
}) {
  const [state, action, pending] = useActionState<DocumentState, FormData>(uploadDocumentAction, {});

  return (
    <div className="space-y-4">
      {documents.length === 0 ? (
        <EmptyState
          title="No documents yet"
          description="Rate confirmations, bills of lading and proofs of delivery attach here."
        />
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-line bg-ink-50/70">
                {["Kind", "File", "Uploaded by", "Date", ""].map((h) => (
                  <th key={h} scope="col" className="px-4 py-2.5 text-left text-xs font-semibold text-ink-600">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {documents.map((d) => (
                <tr key={d.id} className="border-b border-line/70 last:border-0">
                  <td className="px-4 py-2.5">
                    <Badge tone={DOCUMENT_KIND_TONE[d.kind]}>{DOCUMENT_KIND_LABELS[d.kind]}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-ink-900">
                    {d.filename}
                    <span className="ml-1.5 text-xs text-ink-400">{formatBytes(d.size_bytes)}</span>
                  </td>
                  <td className="px-4 py-2.5 text-ink-600">{d.uploaded_by_name}</td>
                  <td className="px-4 py-2.5 text-ink-600">{formatDateTime(d.created_at)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <a
                      href={`/api/documents/${d.id}`}
                      className="text-sm font-medium text-brand-700 hover:underline"
                    >
                      Download
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canUpload && (
        <div className="space-y-3 border-t border-line pt-4">
          <Banner state={state} />
          <form action={action} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="load_id" value={loadId} />
            <div>
              <label className="label" htmlFor="kind">Kind</label>
              <select id="kind" name="kind" defaultValue="rate_confirmation" className="field" required>
                {Object.entries(DOCUMENT_KIND_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
            <div className="min-w-[12rem] flex-1">
              <label className="label" htmlFor="file">File</label>
              <input
                id="file" name="file" type="file"
                accept="application/pdf,image/jpeg,image/png"
                required className="field"
              />
            </div>
            <button
              type="submit"
              disabled={pending}
              className="rounded-lg bg-brand-600 px-3.5 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
            >
              {pending ? "Uploading…" : "Attach"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Wire it into the load detail page**

In `src/app/(app)/loads/[id]/page.tsx`:

Add to the imports:

```ts
import { documentsConfigured, listLoadDocuments } from "@/lib/documents";
import { DocumentManager } from "@/components/document-manager";
```

Add after `const options = loadFormOptions(org);`:

```ts
const documents = listLoadDocuments(org, id);
// Global Constraint: no upload UI at all when DOCUMENTS_S3_URL is unset — not a
// disabled/dead button, the form simply isn't in the tree.
const canUploadDocuments = mayManage && documentsConfigured();
```

Add a new `Card` right after the two-column `<div className="grid gap-5 lg:grid-cols-3">
... </div>` closes, before the closing `</>`:

```tsx
      <Card className="mt-5">
        <CardHeader
          title="Documents"
          subtitle="Rate confirmations, bills of lading, proofs of delivery — attached here, never removed."
        />
        <DocumentManager loadId={load.id} documents={documents} canUpload={canUploadDocuments} />
      </Card>
```

- [ ] **Step 4: Verify it compiles and builds**

Run: `npx next typegen && npx tsc --noEmit && npm run build`

Expected: clean typecheck, clean build. (`next typegen` only needed if a fresh `.next` was
removed since the last build — see the gotcha already noted in `HANDOFF.md`.)

- [ ] **Step 5: Run the full test suite**

Run: `npm test`

Expected: all tests still pass (this task touches no tested logic, only UI — a regression
here would mean a typo broke an import elsewhere).

- [ ] **Step 6: Commit**

```bash
git add src/lib/format.ts src/components/document-manager.tsx "src/app/(app)/loads/[id]/page.tsx"
git commit -m "Add the Documents card to the load detail page"
```

---

### Task 7: Browser verification, end to end

**Files:** none (no source changes — this is a manual/scripted verification pass, same
shape as the driver/broker screens' verification earlier this session)

Per this project's own standing instruction: UI changes get driven in a real browser
before being called done, not just typechecked and unit-tested. `DOCUMENTS_S3_URL` needs
something real (or real-shaped) to point at, so this task stands up a throwaway local
stand-in for S3, seeds a demo org, and drives the full flow — then separately confirms the
"not configured" path with the env var unset.

- [ ] **Step 1: Write a throwaway local S3 stand-in**

```bash
SCRATCH=$(mktemp -d)
echo "$SCRATCH"   # note this path, it's used through the rest of this task
```

Create a scratch file (NOT committed — this is a manual-verification tool, not part of the
app) at `$SCRATCH/fake-s3.mjs`:

```js
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = process.argv[2] ?? "./fake-s3-store";
mkdirSync(ROOT, { recursive: true });

const server = createServer((req, res) => {
  const file = path.join(ROOT, encodeURIComponent(req.url ?? ""));
  if (req.method === "PUT") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      writeFileSync(file, Buffer.concat(chunks));
      res.writeHead(200).end();
    });
  } else if (req.method === "GET") {
    if (!existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200).end(readFileSync(file));
  } else {
    res.writeHead(405).end();
  }
});
server.listen(9911, "127.0.0.1", () => console.log("fake-s3 on http://127.0.0.1:9911"));
```

Run it in the background: `node "$SCRATCH/fake-s3.mjs" "$SCRATCH/fake-s3-store" &`

- [ ] **Step 2: Seed a fresh demo org and start the dev server**

```bash
rm -f data/documents-verify.db*
CARRIER_DB_PATH=data/documents-verify.db npm run seed:demo
CARRIER_DB_PATH=data/documents-verify.db DOCUMENTS_S3_URL="http://KEY:SECRET@127.0.0.1:9911/docs" \
  npx next dev -p 3000 &
```

Poll `http://localhost:3000/login` until it responds before proceeding (see this session's
earlier precedent — don't `sleep`, poll the port).

**If port 3000 is already in use by another `next dev`, stop first and ask before killing
it** — same rule this session already followed once for the drivers/brokers verification.

- [ ] **Step 3: Drive it**

Using Playwright (or `chromium-cli` if available — see the `run` skill), as marcus@demo.local / demo1234 (dispatcher):

1. Navigate to `/loads`, open any load (or create one if the seed has none with a driver).
2. On the load detail page, confirm a "Documents" card renders with "No documents yet" and
   an upload form (Kind select + file input + Attach button).
3. Attach a small real PDF or PNG as a "Rate Confirmation" — submit, confirm "Document
   attached." banner and the row appears in the table with the right kind badge, filename,
   uploader name, and a human-scaled size (e.g. "12 KB").
4. Click "Download" — confirm the browser downloads the file (not renders it inline), and
   the downloaded bytes match what was uploaded.
5. Attach a second document of kind "Proof of Delivery" — confirm both rows now show,
   newest first.
6. Sign in as an `account_manager` demo user (renee@demo.local / demo1234) on the same
   load: confirm the document list still renders (they can see it) but no upload form is
   present (they lack `load:manage`).
7. Check the browser console for errors after each step.

- [ ] **Step 4: Confirm the "not configured" path**

Stop the dev server. Restart it the same way but **without** `DOCUMENTS_S3_URL`:

```bash
CARRIER_DB_PATH=data/documents-verify.db npx next dev -p 3000 &
```

As the dispatcher, open the same load: confirm the existing documents still list (metadata
is in SQLite, independent of S3 config) but the upload form is gone entirely — no dead
button, per the spec's non-goal.

- [ ] **Step 5: Clean up**

```bash
lsof -ti:3000 -sTCP:LISTEN | xargs -r kill
rm -f data/documents-verify.db*
```

Kill the fake-S3 process (`kill %<job>` or find its PID).

- [ ] **Step 6: No commit** (nothing changed) — report the result instead: what was
  verified, any screenshots, and any console/network errors found. If something broke,
  fix it under whichever Task actually owns the broken file, add/adjust that task's test,
  and re-run this task from Step 2.

---

### Task 8: Docs — close out the phase

**Files:**
- Modify: `HANDOFF.md`
- Modify: `Plan.md`
- Modify: `DEPLOY.md`

Per AI Rules §10: "Finishing a phase means updating `Plan.md` in the same change."

- [ ] **Step 1: Update `Plan.md`**

In the "Phase 15 — Asterism dispatch domain" section (added this session), change:

```
- [ ] Documents (RC/BOL/POD) — blocked on a file-storage decision (Carrier Hub has none
      today, only S3 signing for backups)
```

to:

```
- [x] Documents (RC/BOL/POD, plus an "Other" catch-all) — migration 16, S3-backed via
      `DOCUMENTS_S3_URL` (separate bucket/credentials from `BACKUP_S3_URL`), append-only,
      load-scoped. Design in `docs/superpowers/specs/2026-09-02-load-documents-design.md`.
```

And update the phase's `🔨` to reflect only invoicing remains, if that's still true at the
time this task runs — check `git log`/`HANDOFF.md` first in case invoicing landed in the
meantime.

- [ ] **Step 2: Update `HANDOFF.md`**

Update the "Still needed from the client" section and the dispatch domain summary to
reflect that documents are done, listing the new files (`documents.ts`,
`document-actions.ts`, `src/app/api/documents/[id]/route.ts`, `document-manager.tsx`,
migration 16) the way the drivers/brokers work was documented after that step landed.

- [ ] **Step 3: Note `DOCUMENTS_S3_URL` in `DEPLOY.md`**

Add it next to wherever `BACKUP_S3_URL` is documented, marked optional, same
`https://KEY:SECRET@endpoint/bucket` shape.

- [ ] **Step 4: Final full verification**

```bash
npm test && npx tsc --noEmit && npm run build && npm run test:http
```

Expected: everything green.

- [ ] **Step 5: Commit**

```bash
git add HANDOFF.md Plan.md DEPLOY.md
git commit -m "Docs: load documents shipped — update Plan.md, HANDOFF.md, DEPLOY.md"
```

---

## Self-Review Notes

- **Spec coverage:** every section of the design spec maps to a task — schema (Task 1),
  `getObject` (Task 2), `documents.ts` (Task 3), the Server Action (Task 4), the Route
  Handler (Task 5), the UI (Task 6), rollout/`DOCUMENTS_S3_URL` documentation (Task 8).
  The spec's non-goals (no delete, no per-stop scoping, no carrier attachments, no audit
  log entries, no configurable allow-list) have no corresponding task by design — confirmed
  absent from every task above.
- **Type consistency:** `DocumentRow`, `DocumentKind`, `Result`/`DocumentState` names and
  shapes are identical everywhere they're referenced across Tasks 3–6.
- **No placeholders:** every step above has runnable code, not a description of code.
