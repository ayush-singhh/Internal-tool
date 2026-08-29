/**
 * The security headers, as data.
 *
 * Pure, like `validate.ts`, and for the same reason: `proxy.ts` imports `next/server`,
 * which does not resolve outside the Next runtime, so a policy written there could never
 * be checked. Security headers are exactly the kind of thing that quietly rots — one
 * `'unsafe-inline'` added to unbreak something and never taken out again — so the rules
 * that matter are asserted by test.
 */
export function securityHeaders(nonce: string, dev: boolean): Record<string, string> {
  const csp = [
    "default-src 'self'",
    // 'strict-dynamic' means only scripts carrying this nonce run, and anything they load.
    // An attacker who injected a <script> would have to guess a value minted per request.
    // 'unsafe-eval' is React's dev-only error reconstruction; production does not use it.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ""}`,
    // Style *attributes* (`style={{…}}` in JSX) are not covered by a nonce, and CSS is a
    // far weaker vector than script. Deliberate, not overlooked.
    "style-src 'self' 'unsafe-inline'",
    // data: is the two-factor QR code, rendered to a data URI on the server.
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    // Server Actions post to this origin and nowhere else.
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(dev ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");

  return {
    "Content-Security-Policy": csp,
    // Redundant beside frame-ancestors, and still what a security review greps for.
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    // This application asks for none of these; saying so stops an embedded document asking.
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    // A year, and no `preload`: preloading is a one-way door that outlives the decision
    // and would strand any plain-HTTP subdomain for months. Not sent in development,
    // where there is no HTTPS to pin.
    ...(dev ? {} : { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" }),
  };
}
