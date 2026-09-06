"use server";

import { cookies } from "next/headers";
import {
  createStash, getStash, updateStash, getFirstStashForOrg, deleteStash as deleteStashDb, getOrgRole, hasAnyWorkspace, seedStarterCards, type Stash,
} from "./db";
import { requireSession, requireStashId, requireRole, ACTIVE_STASH_COOKIE } from "./session";

export async function completeOnboarding(input: {
  scope: "user" | "organization";
  organizationId?: string;
  stashName: string;
  stashDescription?: string;
}): Promise<{ stashId: string }> {
  const session = await requireSession();
  const ownerId = input.scope === "organization" ? input.organizationId : session.user.id;
  if (!ownerId) throw new Error("Missing organization id for team scope");

  // A brand-new team never has a stash yet (it was just created), but
  // this guards against calling completeOnboarding twice for the same org.
  const existing = input.scope === "organization" ? getFirstStashForOrg(ownerId) : null;
  // Decide the "first stash, seed the welcome cards" case BEFORE creating
  // the stash below — hasAnyWorkspace would otherwise already see the
  // stash we're about to insert and conclude this isn't a brand-new user.
  const firstPersonalStash = input.scope === "user" && !hasAnyWorkspace(session.user.id);
  const firstTeamStash = input.scope === "organization" && !existing;
  // No need to record which stash is "current" — getStashForWorkspace
  // derives it fresh from this stash's owner via the session's active
  // organization on every request.
  const stash = existing ?? createStash(input.stashName.trim() || "First stash", input.stashDescription?.trim() ?? "", input.scope, ownerId);

  // A brand-new user's very first stash gets the two welcome cards so the
  // empty desk explains itself — personal scope means no workspace exists
  // anywhere yet; a team just created has no stash either.
  if (firstPersonalStash || firstTeamStash) seedStarterCards(stash.id, session.user.id);

  return { stashId: stash.id };
}

export async function getCurrentStash(): Promise<Stash | null> {
  const stashId = await requireStashId();
  return getStash(stashId);
}

// id must be the caller's own active stash — without this check, anyone
// signed in could rename/redescribe any stash in the database by guessing
// its id, since a server action is callable directly, not just through the
// UI that happens to only ever pass the current stash's id.
export async function updateStashSettings(id: string, edits: { name?: string; description?: string }): Promise<Stash | null> {
  if (id !== (await requireStashId())) throw new Error("Stash not found");
  return updateStash(id, edits);
}

// Called after accepting an invitation (and after setting the org active)
// so a joining member always lands on a real stash — creates a default
// one only if this org somehow has none yet (e.g. the inviter never
// finished their own onboarding).
export async function ensureWorkspaceReady(organizationId: string): Promise<void> {
  if (getFirstStashForOrg(organizationId)) return;
  createStash("First stash", "", "organization", organizationId);
}

export async function getMyRole(): Promise<string> {
  return requireRole();
}

// Creates a new stash in the current workspace and switches into it right
// away — a freshly created stash with nothing in it is only useful once
// it's the one you're looking at.
export async function createNewStash(name: string): Promise<Stash> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Stash needs a name");
  const current = getStash(await requireStashId());
  if (!current) throw new Error("No active stash");
  const stash = createStash(trimmed, "", current.ownerType, current.ownerId);
  await switchStash(stash.id);
  return stash;
}

// Records which of the current workspace's stashes the browser wants to
// look at. Only ever takes effect for a stash that's actually owned by
// that workspace — see getStashForWorkspace, which re-checks this on every
// read.
export async function switchStash(stashId: string): Promise<void> {
  const current = getStash(await requireStashId());
  const target = getStash(stashId);
  if (!current || !target || target.ownerId !== current.ownerId || target.ownerType !== current.ownerType) throw new Error("Stash not found");
  (await cookies()).set(ACTIVE_STASH_COOKIE, stashId, { httpOnly: true, sameSite: "lax", path: "/" });
}

// Owner-only. Deletes the stash and everything in it. If it was the
// workspace's last stash, the next page load shows onboarding so a fresh
// one can be made — a workspace with zero stashes simply has no desk yet.
export async function deleteStash(stashId: string): Promise<void> {
  const session = await requireSession();
  const stash = getStash(stashId);
  if (!stash) throw new Error("Stash not found");

  // A personal stash's "owner" is whoever's stash it actually is — without
  // this check every personal stash was deletable by any signed-in user who
  // guessed its id, since "owner" was being handed out unconditionally here.
  const role = stash.ownerType === "organization"
    ? getOrgRole(stash.ownerId, session.user.id)
    : stash.ownerId === session.user.id ? "owner" : null;
  if (role !== "owner") throw new Error("Only the workspace owner can delete a stash");

  deleteStashDb(stashId);
}