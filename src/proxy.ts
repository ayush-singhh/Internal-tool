import { NextResponse, type NextRequest } from "next/server";
import { securityHeaders } from "./lib/security-headers.ts";

/**
 * Security headers, on every response.
 *
 * `proxy.ts`, not `middleware.ts` — the middleware convention is deprecated in Next 16
 * and renamed. Same behaviour, different filename.
 *
 * The nonce is minted here, per request, and cannot be baked into a prerendered page —
 * so every route this covers renders per request. The one exception is Next's built-in
 * 404, which stays prerendered and therefore serves scripts without the nonce: they are
 * blocked, the page still renders its text, and there is nothing on it to hydrate.
 * A route with anything to click must not be static while this policy is in force.
 */
export function proxy(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const headers = securityHeaders(nonce, process.env.NODE_ENV === "development");

  // Next reads the policy back off the request to nonce its own script tags.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // The path, for pages that must record what was looked at (see lib/support.ts). A
  // Server Component cannot otherwise see the URL it is rendering.
  requestHeaders.set("x-pathname", request.nextUrl.pathname);
  requestHeaders.set("Content-Security-Policy", headers["Content-Security-Policy"]!);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
  return response;
}

export const config = {
  matcher: [
    {
      // Everything but Next's own immutable static output, which needs no policy and is
      // served straight from the CDN. Prefetches are skipped: they render no HTML.
      source: "/((?!_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
