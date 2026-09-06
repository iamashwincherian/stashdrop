import { headers, cookies } from "next/headers";
import { auth } from "./auth";
import { getStashForWorkspace, getOrgRole, resolveActiveOrg } from "./db";

// Which of a workspace's several stashes the browser last picked (see
// switchStash in workspace-actions.ts). Purely a preference — never trusted
// on its own, since it's client state a browser can carry across accounts.
// getStashForWorkspace re-checks it belongs to the resolved workspace on
// every read, so at worst a stale/foreign id just falls back to that
// workspace's earliest stash, the same as if no preference had been set.
export const ACTIVE_STASH_COOKIE = "sd_stash";

export async function requireSession() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) throw new Error("Not authenticated");
  return session;
}

// Resolved fresh from the DB via the session's user id and active
// organization on every call — not cached in a cookie beyond which stash,
// among that workspace's own, is preferred. The workspace itself is never
// trusted from a cookie: it would keep pointing at whichever
// account/workspace last used this browser, silently handing that stash to
// the next person who signs in. See getStashForWorkspace for how "current"
// is picked (better-auth's own activeOrganizationId pointer, plus this
// preference).
export async function currentStashId(): Promise<string | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) return null;
  const preferred = (await cookies()).get(ACTIVE_STASH_COOKIE)?.value ?? null;
  return getStashForWorkspace(session.user.id, session.session.activeOrganizationId ?? null, preferred)?.id ?? null;
}

export async function requireStashId(): Promise<string> {
  const session = await requireSession();
  const preferred = (await cookies()).get(ACTIVE_STASH_COOKIE)?.value ?? null;
  const stash = getStashForWorkspace(session.user.id, session.session.activeOrganizationId ?? null, preferred);
  if (!stash) throw new Error("No active stash — onboarding not completed");
  return stash.id;
}

// "owner" on a personal workspace (the sole user always has full control) —
// including when activeOrganizationId points at a team the caller isn't a
// member of anymore, since resolveActiveOrg treats that exactly like the
// personal workspace was active all along. Otherwise the caller's real
// better-auth org role.
export async function requireRole(): Promise<string> {
  const session = await requireSession();
  const orgId = resolveActiveOrg(session.user.id, session.session.activeOrganizationId ?? null);
  if (!orgId) return "owner";
  return getOrgRole(orgId, session.user.id) ?? "member";
}
