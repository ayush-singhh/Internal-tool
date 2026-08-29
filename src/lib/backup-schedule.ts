/**
 * The backup schedule.
 *
 * A timer in this process rather than a cron daemon or a second machine: the database is
 * one file on one disk attached to one machine, so the process that has it is the only
 * thing that can copy it, and there is nothing here for a scheduler to coordinate.
 *
 * `BACKUP_S3_URL` is what makes it worth running — a copy on the same disk as the
 * database does not survive losing that disk. Without it this still runs, and says
 * plainly in the logs that the copy went nowhere.
 */
export function scheduleBackups(): void {
  const hours = Number(process.env.BACKUP_EVERY_HOURS ?? 24);
  if (!Number.isFinite(hours) || hours <= 0) return;

  const run = async () => {
    try {
      const { describe, runBackup } = await import("./backup.ts");
      const result = await runBackup();
      console.log(describe(result));
    } catch (error) {
      // A failed backup must never take the server down with it. It has to be loud,
      // though: silence is how a backup schedule turns out to have stopped months ago.
      console.error("SCHEDULED BACKUP FAILED:", (error as Error).message);
    }
  };

  // Not on boot: a restart loop would otherwise fill the disk with snapshots. The first
  // one is a full interval away.
  const timer = setInterval(() => void run(), hours * 3_600_000);
  // Never hold the process open for the sake of a timer.
  timer.unref();
  console.log(`Backups scheduled every ${hours}h → ${
    process.env.BACKUP_S3_URL ? "local disk and off-machine storage" : "LOCAL DISK ONLY (set BACKUP_S3_URL)"
  }`);
}
