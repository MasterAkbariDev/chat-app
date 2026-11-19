import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "./lib/constants";
import { clientIp, isAllowed, parseAllowlist } from "./lib/ip-allowlist";

/**
 * Two cheap checks before any page renders. Neither is the security boundary: each page
 * re-checks the session with the backend, and the backend enforces each route's role.
 *
 * 1. IP allowlist (ADMIN_IP_ALLOWLIST). When unset in production, every request is refused: an
 *    internal panel should not be open to the internet by accident. Set ADMIN_TRUST_PROXY=true
 *    only when a proxy you control sets X-Forwarded-For.
 * 2. Session cookie. No cookie sends the visitor to /login.
 */
export function proxy(request: NextRequest) {
  const allowlist = parseAllowlist(process.env.ADMIN_IP_ALLOWLIST);
  const enforced = allowlist.length > 0 || process.env.NODE_ENV === "production";
  if (enforced) {
    const ip = clientIp(request.headers, process.env.ADMIN_TRUST_PROXY === "true");
    if (!isAllowed(ip, allowlist)) {
      return new NextResponse("Not available from this network.", { status: 403 });
    }
  }

  const { pathname } = request.nextUrl;
  if (pathname !== "/login" && !request.cookies.has(SESSION_COOKIE)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
