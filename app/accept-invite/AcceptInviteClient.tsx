"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { acceptInvite, declineInvite } from "@/lib/workspace-client";

const SERIF = "var(--font-serif), serif";
const SANS = "var(--font-sans), system-ui, sans-serif";

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
    <div style={{ position: "fixed", inset: 0, background: "var(--paper)", display: "grid", placeItems: "center", padding: 20 }}>
      <div style={{
        width: "min(400px, 100%)", background: "var(--surface-solid)", border: "1px solid var(--border-default)", borderRadius: 14,
        padding: "28px 26px", boxShadow: "0 24px 60px rgba(var(--shadow-color),.1)", fontFamily: SANS,
      }}>
        {invite === undefined && <div style={{ fontSize: 13, color: "var(--text-faint)" }}>Loading…</div>}
        {invite === null && (
          <>
            <div style={{ fontFamily: SERIF, fontSize: 22, color: "var(--text-primary)", marginBottom: 8 }}>Invite not found</div>
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
              This invitation may have expired, already been used, or was sent to a different email address.
            </div>
          </>
        )}
        {invite && (
          <>
            <div style={{ fontFamily: SERIF, fontSize: 22, color: "var(--text-primary)", marginBottom: 8 }}>
              Join {invite.organizationName}?
            </div>
            <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 20 }}>
              You&apos;ve been invited to this team&apos;s workspace on Stashdrop.
            </div>
            {error && <div style={{ fontSize: 12.5, color: "var(--danger)", marginBottom: 12 }}>{error}</div>}
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={accept}
                disabled={busy}
                style={{
                  border: "1px solid var(--text-primary)", background: "var(--text-primary)", color: "var(--card-bg)",
                  borderRadius: 8, padding: "9px 16px", fontSize: 13.5, fontWeight: 500, cursor: busy ? "default" : "pointer", opacity: busy ? 0.6 : 1,
                }}
              >{busy ? "Please wait…" : "Accept"}</button>
              <button
                onClick={decline}
                disabled={busy}
                style={{
                  border: "1px solid var(--border-strong)", background: "none", color: "var(--text-secondary)",
                  borderRadius: 8, padding: "9px 16px", fontSize: 13.5, cursor: busy ? "default" : "pointer",
                }}
              >Decline</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
