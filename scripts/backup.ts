/**
 * Backs up the live database and verifies the copy can actually be read.
 *
 *   npm run backup                       → data/backups/…
 *   BACKUP_DIR=/mnt/vol npm run backup   → somewhere else
 *   BACKUP_KEEP=30 npm run backup        → keep the newest 30
 *
 * Uses `VACUUM INTO`, which is safe against a database being written to right now:
 * SQLite takes a consistent snapshot rather than copying bytes underneath a live
 * writer. Copying the file with `cp` while the app is running can capture a torn
 * page, which is the classic way to discover your backups were never valid.
 *
 * Every backup is reopened and counted before it is accepted, because a backup that
 * has not been restored is only a hope.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

const SOURCE = process.env.CARRIER_DB_PATH ?? path.join(process.cwd(), "data", "carrier-hub.db");
const DIR = process.env.BACKUP_DIR ?? path.join(process.cwd(), "data", "backups");
const KEEP = Number(process.env.BACKUP_KEEP ?? 14);

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
const target = path.join(DIR, `carrier-hub-${stamp}.db`);

mkdirSync(DIR, { recursive: true });

const source = new DatabaseSync(SOURCE, { readOnly: true });
source.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
source.close();

// Verify by reopening the copy and reading from it — not just checking the file exists.
const copy = new DatabaseSync(target, { readOnly: true });
const integrity = copy.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
if (integrity.integrity_check !== "ok") {
  throw new Error(`Backup failed its integrity check: ${integrity.integrity_check}`);
}
const counts = ["carriers", "users", "carrier_activity", "carrier_notes"].map((t) => {
  const { n } = copy.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number };
  return `${t}=${n}`;
});
const version = (
  copy.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number }
).v;
copy.close();

const size = (statSync(target).size / 1024).toFixed(0);
console.log(`Backup written: ${target}`);
console.log(`  ${size} KB · schema v${version} · verified: ${counts.join(", ")}`);

// Rotate, newest first.
const existing = readdirSync(DIR)
  .filter((f) => f.startsWith("carrier-hub-") && f.endsWith(".db"))
  .sort()
  .reverse();
const stale = existing.slice(KEEP);
for (const file of stale) unlinkSync(path.join(DIR, file));
console.log(
  `  keeping ${Math.min(existing.length, KEEP)} backup(s)` +
    (stale.length ? `, removed ${stale.length} older` : ""),
);
