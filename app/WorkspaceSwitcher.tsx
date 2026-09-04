"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, User, Check, Mail, Plus } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { acceptInvite, declineInvite, createTeamAndProject } from "@/lib/workspace-client";

const SERIF = "var(--font-serif), serif";
const SANS = "var(--font-sans), system-ui, sans-serif";
const MONO = "var(--font-mono), monospace";

interface Org { id: string; name: string }
interface Invite { id: string; organizationId: string; organizationName: string }

const rowStyle = (active: boolean): React.CSSProperties => ({
  display: "flex", alignItems: "center", gap: 12, textAlign: "left", cursor: "pointer", width: "100%",
  border: `1px solid ${active ? "var(--text-primary)" : "var(--border-default)"}`,
  background: active ? "var(--accent-bg)" : "var(--card-bg)", borderRadius: 10, padding: "11px 13px",
});

export default function WorkspaceSwitcher({ currentOrganizationId, onClose }: { currentOrganizationId: string | null; onClose: () => void }) {
  const router = useRouter();
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [teamName, setTeamName] = useState("");
  const [stashName, setStashName] = useState("First stash");

  function refetch() {
    void authClient.organization.list().then(({ data }) => setOrgs((data || []).map((o) => ({ id: o.id, name: o.name }))));
    void authClient.organization.listUserInvitations().then(({ data }) => {
      setInvites((data || []).filter((i) => i.status === "pending").map((i) => ({ id: i.id, organizationId: i.organizationId, organizationName: i.organizationName ?? "a team" })));
    });
  }
  useEffect(refetch, []);

  async function selectPersonal() {
    setBusy(true);
    await authClient.organization.setActive({ organizationId: null });
    onClose();
    router.refresh();
  }

  async function selectOrg(id: string) {
    setBusy(true);
    await authClient.organization.setActive({ organizationId: id });
    onClose();
    router.refresh();
  }

  async function accept(invite: Invite) {
    setBusy(true);
    setError(null);
    try {
      await acceptInvite(invite.id, invite.organizationId);
      onClose();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't accept that invite.");
      setBusy(false);
    }
  }

  async function decline(invite: Invite) {
    setBusy(true);
    setError(null);
    try {
      await declineInvite(invite.id);
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't decline that invite.");
    }
    setBusy(false);
  }

  async function createTeam() {
    if (!teamName.trim() || !stashName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createTeamAndProject({ teamName, stashName });
      onClose();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create that team.");
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "var(--overlay-bg)", backdropFilter: "blur(4px)", zIndex: 80, display: "grid", placeItems: "center", padding: 20 }}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(400px, 100%)", background: "var(--surface-solid)", border: "1px solid var(--border-default)", borderRadius: 14,
          boxShadow: "0 24px 60px rgba(var(--shadow-color),.16)", padding: "22px 22px 20px", animation: "sd-sheet .22s cubic-bezier(.2,.8,.2,1) both",
        }}
      >
        <div style={{ fontFamily: SERIF, fontSize: 20, color: "var(--text-primary)", marginBottom: 16 }}>Switch workspace</div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button onClick={selectPersonal} disabled={busy} style={rowStyle(currentOrganizationId === null)}>
            <User size={16} color="var(--text-secondary)" />
            <span style={{ flex: 1, fontSize: 13.5, color: "var(--text-primary)" }}>Personal</span>
            {currentOrganizationId === null && <Check size={15} color="var(--text-primary)" />}
          </button>
          {orgs === null && <div style={{ fontSize: 12, color: "var(--text-faint)", padding: "4px 2px" }}>Loading…</div>}
          {orgs?.map((o) => (
            <button key={o.id} onClick={() => selectOrg(o.id)} disabled={busy} style={rowStyle(currentOrganizationId === o.id)}>
              <Building2 size={16} color="var(--text-secondary)" />
              <span style={{ flex: 1, fontSize: 13.5, color: "var(--text-primary)" }}>{o.name}</span>
              {currentOrganizationId === o.id && <Check size={15} color="var(--text-primary)" />}
            </button>
          ))}
        </div>

        {invites.length > 0 && (
          <div style={{ marginTop: 16, borderTop: "1px solid var(--border-subtle)", paddingTop: 14 }}>
            <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-faint)", marginBottom: 8 }}>Pending invites</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {invites.map((invite) => (
                <div key={invite.id} style={{ display: "flex", alignItems: "center", gap: 10, border: "1px solid var(--accent-border)", background: "var(--accent-bg)", borderRadius: 10, padding: "10px 12px" }}>
                  <Mail size={15} color="var(--text-secondary)" />
                  <span style={{ flex: 1, fontSize: 13, color: "var(--text-primary)" }}>{invite.organizationName}</span>
                  <button onClick={() => accept(invite)} disabled={busy} style={{ border: "1px solid var(--text-primary)", background: "var(--text-primary)", color: "var(--card-bg)", borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}>Accept</button>
                  <button onClick={() => decline(invite)} disabled={busy} style={{ border: "1px solid var(--border-strong)", background: "none", color: "var(--text-secondary)", borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}>Decline</button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div style={{ marginTop: 16, borderTop: "1px solid var(--border-subtle)", paddingTop: 14 }}>
          {creating ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <input
                value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="Team name" autoFocus
                style={{ border: "1px solid var(--border-default)", background: "var(--card-bg)", borderRadius: 8, padding: "8px 10px", fontSize: 13, color: "var(--text-primary)", fontFamily: SANS, outline: "none" }}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  value={stashName} onChange={(e) => setStashName(e.target.value)} placeholder="First stash"
                  style={{ flex: 1, border: "1px solid var(--border-default)", background: "var(--card-bg)", borderRadius: 8, padding: "8px 10px", fontSize: 13, color: "var(--text-primary)", fontFamily: SANS, outline: "none" }}
                />
                <button onClick={createTeam} disabled={busy || !teamName.trim() || !stashName.trim()} style={{ border: "1px solid var(--text-primary)", background: "var(--text-primary)", color: "var(--card-bg)", borderRadius: 8, padding: "0 12px", fontSize: 12.5, cursor: "pointer" }}>Create</button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="sd-hover-bg"
              style={{ display: "flex", alignItems: "center", gap: 8, border: "none", background: "none", color: "var(--text-muted)", borderRadius: 6, padding: "6px 4px", fontSize: 13, cursor: "pointer" }}
            ><Plus size={14} /> New team</button>
          )}
        </div>

        {error && <div style={{ fontSize: 12, color: "var(--danger)", marginTop: 12 }}>{error}</div>}
      </div>
    </div>
  );
}
