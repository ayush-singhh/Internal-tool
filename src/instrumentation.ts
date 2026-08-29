/**
 * Runs once before this server accepts its first request. Next calls it, so a throw here
 * is a server that refuses to start rather than one that starts broken.
 *
 * A production deployment with no mail relay cannot send a confirmation link, so nobody
 * could ever finish signing up — and it would fail silently, one dropped mail at a time.
 * Better to not come up at all: the container healthcheck then reports it.
 */
export function register(): void {
  if (process.env.NODE_ENV !== "production") return;

  // register() is called in every runtime, and the proxy makes an Edge bundle exist.
  // Backups open files and a database, so the whole schedule lives behind this import
  // rather than in this file — otherwise it is bundled for a runtime that cannot run it.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    void import("./lib/backup-schedule.ts").then((m) => m.scheduleBackups());
  }

  const missing = ["SMTP_URL", "MAIL_FROM", "APP_URL"].filter((key) => !process.env[key]);
  if (missing.length > 0 && process.env.SIGNUP_OPEN === "1") {
    throw new Error(
      `SIGNUP_OPEN=1 needs ${missing.join(", ")} — signup mails cannot be sent without them.`,
    );
  }
  if (process.env.APP_URL && !/^https?:\/\//.test(process.env.APP_URL)) {
    throw new Error("APP_URL must be an absolute URL, e.g. https://hub.example.com");
  }
}

/**
 * Next calls this for an uncaught error in a Server Component, Route Handler or Server
 * Action, in every environment — a customer's 500 was otherwise invisible from here.
 *
 * Not gated to production: this is what makes the feature itself testable in dev, and an
 * empty `error_log` table costs nothing.
 *
 * Node-only: `error_log` needs `node:sqlite`, which does not exist on the Edge runtime the
 * proxy runs on. An error there still reaches the platform's own request logs; it just
 * does not get a row here.
 */
export async function onRequestError(
  error: unknown,
  request: { path: string; method: string },
  context: { routeType: string },
): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { recordError } = await import("./lib/errors.ts");
  const message = error instanceof Error ? error.message : String(error);
  const digest =
    typeof error === "object" && error !== null && "digest" in error
      ? String((error as { digest: unknown }).digest)
      : null;
  recordError({ message, digest, path: request.path, method: request.method, routeType: context.routeType });
}
