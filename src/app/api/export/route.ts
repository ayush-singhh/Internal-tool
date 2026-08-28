import { requireOrg } from "@/lib/auth";
import { can } from "@/lib/permissions";
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

  const { rows } = listCarriers(org, filters, { sort, dir, page: 1, pageSize: MAX_ROWS });
  return csvResponse(carriersToCsv(org, rows), `carriers-${stamp()}.csv`);
}
