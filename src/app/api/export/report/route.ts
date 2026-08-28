import { requireUser } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { parseReportKey, reportToCsvRows, runReport } from "@/lib/reports";
import { csvResponse, stamp } from "@/lib/export";
import { toCsv } from "@/lib/csv";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(request: Request) {
  const user = await requireUser();
  if (!can(user, "export:run")) return new Response("Not authorized", { status: 403 });

  const url = new URL(request.url);
  const key = parseReportKey(url.searchParams.get("r"));
  const clean = (v: string | null) => (v && ISO.test(v) ? v : undefined);

  const result = runReport(key, {
    from: clean(url.searchParams.get("from")),
    to: clean(url.searchParams.get("to")),
  });

  return csvResponse(toCsv(reportToCsvRows(result)), `${key}-${stamp()}.csv`);
}
