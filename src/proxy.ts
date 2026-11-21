// Khareedo route guard (Next.js 16 proxy convention).
// Protects /admin and /account at the edge; roles re-verified server-side in
// every protected page and API route (defence in depth, FR-38, NFR-10/12).
// Also enforces same-origin CSRF protection on state-changing API requests
// (Phase 2, area C) — see src/lib/csrf.ts for the rules and exemptions.
import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { isCsrfRejected } from "@/lib/csrf";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // One id per request, for correlating logs across proxy → route →
  // error capture. It rides on the response (so a client or operator can
  // quote it in a bug report) and on the request headers (so a downstream
  // handler can read it via headers().get("x-request-id")). It carries
  // no user data — a random UUID only. handleRoute (src/lib/api.ts) reads
  // that header — from the request when passed, else via next/headers —
  // and threads it into captureError, so the proxy id is the id on the
  // error line. withPerformanceTiming's ALS context carries its own id
  // as the fallback when the proxy header is absent.
  const requestId = globalThis.crypto.randomUUID();
  const withRequestId = (response: NextResponse) => {
    response.headers.set("x-request-id", requestId);
    return response;
  };
  // Propagating the id on the request headers must happen through
  // NextResponse.next({ request: { headers } }) — mutating
  // request.headers in place has no effect downstream.
  const nextWithRequestId = () => {
    const headers = new Headers(request.headers);
    headers.set("x-request-id", requestId);
    return withRequestId(NextResponse.next({ request: { headers } }));
  };

  // CSRF check first, for API paths only: a cross-site POST must be
  // rejected before any auth work, and the check must not touch the
  // unauthenticated webhook / CSP-report / NextAuth flows (exempted in
  // isCsrfRejected). GETs are never checked — the Safepay return page is
  // a GET that triggers server-side payment verification.
  if (pathname.startsWith("/api/") && isCsrfRejected(request)) {
    return withRequestId(
      NextResponse.json(
        { ok: false, error: "Cross-site request rejected." },
        { status: 403 },
      ),
    );
  }

  const isAdminArea = pathname.startsWith("/admin") && pathname !== "/admin/login";
  const isAccountArea = pathname.startsWith("/account");

  if (!isAdminArea && !isAccountArea) return nextWithRequestId();

  const token = await getToken({
    req: request,
    secret: process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET,
  });

  if (!token) {
    const loginUrl = new URL(isAdminArea ? "/admin/login" : "/login", request.url);
    loginUrl.searchParams.set("callbackUrl", `${pathname}${request.nextUrl.search}`);
    return withRequestId(NextResponse.redirect(loginUrl));
  }

  if (isAdminArea && token.role !== "ADMIN") {
    // Signed in but not an administrator — deny (FR-38)
    const loginUrl = new URL("/admin/login", request.url);
    loginUrl.searchParams.set("error", "Forbidden");
    return withRequestId(NextResponse.redirect(loginUrl));
  }

  return nextWithRequestId();
}

export const config = {
  matcher: ["/admin/:path*", "/account/:path*", "/api/:path*"],
};
