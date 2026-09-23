import "server-only";

/**
 * Outbound SMS — one message, one recipient, used only to verify a phone number on the
 * onboarding portal.
 *
 * ponytail: ~40 lines of `fetch` instead of the Twilio SDK, which is the same trade
 * `s3.ts` and `stripe.ts` already make (AI Rules §1). Twilio's send endpoint is one
 * form-encoded POST with basic auth; the package would bring a request signer, a webhook
 * validator, TwiML builders and a paging client we never call. Ceiling: sending only, no
 * delivery receipts, no media. If delivery status ever matters, that is a webhook and a
 * table, not a dependency.
 *
 * Two real implementations, exactly as `mailer.ts`: the API where credentials exist, and
 * the log where they do not, so the portal can be walked end to end locally with no
 * Twilio account. Production refuses the log — a portal that silently drops its
 * verification code is a portal nobody can sign up to.
 */
export type Sms = { to: string; body: string };
export type Sender = (sms: Sms) => Promise<void>;

/** Injected in tests, exactly as in `stripe.ts`. */
export type Fetcher = typeof fetch;

export type Credentials = { accountSid: string; authToken: string; from: string };

/** All three, or nothing. A partial configuration is a misconfiguration, and treating it
 *  as "configured" would fail at send time with a less obvious message. */
export function credentials(): Credentials | null {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_FROM;
  if (!accountSid || !authToken || !from) return null;
  return { accountSid, authToken, from };
}

export function smsConfigured(): boolean {
  return credentials() !== null;
}

export async function twilioRequest(
  sms: Sms,
  creds: Credentials,
  fetcher: Fetcher = fetch,
): Promise<void> {
  const url =
    `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}/Messages.json`;
  // Basic auth, so the token is in a header rather than the body — it must not end up in
  // a request log that records form fields.
  const auth = Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString("base64");

  const response = await fetcher(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    // URLSearchParams escapes the values, so nothing in a phone number or message body
    // can add a field.
    body: new URLSearchParams({ To: sms.to, From: creds.from, Body: sms.body }).toString(),
  });

  if (!response.ok) {
    // Twilio's own explanation is worth keeping — "not a mobile number" and "unverified
    // recipient on a trial account" are both common and both fixable. Truncated because
    // this reaches an error log, and capped well below anything that could carry the
    // message body back out.
    const detail = await response.text().catch(() => "");
    throw new Error(`Twilio refused the message (${response.status}). ${detail.slice(0, 200)}`);
  }
}

export function sender(): Sender {
  const creds = credentials();

  if (!creds) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM must be set before this " +
          "can send a message.",
      );
    }
    // Development only, and deliberately prints the code: reading it off the console is
    // how the portal is walked without a Twilio account. Unreachable in production by
    // the throw above.
    return async (sms) => {
      console.log(
        `\n─── sms (no Twilio credentials; not sent) ───\nTo: ${sms.to}\n\n${sms.body}\n` +
          "────────────────────────────────────────────\n",
      );
    };
  }

  return (sms) => twilioRequest(sms, creds);
}
