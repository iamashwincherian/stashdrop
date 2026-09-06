"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, User, Check, Mail, Plus } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { acceptInvite, declineInvite, createTeamAndStash } from "@/lib/workspace-client";

interface Org { id: string; name: string }
interface Invite { id: string; organizationId: string; organizationName: string }

const rowClass = (active: boolean): string =>
  `flex w-full cursor-pointer items-center gap-3 rounded-[10px] border px-[13px] py-[11px] text-left ${active ? "border-primary bg-accent-bg" : "border-default bg-card"}`;

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
      await createTeamAndStash({ teamName, stashName });
      onClose();
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create that team.");
      setBusy(false);
    }
  }

  return (
    <div onClick={onClose} className="fixed inset-0 z-80 grid place-items-center bg-overlay p-5 backdrop-blur-[4px]">
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[min(400px,100%)] animate-sheet rounded-[14px] border border-default bg-surface-solid px-[22px] pb-5 pt-[22px] shadow-[0_24px_60px_rgba(var(--shadow-color),.16)]"
      >
        <div className="mb-4 font-serif text-[20px] text-primary">Switch workspace</div>

        <div className="flex flex-col gap-2">
          <button onClick={selectPersonal} disabled={busy} className={rowClass(currentOrganizationId === null)}>
            <User size={16} className="text-secondary" />
            <span className="flex-1 text-[13.5px] text-primary">Personal</span>
            {currentOrganizationId === null && <Check size={15} className="text-primary" />}
          </button>
          {orgs === null && <div className="px-0.5 py-1 text-xs text-faint">Loading…</div>}
          {orgs?.map((o) => (
            <button key={o.id} onClick={() => selectOrg(o.id)} disabled={busy} className={rowClass(currentOrganizationId === o.id)}>
              <Building2 size={16} className="text-secondary" />
              <span className="flex-1 text-[13.5px] text-primary">{o.name}</span>
              {currentOrganizationId === o.id && <Check size={15} className="text-primary" />}
            </button>
          ))}
        </div>

        {invites.length > 0 && (
          <div className="mt-4 border-t border-subtle pt-3.5">
            <div className="mb-2 font-mono text-[10px] uppercase tracking-[.08em] text-faint">Pending invites</div>
            <div className="flex flex-col gap-2">
              {invites.map((invite) => (
                <div key={invite.id} className="flex items-center gap-2.5 rounded-[10px] border border-accent-border bg-accent-bg px-3 py-2.5">
                  <Mail size={15} className="text-secondary" />
                  <span className="flex-1 text-[13px] text-primary">{invite.organizationName}</span>
                  <button onClick={() => accept(invite)} disabled={busy} className="cursor-pointer rounded-md border border-primary bg-primary px-2.5 py-1 text-xs text-card">Accept</button>
                  <button onClick={() => decline(invite)} disabled={busy} className="cursor-pointer rounded-md border border-strong bg-transparent px-2.5 py-1 text-xs text-secondary">Decline</button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="mt-4 border-t border-subtle pt-3.5">
          {creating ? (
            <div className="flex flex-col gap-2">
              <input
                value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="Team name" autoFocus
                className="rounded-lg border border-default bg-card px-2.5 py-2 text-[13px] font-sans text-primary outline-none"
              />
              <div className="flex gap-2">
                <input
                  value={stashName} onChange={(e) => setStashName(e.target.value)} placeholder="First stash"
                  className="flex-1 rounded-lg border border-default bg-card px-2.5 py-2 text-[13px] font-sans text-primary outline-none"
                />
                <button onClick={createTeam} disabled={busy || !teamName.trim() || !stashName.trim()} className="cursor-pointer rounded-lg border border-primary bg-primary px-3 text-[12.5px] text-card">Create</button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setCreating(true)}
              className="flex cursor-pointer items-center gap-2 rounded-md border-none bg-transparent px-1 py-1.5 text-[13px] text-muted hover:bg-hover hover:text-primary"
            ><Plus size={14} /> New team</button>
          )}
        </div>

        {error && <div className="mt-3 text-xs text-danger">{error}</div>}
      </div>
    </div>
  );
}