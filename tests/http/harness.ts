/**
 * A real server, driven over HTTP.
 *
 * Every other test in this project calls a function in `src/lib` directly. That is the
 * right shape for query and validation logic, and it is blind to an entire class of bug:
 * anything that only exists once Next is composing layouts, pages, redirects and status
 * codes. The `/support` leak lived exactly there — 273 unit tests passed while every page
 * under `/support` served another tenant's carriers in the body of a 404, because no test
 * had ever looked at a response.
 *
 * So this builds the app, starts it, and reads what comes back over the wire.
 *
 * Kept out of `npm test` (which globs `tests/*.test.ts`) because it needs a build first —
 * `npm run test:http` does both. One server for the whole file: starting it is the
 * expensive part, and `node --test` gives each *file* its own process anyway.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

/** Ask the OS for a port nobody is using, rather than guessing one and racing. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

export type Response = {
  status: number;
  /** Where a 3xx points, without following it — a redirect is often the assertion. */
  location: string | null;
  body: string;
};

export type Harness = {
  /** GET, never following redirects: the status and the Location are the point. */
  get(path: string, cookie?: string): Promise<Response>;
  /** A live session cookie for an existing account, as signing in would leave behind. */
  session(email: string): string;
  db: typeof import("../../src/lib/db.ts");
  stop(): void;
};

export async function startApp(): Promise<Harness> {
  const dir = mkdtempSync(path.join(tmpdir(), "carrier-hub-http-"));
  const dbPath = path.join(dir, "http.db");

  // Set before importing db.ts, which binds the path at import time, and before the server
  // is spawned so both processes open the same file.
  process.env.CARRIER_DB_PATH = dbPath;
  // The parent migrates and seeds the bootstrap organisation first, so the server finds a
  // current schema and an organisation already there and writes nothing on boot. Two
  // processes racing to migrate the same file is a lock fight with no upside.
  const db = await import("../../src/lib/db.ts");
  db.get("SELECT 1");

  const port = await freePort();
  const child: ChildProcess = spawn(
    process.execPath,
    [path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port)],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: "production",
        CARRIER_DB_PATH: dbPath,
        // Keep the boot checks in instrumentation.ts quiet: signup stays shut, so no relay
        // is required, and the backup timer's first run is a full interval away regardless.
        SIGNUP_OPEN: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let log = "";
  child.stdout?.on("data", (c) => { log += c; });
  child.stderr?.on("data", (c) => { log += c; });

  const base = `http://127.0.0.1:${port}`;
  const get = async (p: string, cookie?: string): Promise<Response> => {
    const res = await fetch(`${base}${p}`, {
      redirect: "manual",
      headers: cookie ? { cookie: `ch_session=${cookie}` } : {},
    });
    return { status: res.status, location: res.headers.get("location"), body: await res.text() };
  };

  const stop = () => {
    child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  };

  // Ready when it serves a page, not when it prints one — the log line lands before the
  // first request can be handled.
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`next start exited with ${child.exitCode}:\n${log}`);
    }
    try {
      if ((await get("/login")).status === 200) break;
    } catch {
      // Not listening yet.
    }
    if (Date.now() > deadline) {
      stop();
      throw new Error(`next start never became ready on ${base}:\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  const session = (email: string): string => {
    const user = db.systemQuery(() =>
      db.get<{ id: number }>("SELECT id FROM users WHERE email = ?", [email]),
    );
    if (!user) throw new Error(`no user ${email} to open a session for`);
    const id = randomBytes(32).toString("hex");
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO sessions (id, user_id, created_at, expires_at, mfa_pending, last_seen_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
      [id, user.id, now, new Date(Date.now() + 86_400_000).toISOString(), now],
    );
    return id;
  };

  return { get, session, db, stop };
}
