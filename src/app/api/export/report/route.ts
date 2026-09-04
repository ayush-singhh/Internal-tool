import { AUDIT, record } from "@/lib/audit";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { EXPORT_RULE, checkBurst, recordBurst, retryInWords } from "@/lib/throttle";
import { mayRunReport, parseReportKey, reportToCsvRows, runReport } from "@/lib/reports";
import { csvResponse, stamp } from "@/lib/export";
import { toCsv } from "@/lib/csv";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const { user, org } = await requireOrg();
  if (!can(user, "export:run")) return new Response("Not authorized", { status: 403 });

  const url = new URL(request.url);
  const key = parseReportKey(url.searchParams.get("r"));
  // `export:run` says this person may take data out; it does not say *which* data. A
  // viewer holds it, and would otherwise have downloaded the dispatch-fee reports the
  // page will not show them. The page falls back to a permitted report; a direct CSV
  // request for one they may not run is refused rather than quietly substituted.
  if (!mayRunReport(user, key)) return new Response("Not authorized", { status: 403 });
  const clean = (v: string | null) => (v && ISO.test(v) ? v : undefined);
  const from = clean(url.searchParams.get("from"));
  const to = clean(url.searchParams.get("to"));

  // Limited and recorded on the same terms as the carrier export. These are counts rather
  // than the book itself, but a date range walked across the calendar reconstructs a good
  // deal of it — and "who took data out" has to have one answer, not one per route.
  // Counted under a key of its own so a morning of reports cannot spend the carrier
  // export's budget.
  const verdict = checkBurst(`report:${user.id}`, EXPORT_RULE);
  if (!verdict.allowed) {
    // describeLockout talks about sign-ins, which this is not.
    return new Response(`Too many exports in a row. Try again in ${retryInWords(verdict)}.`, {
      status: 429,
    });
  }
  recordBurst(`report:${user.id}`);

  const result = runReport(org, key, { from, to });

  record({
    organizationId: org.id, userId: user.id, actor: user.email, action: AUDIT.EXPORT_REPORT,
    detail: `${result.def.title}${from || to ? ` (${from ?? "any"} to ${to ?? "any"})` : ""}`,
  });

  return csvResponse(toCsv(reportToCsvRows(result)), `${key}-${stamp()}.csv`);
}
