import { test, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

let s: typeof import("../src/lib/sms.ts");
before(async () => { s = await import("../src/lib/sms.ts"); });

const ENV = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM", "NODE_ENV"] as const;
// NODE_ENV is typed readonly, and these tests exist precisely to check both sides of it.
const env = process.env as Record<string, string | undefined>;
let saved: Record<string, string | undefined> = {};

beforeEach(() => { saved = Object.fromEntries(ENV.map((k) => [k, env[k]])); });
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete env[k];
    else env[k] = saved[k];
  }
});

const configure = () => {
  env.TWILIO_ACCOUNT_SID = "AC123";
  env.TWILIO_AUTH_TOKEN = "secret-token";
  env.TWILIO_FROM = "+15550000000";
};
const unconfigure = () => {
  delete env.TWILIO_ACCOUNT_SID;
  delete env.TWILIO_AUTH_TOKEN;
  delete env.TWILIO_FROM;
};

/** Records the one request made, and answers with `status`. */
function capture(status = 201) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(status < 400 ? "{}" : "bad number", { status });
  }) as typeof fetch;
  return { calls, fetcher };
}

test("the message is posted to the account's Messages endpoint", async () => {
  const { calls, fetcher } = capture();
  await s.twilioRequest(
    { to: "+15551234567", body: "Your code is 123456" },
    { accountSid: "AC123", authToken: "secret-token", from: "+15550000000" },
    fetcher,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
  assert.equal(calls[0]!.init.method, "POST");
});

test("credentials travel as HTTP basic auth, not in the body", async () => {
  const { calls, fetcher } = capture();
  await s.twilioRequest(
    { to: "+15551234567", body: "hello" },
    { accountSid: "AC123", authToken: "secret-token", from: "+15550000000" },
    fetcher,
  );
  const headers = calls[0]!.init.headers as Record<string, string>;
  const expected = Buffer.from("AC123:secret-token").toString("base64");
  assert.equal(headers.Authorization, `Basic ${expected}`);
  assert.match(headers["Content-Type"]!, /application\/x-www-form-urlencoded/);
  assert.doesNotMatch(String(calls[0]!.init.body), /secret-token/);
});

test("To, From and Body are form-encoded", async () => {
  const { calls, fetcher } = capture();
  await s.twilioRequest(
    { to: "+15551234567", body: "Your code is 123456" },
    { accountSid: "AC123", authToken: "t", from: "+15550000000" },
    fetcher,
  );
  const sent = new URLSearchParams(String(calls[0]!.init.body));
  assert.equal(sent.get("To"), "+15551234567");
  assert.equal(sent.get("From"), "+15550000000");
  assert.equal(sent.get("Body"), "Your code is 123456");
});

test("a refusal from Twilio is an error, not a silent drop", async () => {
  const { fetcher } = capture(400);
  await assert.rejects(
    () => s.twilioRequest(
      { to: "not-a-number", body: "hi" },
      { accountSid: "AC123", authToken: "t", from: "+15550000000" },
      fetcher,
    ),
    /400/,
  );
});

test("smsConfigured reflects whether all three variables are set", () => {
  configure();
  assert.equal(s.smsConfigured(), true);
  delete env.TWILIO_FROM;
  assert.equal(s.smsConfigured(), false, "a partial configuration is not a configuration");
  unconfigure();
  assert.equal(s.smsConfigured(), false);
});

test("production refuses to start a sender it cannot send with", () => {
  unconfigure();
  env.NODE_ENV = "production";
  // A portal that silently drops its verification code is a portal nobody can sign up
  // to — the same reasoning as mailer()'s production guard.
  assert.throws(() => s.sender(), /TWILIO_ACCOUNT_SID/);
});

test("development logs the message instead, so the flow can be completed offline", async () => {
  unconfigure();
  env.NODE_ENV = "development";
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try {
    await s.sender()({ to: "+15551234567", body: "Your code is 123456" });
  } finally {
    console.log = original;
  }
  assert.match(lines.join("\n"), /123456/);
});
