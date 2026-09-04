import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import AcceptInviteClient from "./AcceptInviteClient";

export default async function AcceptInvitePage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const { id } = await searchParams;
  if (!id) redirect("/");

  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect("/sign-up");

  return <AcceptInviteClient invitationId={id} />;
}
