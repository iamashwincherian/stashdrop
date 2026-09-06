"use client";

import { authClient } from "./auth-client";
import { completeOnboarding, ensureWorkspaceReady } from "./workspace-actions";

function slugify(s: string) {
  return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "team";
}

// Creates a brand-new team (org) and its first stash. Shared by Onboarding's
// "create a team" step and the workspace switcher's "+ New team" row — same
// two-call sequence either way. A stash is owned directly by the workspace,
// no separate project layer.
export async function createTeamAndStash(input: {
  teamName: string;
  stashName: string;
}): Promise<{ organizationId: string; stashId: string }> {
  const { data, error } = await authClient.organization.create({ name: input.teamName.trim() || "My team", slug: slugify(input.teamName) });
  if (error) throw new Error(error.message || "Couldn't create team.");
  const organizationId = data!.id;
  const stashName = input.stashName.trim() || "First stash";
  const { stashId } = await completeOnboarding({
    scope: "organization",
    organizationId,
    stashName,
  });
  await authClient.organization.setActive({ organizationId });
  return { organizationId, stashId };
}

// Accept an invitation, switch the active workspace to it, and make sure
// it has a stash to land in.
export async function acceptInvite(invitationId: string, organizationId: string): Promise<void> {
  const { error } = await authClient.organization.acceptInvitation({ invitationId });
  if (error) throw new Error(error.message || "Couldn't accept that invite.");
  await authClient.organization.setActive({ organizationId });
  await ensureWorkspaceReady(organizationId);
}

export async function declineInvite(invitationId: string): Promise<void> {
  const { error } = await authClient.organization.rejectInvitation({ invitationId });
  if (error) throw new Error(error.message || "Couldn't decline that invite.");
}
