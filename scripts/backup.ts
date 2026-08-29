/**
 * Takes a verified backup and, where `BACKUP_S3_URL` is set, copies it off the machine.
 *
 *   npm run backup                       → data/backups/…
 *   BACKUP_DIR=/mnt/vol npm run backup   → somewhere else
 *   BACKUP_KEEP=30 npm run backup        → keep the newest 30
 *
 * The work is in `src/lib/backup.ts` so the scheduler in `src/instrumentation.ts` runs
 * exactly the same code as this does.
 */
import { describe, runBackup } from "../src/lib/backup.ts";

const result = await runBackup();
console.log(describe(result));
// A backup that never left the machine is not a backup of that machine, so say so with an
// exit code as well as a sentence — a cron job that only prints is a cron job nobody reads.
if (result.uploadError) process.exit(1);
