import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { destination, putObject, signRequest } from "../src/lib/s3.ts";

const ROOT = path.join(tmpdir(), `carrier-hub-backup-${process.pid}`);
const DB = path.join(ROOT, "live.db");
const DIR = path.join(ROOT, "backups");
process.env.CARRIER_DB_PATH = DB;
process.env.BACKUP_DIR = DIR;

let backup: typeof import("../src/lib/backup.ts");
let db: typeof import("../src/lib/db.ts");

before(async () => {
  mkdirSync(ROOT, { recursive: true });
  db = await import("../src/lib/db.ts");
  db.get("SELECT 1"); // force the connection, so the file and schema exist
  backup = await import("../src/lib/backup.ts");
});

after(() => rmSync(ROOT, { recursive: true, force: true }));

// ── signing ──────────────────────────────────────────────────────────────────

const AWS_EXAMPLE = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  region: "us-east-1",
  service: "service",
};

test("signing matches AWS's own published test vector", () => {
  // aws-sig-v4-test-suite, "get-vanilla". If this ever fails, the signer is wrong —
  // which is otherwise only discoverable as a 403 from a provider at 3am.
  const headers = signRequest(
    "GET", new URL("https://example.amazonaws.com/"), Buffer.alloc(0),
    AWS_EXAMPLE, new Date("2015-08-30T12:36:00Z"),
  );
  assert.match(
    headers.Authorization!,
    /Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31$/,
  );
  assert.match(headers.Authorization!, /SignedHeaders=host;x-amz-date,/);
  assert.match(headers.Authorization!, /Credential=AKIDEXAMPLE\/20150830\/us-east-1\/service\/aws4_request/);
});

test("a different payload signs differently, so a body cannot be swapped in flight", () => {
  const sign = (body: string) =>
    signRequest("PUT", new URL("https://b.example.com/bucket/key"), Buffer.from(body),
      { ...AWS_EXAMPLE, service: "s3" }, new Date("2015-08-30T12:36:00Z"),
      { "x-amz-content-sha256": "unused-here-but-signed" }).Authorization;
  assert.notEqual(sign("one"), sign("two"));
});

test("credentials are read out of the URL and never left in it", () => {
  const dest = destination("https://KEY%2Bplus:sec%2Fret@account.r2.cloudflarestorage.com/backups");
  assert.equal(dest.credentials.accessKeyId, "KEY+plus");
  assert.equal(dest.credentials.secretAccessKey, "sec/ret", "percent-decoded, like SMTP_URL");
  assert.equal(dest.base.toString(), "https://account.r2.cloudflarestorage.com/backups");
  assert.ok(!dest.base.toString().includes("sec"), "the secret is not in the URL that gets used");
  assert.throws(() => destination("https://account.example.com/backups"), /needs credentials/);
});

// ── the upload ───────────────────────────────────────────────────────────────

type Caught = { method: string; url: string; headers: Record<string, string>; body: Buffer };

function fakeS3(status = 200): Promise<{ server: Server; port: number; caught: Caught[] }> {
  const caught: Caught[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        caught.push({
          method: req.method!, url: req.url!,
          headers: req.headers as Record<string, string>,
          body: Buffer.concat(chunks),
        });
        res.writeHead(status).end(status === 200 ? "" : "<Error>AccessDenied</Error>");
      });
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as { port: number }).port, caught }),
    );
  });
}

