import "server-only";
import { all, run, systemQuery } from "./db.ts";

/**
 * Server errors caught by `onRequestError` (see `instrumentation.ts`), so a customer
 * hitting a 500 is visible from here instead of invisible. Genuinely global, like
 * `sessions` or `support_access_log` — a request can fail before any organisation is
 * resolved, so there is nothing to scope this by.
 *
 * Recording never throws, for the same reason `audit.record()` doesn't: an error report
 * that took down the request it was describing would be a worse failure than the one it
 * set out to document.
 */
export function recordError(entry: {
  message: string;
  digest?: string | null;
  path?: string | null;
  method?: string | null;
  routeType?: string | null;
}): void {
  try {
    systemQuery(() =>
      run(
        `INSERT INTO error_log (message, digest, path, method, route_type, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          entry.message.slice(0, 500),
          entry.digest?.slice(0, 100) ?? null,
          entry.path?.slice(0, 200) ?? null,
          entry.method?.slice(0, 16) ?? null,
          entry.routeType?.slice(0, 32) ?? null,
          new Date().toISOString(),
        ],
      ),
    );
  } catch {
    // Deliberately swallowed — see the module comment.
  }
}

export type ErrorEntry = {
  id: number;
  message: string;
  digest: string | null;
  path: string | null;
  method: string | null;
  route_type: string | null;
  created_at: string;
};

export function recentErrors(limit = 100): ErrorEntry[] {
  return systemQuery(() =>
    all<ErrorEntry>("SELECT * FROM error_log ORDER BY created_at DESC, id DESC LIMIT ?", [limit]),
  );
}
