"use server";

import { createProject, createStash, getProject, getStash, updateProject, type Project, type Stash } from "./db";
import { requireSession, requireStashId, setCurrentStash } from "./session";

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

  const project = createProject(input.projectName.trim() || "My project", input.projectDescription.trim(), input.scope, ownerId);
  const stash = createStash(project.id, input.stashName.trim() || "First stash");
  await setCurrentStash(stash.id);

  return { projectId: project.id, stashId: stash.id };
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
