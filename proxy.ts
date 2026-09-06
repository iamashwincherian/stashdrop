import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

// Next 16 renamed middleware.ts to proxy.ts — same mechanics, new name.
// A cookie-presence check only (no DB hit here); real session validation
// still happens per-page via auth.api.getSession.
export function proxy(request: NextRequest) {
  const sessionCookie = getSessionCookie(request);
  if (!sessionCookie) {
    return NextResponse.redirect(new URL("/sign-in", request.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|sign-in|sign-up|reset-password|_next/static|_next/image|favicon.ico).*)"],
};
