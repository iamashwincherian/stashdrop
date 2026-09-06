"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { acceptInvite, declineInvite } from "@/lib/workspace-client";

export default function AcceptInviteClient({ invitationId }: { invitationId: string }) {
  const router = useRouter();
  const [invite, setInvite] = useState<{ organizationId: string; organizationName: string } | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void authClient.organization.listUserInvitations().then(({ data }) => {
      const found = data?.find((i) => i.id === invitationId && i.status === "pending");
      setInvite(found ? { organizationId: found.organizationId, organizationName: found.organizationName ?? "this team" } : null);
    });
  }, [invitationId]);

  async function accept() {
    if (!invite) return;
    setBusy(true);
    setError(null);
    try {
      await acceptInvite(invitationId, invite.organizationId);
      router.push("/");
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setBusy(false);
    }
  }

  async function decline() {
    setBusy(true);
    setError(null);
    try {
      await declineInvite(invitationId);
      router.push("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 grid place-items-center bg-paper p-5">
      <div className="w-[min(400px,100%)] rounded-[14px] border border-default bg-surface-solid px-[26px] py-7 font-sans shadow-[0_24px_60px_rgba(var(--shadow-color),.1)]">
        {invite === undefined && <div className="text-[13px] text-faint">Loading…</div>}
        {invite === null && (
          <>
            <div className="mb-2 font-serif text-[22px] text-primary">Invite not found</div>
            <div className="text-[13px] text-muted">
              This invitation may have expired, already been used, or was sent to a different email address.
            </div>
          </>
        )}
        {invite && (
          <>
            <div className="mb-2 font-serif text-[22px] text-primary">
              Join {invite.organizationName}?
            </div>
            <div className="mb-5 text-[13px] text-muted">
              You&apos;ve been invited to this team&apos;s workspace on Stashdrop.
            </div>
            {error && <div className="mb-3 text-[12.5px] text-danger">{error}</div>}
            <div className="flex gap-2.5">
              <button
                onClick={accept}
                disabled={busy}
                className={`rounded-lg border border-primary bg-primary px-4 py-[9px] text-[13.5px] font-medium text-card ${busy ? "cursor-default opacity-60" : "cursor-pointer"}`}
              >{busy ? "Please wait…" : "Accept"}</button>
              <button
                onClick={decline}
                disabled={busy}
                className={`rounded-lg border border-strong bg-transparent px-4 py-[9px] text-[13.5px] text-secondary ${busy ? "cursor-default" : "cursor-pointer"}`}
              >Decline</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}