/**
 * Every command-line entry point, checked for the one flag that makes it run at all.
 *
 * `src/lib` modules import `server-only`, which throws unless Node resolves exports with
 * `--conditions=react-server`. A script missing that flag does not misbehave subtly — it
 * dies on import, before doing anything.
 *
 * This has now happened twice: `npm run backup` (BUGS.md 2026-09-05) and `npm run restore`
 * (2026-09-24), both found by hand, months apart, in the two commands you reach for when
 * something has already gone wrong. The library was never broken either time; the *entry
 * point* was, and no test ran an entry point.
 *
 * So this checks the manifest rather than any one script. It costs nothing, and it fails
 * for the next one before a person has to discover it during an incident.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const manifest = JSON.parse(
  readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8"),
) as { scripts: Record<string, string> };

test("every script that runs a file under scripts/ resolves server-only", () => {
  const offenders = Object.entries(manifest.scripts)
    .filter(([, command]) => /(^|\s)node\s[^|]*scripts\//.test(command))
    .filter(([, command]) => !command.includes("--conditions=react-server"))
    .map(([name, command]) => `${name}: ${command}`);

  assert.deepEqual(
    offenders,
    [],
    "these die on `server-only` before they do anything — add --conditions=react-server",
  );
});

test("the test runners resolve server-only too", () => {
  // The same flag, for the same reason: a test importing any src/lib module needs it.
  for (const name of ["test", "test:http"]) {
    assert.match(
      manifest.scripts[name]!,
      /--conditions=react-server/,
      `${name} must resolve server-only`,
    );
  }
});
