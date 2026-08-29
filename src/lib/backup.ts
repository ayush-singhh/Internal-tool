import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { destination, putObject } from "./s3.ts";

/**
 * Taking a backup, checking it, and getting a copy off the machine.
 *
 * `VACUUM INTO` is safe against a database being written to right now: SQLite takes a
 * consistent snapshot rather than copying bytes underneath a live writer. Copying the
 * file with `cp` while the app runs can capture a torn page, which is the classic way to
 * discover your backups were never valid.
 *
 * Every copy is **reopened and read** before it is accepted — integrity-checked, row
 * counted, schema version read — because a backup that has not been opened is a hope.
 *
 * And a copy on the same disk as the database is not a backup of that disk. Losing the
 * volume would take the database and every backup of it in the same instant, so the
 * upload is the part that matters; `BACKUP_S3_URL` is what turns it on.
 */
export type BackupResult = {
  path: string;
  bytes: number;
  schemaVersion: number;
  counts: Record<string, number>;
  kept: number;
  removed: number;
  uploadedTo: string | null;
  uploadError: string | null;
};

const COUNTED = ["carriers", "users", "carrier_activity", "carrier_notes"] as const;

export function sourcePath(): string {
  return process.env.CARRIER_DB_PATH ?? path.join(process.cwd(), "data", "carrier-hub.db");
}
export function backupDir(): string {
  return process.env.BACKUP_DIR ?? path.join(process.cwd(), "data", "backups");
}

/** Reads a database file and reports whether it is whole. Used on a fresh backup and,
 *  by `scripts/restore.ts`, on one about to be put back. */
export function verify(file: string): { schemaVersion: number; counts: Record<string, number> } {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
    if (integrity.integrity_check !== "ok") {
      throw new Error(`Failed its integrity check: ${integrity.integrity_check}`);
    }
    const counts: Record<string, number> = {};
    for (const table of COUNTED) {
      counts[table] = (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    }
    const version = (
      db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null }
    ).v;
    if (version === null) throw new Error("No migration ledger — this is not one of our databases.");
    return { schemaVersion: version, counts };
  } finally {
    db.close();
  }
}

/**
 * A name no existing backup has. `VACUUM INTO` refuses to overwrite, and the natural
 * moment to take two backups close together is right after one failed to upload — which
 * used to fail with a raw SQLite error at exactly the wrong time.
 */
function nextFreeName(dir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  let target = path.join(dir, `carrier-hub-${stamp}.db`);
  for (let n = 2; existsSync(target); n++) {
    target = path.join(dir, `carrier-hub-${stamp}-${n}.db`);
  }
  return target;
}

export async function runBackup(): Promise<BackupResult> {
  const source = sourcePath();
  const dir = backupDir();
  const keep = Number(process.env.BACKUP_KEEP ?? 14);
  mkdirSync(dir, { recursive: true });
  const target = nextFreeName(dir);
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }

  const { schemaVersion, counts } = verify(target);
  const bytes = statSync(target).size;

  // Off the machine, if somewhere has been named. Verified first: uploading a copy that
  // has not been opened would just move the hope somewhere else.
  let uploadedTo: string | null = null;
  let uploadError: string | null = null;
  if (process.env.BACKUP_S3_URL) {
    try {
      uploadedTo = await putObject(
        destination(process.env.BACKUP_S3_URL),
        path.basename(target),
        readFileSync(target),
      );
    } catch (error) {
      // Never throws: a failed upload must not also cost you the local copy or stop the
      // schedule. The caller reports it, loudly.
      uploadError = (error as Error).message;
    }
  }

  const existing = readdirSync(dir)
    .filter((f) => f.startsWith("carrier-hub-") && f.endsWith(".db"))
    .sort()
    .reverse();
  const stale = existing.slice(keep);
  for (const file of stale) unlinkSync(path.join(dir, file));

  return {
    path: target,
    bytes,
    schemaVersion,
    counts,
    kept: Math.min(existing.length, keep),
    removed: stale.length,
    uploadedTo,
    uploadError,
  };
}

export function describe(result: BackupResult): string {
  const counts = Object.entries(result.counts).map(([t, n]) => `${t}=${n}`).join(", ");
  const lines = [
    `Backup written: ${result.path}`,
    `  ${(result.bytes / 1024).toFixed(0)} KB · schema v${result.schemaVersion} · verified: ${counts}`,
    `  keeping ${result.kept} backup(s)${result.removed ? `, removed ${result.removed} older` : ""}`,
  ];
  if (result.uploadedTo) lines.push(`  copied off the machine: ${result.uploadedTo}`);
  else if (result.uploadError) lines.push(`  UPLOAD FAILED — this copy is only on this disk: ${result.uploadError}`);
  else lines.push("  NOT copied off the machine: BACKUP_S3_URL is not set");
  return lines.join("\n");
}
