"use server";

import {
  createProject, createStash, getProject, getStash, updateProject, getFirstProjectForOrg,
  getFirstStashForProject, deleteProjectCascade, getOrgRole, type Project, type Stash,
} from "./db";
import { requireSession, requireStashId, requireRole } from "./session";

export async function completeOnboarding(input: {
  scope: "user" | "organization";
  organizationId?: string;
  projectName: string;
  projectDescription: string;
  stashName: string;
}): Promise<{ projectId: string; stashId: string }> {
  const session = await requireSession();
  const ownerId = input.scope === "organization" ? input.organizationId : session.user.id;
  if (!ownerId) throw new Error("Missing organization id for team scope");

  // A brand-new team never has a project yet (it was just created), but
  // this guards against calling completeOnboarding twice for the same org.
  const existing = input.scope === "organization" ? getFirstProjectForOrg(ownerId) : null;
  const project = existing ?? createProject(input.projectName.trim() || "My project", input.projectDescription.trim(), input.scope, ownerId);
  // No need to record which stash is "current" — getStashForWorkspace
  // derives it fresh from this project/stash pair via the session's active
  // organization on every request.
  const stash = existing ? getFirstStashForProject(project.id) : createStash(project.id, input.stashName.trim() || "First stash");

  return { projectId: project.id, stashId: stash!.id };
}

export async function getCurrentWorkspace(): Promise<{ project: Project; stash: Stash } | null> {
  const stashId = await requireStashId();
  const stash = getStash(stashId);
  if (!stash) return null;
  const project = getProject(stash.projectId);
  if (!project) return null;
  return { project, stash };
}

export async function updateProjectSettings(id: string, edits: { name?: string; description?: string }): Promise<Project | null> {
  return updateProject(id, edits);
}

// Called after accepting an invitation (and after setting the org active)
// so a joining member always lands on a real project — creates a default
// one only if this org somehow has none yet (e.g. the inviter never
// finished their own onboarding).
export async function ensureWorkspaceReady(organizationId: string): Promise<void> {
  if (getFirstProjectForOrg(organizationId)) return;
  const project = createProject("My project", "", "organization", organizationId);
  createStash(project.id, "First stash");
}

export async function getMyRole(): Promise<string> {
  return requireRole();
}

// Owner-only. Deletes the workspace's project (and everything in it), then
// immediately creates a fresh empty one in its place — the app has no
// concept of a zero-project workspace, so "delete" here really means
// "reset the project."
export async function deleteProject(projectId: string): Promise<{ projectId: string; stashId: string }> {
  const session = await requireSession();
  const project = getProject(projectId);
  if (!project) throw new Error("Project not found");

  const role = project.ownerType === "organization" ? getOrgRole(project.ownerId, session.user.id) : "owner";
  if (role !== "owner") throw new Error("Only the workspace owner can delete a project");

  deleteProjectCascade(projectId);
  const next = createProject("My project", "", project.ownerType as "user" | "organization", project.ownerId);
  const stash = createStash(next.id, "First stash");
  return { projectId: next.id, stashId: stash.id };
}
