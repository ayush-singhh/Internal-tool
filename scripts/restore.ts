/**
 * Puts a backup back, having first proved it is worth putting back.
 *
 *   node scripts/restore.ts data/backups/carrier-hub-2026-08-29T08-16.db
 *   CARRIER_DB_PATH=/data/carrier-hub.db node scripts/restore.ts <file>
 *
 * A backup nobody has restored is a hope, so this exists to be *rehearsed*, not only
 * used in an emergency. Stop the application first: it replaces the file the running
 * server has open.
 *
 * The database being replaced is moved aside rather than deleted, because the worst
 * moment to discover you restored the wrong snapshot is after the only copy of the right
 * one is gone.
 */
import { copyFileSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { verify, sourcePath } from "../src/lib/backup.ts";

const [file] = process.argv.slice(2);
if (!file) {
  console.error("Usage: node scripts/restore.ts <backup file>");
  process.exit(1);
}
if (!existsSync(file)) {
  console.error(`No such backup: ${file}`);
  process.exit(1);
}

const { schemaVersion, counts } = verify(file);
console.log(`Backup is whole: schema v${schemaVersion} · ${
  Object.entries(counts).map(([t, n]) => `${t}=${n}`).join(", ")
}`);

const target = sourcePath();
if (existsSync(target)) {
  const aside = `${target}.replaced-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16)}`;
  renameSync(target, aside);
  console.log(`Moved the current database aside: ${aside}`);
}
// The write-ahead log belongs to the database that was just moved; leaving it would let
// SQLite replay someone else's tail onto the restored file.
for (const suffix of ["-wal", "-shm"]) {
  if (existsSync(`${target}${suffix}`)) unlinkSync(`${target}${suffix}`);
}

copyFileSync(file, target);
const after = verify(target);
console.log(`Restored to ${target}: schema v${after.schemaVersion} · ${
  Object.entries(after.counts).map(([t, n]) => `${t}=${n}`).join(", ")
}`);
console.log("Start the application again.");
