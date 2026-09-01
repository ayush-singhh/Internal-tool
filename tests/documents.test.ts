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