test("an object is PUT whole, signed, to bucket and key", async () => {
  const { server, port, caught } = await fakeS3();
  try {
    const dest = destination(`http://KEY:SECRET@127.0.0.1:${port}/backups`);
    await putObject(dest, "carrier-hub-2026-08-29T08-16.db", Buffer.from("sqlite bytes here"));
  } finally {
    server.close();
  }
  assert.equal(caught.length, 1);
  const [sent] = caught;
  assert.equal(sent!.method, "PUT");
  assert.equal(sent!.url, "/backups/carrier-hub-2026-08-29T08-16.db");
  assert.equal(sent!.body.toString(), "sqlite bytes here", "the file arrives whole");
  assert.match(sent!.headers.authorization!, /^AWS4-HMAC-SHA256 Credential=KEY\//);
  assert.ok(sent!.headers["x-amz-content-sha256"], "S3 requires the payload hash as a header");
  assert.ok(!JSON.stringify(sent!.headers).includes("SECRET"), "the secret never goes over the wire");
});

test("a refused upload says what the provider said", async () => {
  const { server, port } = await fakeS3(403);
  try {
    const dest = destination(`http://KEY:SECRET@127.0.0.1:${port}/backups`);
    await assert.rejects(() => putObject(dest, "x.db", Buffer.from("x")), /403[\s\S]*AccessDenied/);
  } finally {
    server.close();
  }
});

// ── taking one, and putting it back ──────────────────────────────────────────

test("a backup is written, verified by being reopened, and reports what is in it", async () => {
  const result = await backup.runBackup();
  assert.ok(result.bytes > 0);
  assert.ok(result.schemaVersion >= 9, "the ledger is read out of the copy, not assumed");
  assert.ok("carriers" in result.counts, "rows are counted in the copy");
  assert.equal(result.uploadedTo, null);
  assert.equal(result.uploadError, null);
  assert.match(backup.describe(result), /NOT copied off the machine/,
    "silence about that would be the dangerous part");
});

test("verify refuses a file that is not one of our databases", () => {
  const junk = path.join(ROOT, "junk.db");
  writeFileSync(junk, "this is not a database");
  assert.throws(() => backup.verify(junk));
});

test("a failed upload is reported but never costs you the local copy", async () => {
  const { server, port } = await fakeS3(403);
  process.env.BACKUP_S3_URL = `http://KEY:SECRET@127.0.0.1:${port}/backups`;
  try {
    const result = await backup.runBackup();
    assert.ok(result.uploadError, "the failure is surfaced");
    assert.match(result.uploadError!, /403/);
    assert.ok(result.bytes > 0, "and the backup itself still happened");
    assert.match(backup.describe(result), /UPLOAD FAILED/);
  } finally {
    delete process.env.BACKUP_S3_URL;
    server.close();
  }
});

test("a backup is uploaded once it is known to be whole", async () => {
  const { server, port, caught } = await fakeS3();
  process.env.BACKUP_S3_URL = `http://KEY:SECRET@127.0.0.1:${port}/backups`;
  try {
    const result = await backup.runBackup();
    assert.ok(result.uploadedTo, "reported as off the machine");
    assert.equal(caught.length, 1);
    assert.match(caught[0]!.url, /^\/backups\/carrier-hub-/);
    assert.equal(caught[0]!.body.byteLength, result.bytes, "the whole file, not a truncated one");
  } finally {
    delete process.env.BACKUP_S3_URL;
    server.close();
  }
});

test("two backups in the same minute do not collide", async () => {
  // VACUUM INTO refuses to overwrite, and the natural moment to take two in quick
  // succession is right after one failed to upload.
  const first = await backup.runBackup();
  const second = await backup.runBackup();
  assert.notEqual(first.path, second.path);
  assert.ok(second.bytes > 0);
});

test("old backups are rotated away, newest kept", async () => {
  process.env.BACKUP_KEEP = "2";
  try {
    for (const name of ["carrier-hub-2020-01-01T00-00.db", "carrier-hub-2020-01-02T00-00.db"]) {
      writeFileSync(path.join(DIR, name), "old");
    }
    const result = await backup.runBackup();
    const left = readdirSync(DIR).filter((f) => f.endsWith(".db")).sort();
    assert.equal(result.kept, 2);
    assert.equal(left.length, 2);
    assert.ok(left.includes(path.basename(result.path)), "the newest survives");
    assert.ok(!left.includes("carrier-hub-2020-01-01T00-00.db"), "the oldest goes");
  } finally {
    delete process.env.BACKUP_KEEP;
  }
});
