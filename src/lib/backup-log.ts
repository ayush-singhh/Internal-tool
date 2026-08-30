import { all, get, run, systemQuery } from "./db.ts";

/**
 * What happened the last time a backup ran.
 *
 * Deliberately **not** `import "server-only"`: `scripts/backup.ts` runs under plain
 * `node`, without the `react-server` condition, so anything it reaches through
 * `backup.ts` has to resolve there too. `db.ts` is likewise free of it.
 *
 * Recording never throws, for the same reason `audit.record()` and `recordError()` don't.
 * Losing the note is bad; failing the backup because the note could not be written is
 * worse, and this exists precisely to make a working backup visible.
 */
export type BackupStatus =
  /** Written, verified, and copied off the machine. The only fully good outcome. */
  | "offsite"
  /** Written and verified, kept only on this disk — no `BACKUP_S3_URL` is configured. */
  | "local"
  /** Written and verified, but the upload was refused. The quiet failure this table exists for. */
  | "degraded"
  /** No usable backup was produced at all. */
  | "failed";

export type BackupEntry = {
  id: number;
  status: BackupStatus;
  detail: string;
  bytes: number | null;
  created_at: string;
};

export function recordBackup(entry: {
  status: BackupStatus;
  detail: string;
  bytes?: number | null;
}): void {
  try {
    systemQuery(() =>
      run(
        "INSERT INTO backup_log (status, detail, bytes, created_at) VALUES (?, ?, ?, ?)",
        [entry.status, entry.detail.slice(0, 2000), entry.bytes ?? null, new Date().toISOString()],
      ),
    );
  } catch {
    // Deliberately swallowed — see the module comment.
  }
}

export function recentBackups(limit = 10): BackupEntry[] {
  return systemQuery(() =>
    all<BackupEntry>(
      "SELECT * FROM backup_log ORDER BY created_at DESC, id DESC LIMIT ?",
      [limit],
    ),
  );
}

/**
 * The most recent run that actually put a copy somewhere safe. Answering "how far back
 * would a restore take us" needs this one, not merely the last attempt — a week of
 * `degraded` nights still leaves the newest usable copy seven days old.
 */
export function lastGoodBackup(): BackupEntry | undefined {
  return systemQuery(() =>
    get<BackupEntry>(
      "SELECT * FROM backup_log WHERE status = 'offsite' ORDER BY created_at DESC, id DESC LIMIT 1",
    ),
  );
}
