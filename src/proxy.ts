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

  // CSRF check first, for API paths only: a cross-site POST must be
  // rejected before any auth work, and the check must not touch the
  // unauthenticated webhook / CSP-report / NextAuth flows (exempted in
  // isCsrfRejected). GETs are never checked — the Safepay return page is
  // a GET that triggers server-side payment verification.
  if (pathname.startsWith("/api/") && isCsrfRejected(request)) {
    return NextResponse.json(
      { ok: false, error: "Cross-site request rejected." },
      { status: 403 },
    );
  }

  const isAdminArea = pathname.startsWith("/admin") && pathname !== "/admin/login";
  const isAccountArea = pathname.startsWith("/account");

  if (!isAdminArea && !isAccountArea) return NextResponse.next();

  const token = await getToken({
    req: request,
    secret: process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET,
  });

  if (!token) {
    const loginUrl = new URL(isAdminArea ? "/admin/login" : "/login", request.url);
    loginUrl.searchParams.set("callbackUrl", `${pathname}${request.nextUrl.search}`);
    return NextResponse.redirect(loginUrl);
  }

  if (isAdminArea && token.role !== "ADMIN") {
    // Signed in but not an administrator — deny (FR-38)
    const loginUrl = new URL("/admin/login", request.url);
    loginUrl.searchParams.set("error", "Forbidden");
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/account/:path*", "/api/:path*"],
};
