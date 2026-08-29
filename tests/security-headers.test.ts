import { test } from "node:test";
import assert from "node:assert/strict";
import { securityHeaders } from "../src/lib/security-headers.ts";

/**
 * These assert the properties that make the policy worth having, because those are what
 * a later "just make it work" edit quietly removes.
 */
const prod = securityHeaders("NONCE123", false);
const dev = securityHeaders("NONCE123", true);
const directive = (csp: string, name: string) =>
  csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";

test("scripts run only with this request's nonce", () => {
  const scriptSrc = directive(prod["Content-Security-Policy"]!, "script-src");
  assert.match(scriptSrc, /'nonce-NONCE123'/);
  assert.match(scriptSrc, /'strict-dynamic'/);
  assert.ok(
    !scriptSrc.includes("'unsafe-inline'"),
    "an inline-script allowance would make the whole policy decorative",
  );
});

test("eval is allowed in development only", () => {
  assert.match(directive(dev["Content-Security-Policy"]!, "script-src"), /'unsafe-eval'/);
  assert.ok(
    !directive(prod["Content-Security-Policy"]!, "script-src").includes("'unsafe-eval'"),
    "React only needs eval for development error reconstruction",
  );
});

test("the page cannot be framed, and says so twice", () => {
  assert.match(prod["Content-Security-Policy"]!, /frame-ancestors 'none'/);
  assert.equal(prod["X-Frame-Options"], "DENY");
});

test("forms and connections cannot leave this origin", () => {
  const csp = prod["Content-Security-Policy"]!;
  assert.match(csp, /form-action 'self'/, "a stolen form must not post somewhere else");
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /base-uri 'self'/, "so an injected <base> cannot re-point every link");
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /default-src 'self'/);
});

test("what the app genuinely needs is allowed, and no more", () => {
  const csp = prod["Content-Security-Policy"]!;
  assert.match(directive(csp, "img-src"), /data:/, "the two-factor QR is a data URI");
  assert.equal(directive(csp, "font-src"), "font-src 'self'", "next/font self-hosts");
  assert.ok(!csp.includes("http://"), "no host is allowlisted by scheme");
  assert.ok(!csp.includes("*"), "and nothing is allowlisted by wildcard");
});

test("HTTPS is pinned in production only, and never preloaded", () => {
  assert.match(prod["Strict-Transport-Security"]!, /^max-age=31536000; includeSubDomains$/);
  assert.ok(
    !prod["Strict-Transport-Security"]!.includes("preload"),
    "preload is a one-way door that outlives whoever chose it",
  );
  assert.equal(dev["Strict-Transport-Security"], undefined, "there is no HTTPS to pin locally");
  assert.match(prod["Content-Security-Policy"]!, /upgrade-insecure-requests/);
  assert.ok(!dev["Content-Security-Policy"]!.includes("upgrade-insecure-requests"));
});

test("the rest of the headers a review will look for", () => {
  assert.equal(prod["X-Content-Type-Options"], "nosniff");
  assert.equal(prod["Referrer-Policy"], "strict-origin-when-cross-origin");
  assert.match(prod["Permissions-Policy"]!, /camera=\(\)/);
});
