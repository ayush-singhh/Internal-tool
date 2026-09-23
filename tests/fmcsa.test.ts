import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

let f: typeof import("../src/lib/fmcsa.ts");
before(async () => { f = await import("../src/lib/fmcsa.ts"); });

let saved: string | undefined;
beforeEach(() => { saved = process.env.FMCSA_WEB_KEY; process.env.FMCSA_WEB_KEY = "test-key"; });
afterEach(() => {
  if (saved === undefined) delete process.env.FMCSA_WEB_KEY;
  else process.env.FMCSA_WEB_KEY = saved;
});

/** A QCMobile payload, trimmed to the fields that are read. */
const payload = (carrier: Record<string, unknown> | null) =>
  JSON.stringify({ content: carrier === null ? null : { carrier } });

function answering(body: string, status = 200) {
  const calls: string[] = [];
  const fetcher = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(body, { status });
  }) as typeof fetch;
  return { calls, fetcher };
}

test("a carrier record becomes legal name, DBA, state and operating authority", async () => {
  const { calls, fetcher } = answering(payload({
    dotNumber: 1234567,
    legalName: "ACME TRUCKING LLC",
    dbaName: "ACME EXPRESS",
    phyState: "TX",
    allowedToOperate: "Y",
  }));
  const result = await f.lookupUsdot("1234567", fetcher);
  assert.ok(result.ok);
  assert.deepEqual(result.carrier, {
    usdot: "1234567",
    legalName: "ACME TRUCKING LLC",
    dbaName: "ACME EXPRESS",
    state: "TX",
    allowedToOperate: true,
  });
  assert.match(calls[0]!, /mobile\.fmcsa\.dot\.gov/);
  assert.match(calls[0]!, /webKey=test-key/);
});

test("a carrier barred from operating is reported, not hidden", async () => {
  const { fetcher } = answering(payload({
    dotNumber: 7654321, legalName: "SUSPENDED HAULING INC", allowedToOperate: "N",
  }));
  const result = await f.lookupUsdot("7654321", fetcher);
  assert.ok(result.ok);
  // Recorded for the reviewer. Whether to onboard is a commercial decision, so the
  // lookup must not turn this into a refusal.
  assert.equal(result.carrier.allowedToOperate, false);
  assert.equal(result.carrier.dbaName, null);
});

test("an unknown USDOT is not found rather than an error", async () => {
  const { fetcher } = answering(payload(null));
  const result = await f.lookupUsdot("9999999", fetcher);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason === "not_found");
});

test("without a web key the lookup says so, so the step can fall back to typing", async () => {
  delete process.env.FMCSA_WEB_KEY;
  let called = false;
  const fetcher = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
  const result = await f.lookupUsdot("1234567", fetcher);
  assert.ok(!result.ok && result.reason === "unconfigured");
  assert.equal(called, false, "no request is attempted without a key");
});

test("FMCSA being down degrades to manual entry, it does not throw", async () => {
  const fetcher = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
  const result = await f.lookupUsdot("1234567", fetcher);
  assert.ok(!result.ok && result.reason === "unavailable");
});

test("a non-2xx from FMCSA is unavailable, not a crash", async () => {
  const { fetcher } = answering("gateway timeout", 504);
  const result = await f.lookupUsdot("1234567", fetcher);
  assert.ok(!result.ok && result.reason === "unavailable");
});

test("a non-numeric USDOT never reaches the network", async () => {
  let called = false;
  const fetcher = (async () => { called = true; return new Response("{}"); }) as typeof fetch;
  const result = await f.lookupUsdot("12; DROP TABLE carriers", fetcher);
  assert.ok(!result.ok && result.reason === "invalid");
  assert.equal(called, false);
});
