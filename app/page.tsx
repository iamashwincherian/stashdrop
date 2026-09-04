import { redirect } from "next/navigation";
import Canvas from "./Canvas";
import { getAllItemsWithMeta, getStashForWorkspace, getProject, getOrgRole, getOrgName, resolveActiveOrg, hasAnyWorkspace } from "@/lib/db";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

export default async function Page() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");

  const orgId = resolveActiveOrg(session.user.id, session.session.activeOrganizationId ?? null);
  const workspace = orgId
    ? { name: getOrgName(orgId) || "Team", organizationId: orgId }
    : { name: "Personal", organizationId: null };
  const role = orgId ? getOrgRole(orgId, session.user.id) || "member" : "owner";

  const user = { id: session.user.id, name: session.user.name, email: session.user.email };

  const stash = getStashForWorkspace(session.user.id, orgId);
  if (!stash) {
    // Signed in but never finished onboarding (no project/stash yet) —
    // Canvas renders the onboarding wizard instead of the desk in this case.
    // If the user already has a workspace somewhere (they just switched into
    // this one from the workspace switcher), the "Personal or team" step is
    // pointless — the workspace was just chosen. Pre-set the scope so the
    // wizard opens straight on naming the first stash.
    const hasWorkspace = hasAnyWorkspace(session.user.id);
    return (
      <Canvas
        key={workspace.organizationId ?? "personal"}
        initialItems={[]}
        initialBucket={{}}
        initialRecentOrder={[]}
        user={user}
        project={null}
        workspace={workspace}
        role={role}
        needsOnboarding
        onboardingInitialScope={hasWorkspace ? (workspace.organizationId ? "organization" : "user") : undefined}
        onboardingOrganizationId={workspace.organizationId ?? undefined}
      />
    );
  }

  const project = getProject(stash.projectId);
  const { items, bucket, recentOrder } = getAllItemsWithMeta(stash.id);
  return (
    <Canvas
      // Canvas keeps items/positions/etc. in local state, seeded once from
      // these initial* props — switching workspaces alone wouldn't reset
      // that state (a router.refresh() re-renders with new props, but
      // useState ignores changed initial values on an already-mounted
      // component). Keying on the resolved stash id forces a clean remount
      // instead, which is what actually makes the switch show up without
      // a hard page reload.
      key={stash.id}
      initialItems={items}
      initialBucket={bucket}
      initialRecentOrder={recentOrder}
      user={user}
      project={project ? { name: project.name, description: project.description } : null}
      workspace={workspace}
      role={role}
      needsOnboarding={false}
    />
  );
}
