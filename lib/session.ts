import { cookies, headers } from "next/headers";
import { auth } from "./auth";

export const STASH_COOKIE = "stashdrop_stash";

export async function requireSession() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error("Not authenticated");
  return session;
}

// The "current stash" is stored in a cookie rather than threaded through
// every Canvas.tsx call site — server actions resolve it themselves, so
// savePosition(id, x, y) etc. keep their existing signatures untouched.
export async function currentStashId(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(STASH_COOKIE)?.value ?? null;
}

export async function requireStashId(): Promise<string> {
  const id = await currentStashId();
  if (!id) throw new Error("No active stash — onboarding not completed");
  return id;
}

export async function setCurrentStash(stashId: string) {
  const jar = await cookies();
  jar.set(STASH_COOKIE, stashId, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 365 });
}
