/**
 * Applies pending migrations and reports the result. Safe to run repeatedly, and safe
 * to run against a database that does not exist yet — it will be built from nothing.
 *
 *   npm run migrate
 *   CARRIER_DB_PATH=/data/carrier-hub.db npm run migrate
 *
 * Run this before starting a new version of the app when deploying.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { migrate, currentVersion, LATEST_VERSION, INDEXES } from "../src/lib/migrations.ts";

const DB_PATH =
  process.env.CARRIER_DB_PATH ?? path.join(process.cwd(), "data", "carrier-hub.db");
mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA busy_timeout = 5000");

const before = currentVersion(db);
const { applied, version } = migrate(db);
db.exec(INDEXES);
db.close();

console.log(`Database: ${DB_PATH}`);
if (applied.length === 0) {
  console.log(`  already at version ${version} (latest is ${LATEST_VERSION}) — nothing to do`);
} else {
  console.log(`  migrated ${before} → ${version}:`);
  for (const line of applied) console.log(`    ${line}`);
}
