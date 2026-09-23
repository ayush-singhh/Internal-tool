import "server-only";

/**
 * USDOT lookup against FMCSA's QCMobile service.
 *
 * The portal's first question is "what is your USDOT number", and the honest follow-up is
 * "is this you?" — showing the carrier what the federal register says, rather than making
 * somebody type a legal name and hoping it matches.
 *
 * ponytail: one `fetch` and a field rename. There is no FMCSA client worth installing.
 *
 * **Every failure degrades to manual entry.** A missing key, a dead service, an unknown
 * number — all of them return `ok: false` with a reason the page can explain, and none of
 * them throws. Onboarding a carrier must not depend on a government API being up.
 */
export type CarrierRecord = {
  usdot: string;
  legalName: string;
  dbaName: string | null;
  state: string | null;
  /** What FMCSA says about operating authority. Recorded and shown to the reviewer;
   *  never used here to refuse an application. */
  allowedToOperate: boolean;
};

export type LookupFailure = "invalid" | "unconfigured" | "not_found" | "unavailable";
export type LookupResult =
  | { ok: true; carrier: CarrierRecord }
  | { ok: false; reason: LookupFailure };

export type Fetcher = typeof fetch;

/** QCMobile's carrier object, as far as this reads it. */
type QcCarrier = {
  dotNumber?: number | string;
  legalName?: string;
  dbaName?: string | null;
  phyState?: string | null;
  allowedToOperate?: string | null;
};

export function fmcsaConfigured(): boolean {
  return Boolean(process.env.FMCSA_WEB_KEY);
}

const TIMEOUT_MS = 8_000;

export async function lookupUsdot(usdot: string, fetcher: Fetcher = fetch): Promise<LookupResult> {
  // Digits only, and checked here rather than trusted from the caller: this value is
  // interpolated into a URL path.
  if (!/^\d{1,8}$/.test(usdot)) return { ok: false, reason: "invalid" };

  const webKey = process.env.FMCSA_WEB_KEY;
  if (!webKey) return { ok: false, reason: "unconfigured" };

  const url =
    `https://mobile.fmcsa.dot.gov/qc/services/carriers/${usdot}` +
    `?webKey=${encodeURIComponent(webKey)}`;

  let response: Response;
  try {
    // A carrier is waiting on this page. Eight seconds, then fall back to typing.
    response = await fetcher(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  if (!response.ok) return { ok: false, reason: "unavailable" };

  let body: { content?: { carrier?: QcCarrier } | null };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    return { ok: false, reason: "unavailable" };
  }

  // QCMobile answers an unknown number with a 200 and a null content, not a 404.
  const carrier = body.content?.carrier;
  if (!carrier?.legalName) return { ok: false, reason: "not_found" };

  return {
    ok: true,
    carrier: {
      usdot: String(carrier.dotNumber ?? usdot),
      legalName: carrier.legalName,
      // FMCSA returns "" for a carrier trading under its legal name. Null is the honest
      // representation of "there isn't one", and the form treats it that way.
      dbaName: carrier.dbaName?.trim() ? carrier.dbaName.trim() : null,
      state: carrier.phyState?.trim() ? carrier.phyState.trim() : null,
      allowedToOperate: carrier.allowedToOperate === "Y",
    },
  };
}
