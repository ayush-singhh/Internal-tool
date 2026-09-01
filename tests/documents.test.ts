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
