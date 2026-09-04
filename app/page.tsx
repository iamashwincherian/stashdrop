import { redirect } from "next/navigation";
import Canvas from "./Canvas";
import { getAllItemsWithMeta } from "@/lib/db";
import { currentStashId } from "@/lib/session";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";

export const dynamic = "force-dynamic";

export default async function Page() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-in");

  const stashId = await currentStashId();
  if (!stashId) {
    // Signed in but never finished onboarding (no project/stash yet) —
    // Canvas renders the onboarding wizard instead of the desk in this case.
    return (
      <Canvas
        initialItems={[]}
        initialBucket={{}}
        initialRecentOrder={[]}
        user={{ name: session.user.name, email: session.user.email }}
        needsOnboarding
      />
    );
  }

  const { items, bucket, recentOrder } = getAllItemsWithMeta(stashId);
  return (
    <Canvas
      initialItems={items}
      initialBucket={bucket}
      initialRecentOrder={recentOrder}
      user={{ name: session.user.name, email: session.user.email }}
      needsOnboarding={false}
    />
  );
}
