// Khareedo route guard (Next.js 16 proxy convention).
// Protects /admin and /account at the edge; roles re-verified server-side in
// every protected page and API route (defence in depth, FR-38, NFR-10/12).
import { NextResponse, type NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

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
  matcher: ["/admin/:path*", "/account/:path*"],
};
