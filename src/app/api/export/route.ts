import { AUDIT, record } from "@/lib/audit";
import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { EXPORT_RULE, checkBurst, recordBurst, retryInWords } from "@/lib/throttle";
import { listCarriers, type CarrierFilters } from "@/lib/carriers";
import { parseFilters, parseListOptions, type RawParams } from "@/lib/query";
import { carriersToCsv, csvResponse, stamp } from "@/lib/export";

/** Downloads live outside the (app) layout, so this route enforces auth itself. */
const GROUPS: Record<string, CarrierFilters["group"]> = {
  "/active": "active",
  "/onboarding": "onboarding",
  "/offboarded": "offboarded",
  "/investigations": "investigations",
};

// One spreadsheet, not a data pipeline — enough headroom for the whole book of carriers.
const MAX_ROWS = 50_000;

export async function GET(request: Request) {
  const { user, org } = await requireOrg();
  if (!can(user, "export:run")) {
    return new Response("Not authorized", { status: 403 });
  }

  const url = new URL(request.url);
  const params: RawParams = Object.fromEntries(url.searchParams.entries());
  const path = params.path as string | undefined;
  const filters = parseFilters(params, path ? GROUPS[path] : undefined);
  const { sort, dir } = parseListOptions(params);

  // The one authenticated route that hands over the whole book of carriers at once. It
  // is limited and recorded for that reason — not because a signed-in colleague is a
  // threat, but because "who took a copy of the customer list" should have an answer.
  const verdict = checkBurst(`export:${user.id}`, EXPORT_RULE);
  if (!verdict.allowed) {
    // describeLockout talks about sign-ins, which this is not.
    return new Response(`Too many exports in a row. Try again in ${retryInWords(verdict)}.`, {
      status: 429,
    });
  }
  recordBurst(`export:${user.id}`);

  const { rows } = listCarriers(org, filters, { sort, dir, page: 1, pageSize: MAX_ROWS });
  record({
    organizationId: org.id, userId: user.id, actor: user.email, action: AUDIT.EXPORT_RUN,
    detail: `${rows.length} carrier${rows.length === 1 ? "" : "s"}${path ? ` from ${path}` : ""}`,
  });
  return csvResponse(carriersToCsv(org, rows), `carriers-${stamp()}.csv`);
}
