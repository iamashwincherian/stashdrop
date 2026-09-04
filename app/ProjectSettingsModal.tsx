"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { UserPlus, Trash2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { getCurrentWorkspace, updateProjectSettings, getMyRole, deleteProject } from "@/lib/workspace-actions";
import type { Project, Stash } from "@/lib/db";

const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", member: "User" };
interface MemberRow { id: string; role: string; user: { id: string; name: string; email: string } }
interface InviteRow { id: string; email: string; role: string }

const SERIF = "var(--font-serif), serif";
const SANS = "var(--font-sans), system-ui, sans-serif";
const MONO = "var(--font-mono), monospace";

const inputStyle: React.CSSProperties = {
  width: "100%", border: "1px solid var(--border-default)", background: "var(--card-bg)",
  borderRadius: 8, padding: "9px 11px", fontSize: 13.5, color: "var(--text-primary)",
  fontFamily: SANS, outline: "none",
};

export default function ProjectSettingsModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [workspace, setWorkspace] = useState<{ project: Project; stash: Stash } | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [role, setRole] = useState<string>("owner");

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteNote, setInviteNote] = useState<string | null>(null);

  const [members, setMembers] = useState<MemberRow[] | null>(null);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [removeArmedId, setRemoveArmedId] = useState<string | null>(null);

  function loadMembersAndInvites(organizationId: string) {
    void authClient.organization.listMembers({ query: { organizationId } }).then(({ data }) => {
      setMembers((data?.members as MemberRow[]) || []);
    });
    void authClient.organization.listInvitations({ query: { organizationId } }).then(({ data }) => {
      const rows = (data || []) as { id: string; email: string; role: string; status: string }[];
      setInvites(rows.filter((i) => i.status === "pending"));
    });
  }

  useEffect(() => {
    void getCurrentWorkspace().then((w) => {
      if (!w) return;
      setWorkspace(w);
      setName(w.project.name);
      setDescription(w.project.description);
      if (w.project.ownerType === "organization") loadMembersAndInvites(w.project.ownerId);
    });
    void getMyRole().then(setRole);
  }, []);

  const canManage = role === "owner" || role === "admin";

  async function save() {
    if (!workspace) return;
    setSaving(true);
    await updateProjectSettings(workspace.project.id, { name: name.trim() || workspace.project.name, description });
    setSaving(false);
    setSaved(true);
    router.refresh(); // picks up the renamed project on the canvas title
    setTimeout(() => setSaved(false), 1800);
  }

  async function invite() {
    if (!workspace || !inviteEmail.trim()) return;
    setInviting(true);
    setInviteNote(null);
    const { error } = await authClient.organization.inviteMember({
      email: inviteEmail.trim(), role: "member", organizationId: workspace.project.ownerId,
    });
    setInviting(false);
    setInviteNote(error ? error.message || "Couldn't send that invite." : `Invited ${inviteEmail.trim()}.`);
    if (!error) {
      setInviteEmail("");
      loadMembersAndInvites(workspace.project.ownerId);
    }
  }

  async function changeRole(member: MemberRow, newRole: string) {
    if (!workspace) return;
    const { error } = await authClient.organization.updateMemberRole({
      memberId: member.id, role: newRole, organizationId: workspace.project.ownerId,
    });
    if (!error) setMembers((prev) => prev && prev.map((m) => (m.id === member.id ? { ...m, role: newRole } : m)));
  }

  async function removeMember(member: MemberRow) {
    if (!workspace) return;
    if (removeArmedId !== member.id) { setRemoveArmedId(member.id); setTimeout(() => setRemoveArmedId((cur) => (cur === member.id ? null : cur)), 4000); return; }
    setRemoveArmedId(null);
    const { error } = await authClient.organization.removeMember({
      memberIdOrEmail: member.id, organizationId: workspace.project.ownerId,
    });
    if (!error) setMembers((prev) => prev && prev.filter((m) => m.id !== member.id));
  }

  async function cancelInvite(invite: InviteRow) {
    if (!workspace) return;
    const { error } = await authClient.organization.cancelInvitation({ invitationId: invite.id });
    if (!error) setInvites((prev) => prev.filter((i) => i.id !== invite.id));
  }

  // Invitations pin their role at invite time — better-auth has no way to
  // edit one in place. Changing the role therefore re-sends the invite with
  // the new role (cancel + re-invite); the pending row disappears and the
  // fresh one takes its place.
  async function changeInviteRole(invite: InviteRow, newRole: string) {
    if (!workspace || invite.role === newRole) return;
    await authClient.organization.cancelInvitation({ invitationId: invite.id });
    const { error } = await authClient.organization.inviteMember({
      email: invite.email, role: newRole as "member" | "admin", organizationId: workspace.project.ownerId,
    });
    loadMembersAndInvites(workspace.project.ownerId);
    setInviteNote(error ? error.message || "Couldn't update that invite." : `Role updated for ${invite.email}.`);
  }

  async function handleDeleteProject() {
    if (!workspace) return;
    if (!deleteArmed) { setDeleteArmed(true); setTimeout(() => setDeleteArmed(false), 4000); return; }
    setDeleting(true);
    await deleteProject(workspace.project.id);
    router.refresh();
    onClose();
  }

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "var(--overlay-bg)", backdropFilter: "blur(4px)", zIndex: 70, display: "grid", placeItems: "center", padding: 20 }}>
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(440px, 100%)", background: "var(--surface-solid)", border: "1px solid var(--border-default)", borderRadius: 14,
          boxShadow: "0 24px 60px rgba(var(--shadow-color),.16)", padding: "24px 24px 22px", animation: "sd-sheet .22s cubic-bezier(.2,.8,.2,1) both",
        }}
      >
        <div style={{ fontFamily: SERIF, fontSize: 21, color: "var(--text-primary)", marginBottom: 18 }}>Stash settings</div>

        {!workspace ? (
          <div style={{ fontSize: 13, color: "var(--text-faint)" }}>Loading…</div>
        ) : (
          <>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-faint)", marginBottom: 5 }}>Name</div>
                <input value={name} onChange={(e) => setName(e.target.value)} style={inputStyle} />
              </div>
              <div>
                <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-faint)", marginBottom: 5 }}>Description</div>
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="What's this stash for?" style={{ ...inputStyle, resize: "vertical" }} />
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
              <button
                onClick={save}
                disabled={saving}
                style={{
                  border: "1px solid var(--text-primary)", background: "var(--text-primary)", color: "var(--card-bg)",
                  borderRadius: 7, padding: "7px 14px", fontSize: 12.5, fontWeight: 500, cursor: saving ? "default" : "pointer", opacity: saving ? 0.6 : 1,
                }}
              >{saving ? "Saving…" : "Save"}</button>
              {saved && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Saved.</span>}
            </div>

            <div style={{ borderTop: "1px solid var(--border-subtle)", marginTop: 20, paddingTop: 18 }}>
              {workspace.project.ownerType === "organization" ? (
                <>
                  {canManage && (
                    <>
                      <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)", marginBottom: 8 }}>Invite people</div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <input
                          value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="email@example.com" type="email"
                          style={{ ...inputStyle, flex: 1 }}
                        />
                        <button
                          onClick={invite}
                          disabled={inviting || !inviteEmail.trim()}
                          className="sd-hover-bg"
                          style={{
                            display: "flex", alignItems: "center", gap: 6, border: "1px solid var(--border-default)", background: "var(--card-bg)",
                            color: "var(--text-secondary)", borderRadius: 7, padding: "0 12px", fontSize: 12.5, cursor: inviting ? "default" : "pointer",
                            opacity: inviting || !inviteEmail.trim() ? 0.6 : 1,
                          }}
                        ><UserPlus size={13} /> Invite</button>
                      </div>
                      {inviteNote && <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 7 }}>{inviteNote}</div>}
                    </>
                  )}

                  <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)", margin: "18px 0 8px" }}>Members</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {members === null && <div style={{ fontSize: 12, color: "var(--text-faint)" }}>Loading…</div>}
                    {members?.map((m) => (
                      <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.user.name}</div>
                          <div style={{ fontSize: 11, color: "var(--text-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.user.email}</div>
                        </div>
                        {canManage && m.role !== "owner" ? (
                          <select
                            value={m.role}
                            onChange={(e) => changeRole(m, e.target.value)}
                            style={{ border: "1px solid var(--border-default)", background: "var(--card-bg)", color: "var(--text-secondary)", borderRadius: 6, padding: "4px 6px", fontSize: 12 }}
                          >
                            <option value="member">User</option>
                            <option value="admin">Admin</option>
                          </select>
                        ) : (
                          <span style={{ fontSize: 11.5, color: "var(--text-faint)", padding: "4px 6px" }}>{ROLE_LABEL[m.role] || m.role}</span>
                        )}
                        {canManage && m.role !== "owner" && (
                          removeArmedId === m.id ? (
                            <button
                              onClick={() => removeMember(m)}
                              className="sd-hover-bg"
                              style={{ border: "1px solid var(--danger)", background: "var(--danger-bg)", color: "var(--danger)", borderRadius: 6, padding: "4px 8px", fontSize: 11.5, cursor: "pointer", whiteSpace: "nowrap" }}
                            >Confirm?</button>
                          ) : (
                            <button
                              onClick={() => removeMember(m)}
                              title="Remove from team"
                              className="sd-hover-bg"
                              style={{ border: "none", background: "none", color: "var(--text-faint)", borderRadius: 6, padding: 4, cursor: "pointer", display: "flex" }}
                            ><Trash2 size={13} /></button>
                          )
                        )}
                      </div>
                    ))}
                    {invites.map((invite) => (
                      <div key={invite.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, color: "var(--text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {invite.email} <span style={{ color: "var(--text-faint)" }}>(invited)</span>
                          </div>
                        </div>
                        <select
                          value={invite.role}
                          onChange={(e) => changeInviteRole(invite, e.target.value)}
                          style={{ border: "1px solid var(--border-default)", background: "var(--card-bg)", color: "var(--text-secondary)", borderRadius: 6, padding: "4px 6px", fontSize: 12, cursor: "pointer" }}
                        >
                          <option value="member">User</option>
                          <option value="admin">Admin</option>
                        </select>
                        {canManage && (
                          <button
                            onClick={() => cancelInvite(invite)}
                            title="Cancel invite"
                            className="sd-hover-bg"
                            style={{ border: "none", background: "none", color: "var(--text-faint)", borderRadius: 6, padding: 4, cursor: "pointer", display: "flex" }}
                          ><Trash2 size={13} /></button>
                        )}
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 12.5, color: "var(--text-faint)" }}>Invites are available on team workspaces. Create a team to invite people.</div>
              )}
            </div>

            {role === "owner" && (
              <div style={{ borderTop: "1px solid var(--border-subtle)", marginTop: 18, paddingTop: 16 }}>
                <button
                  onClick={handleDeleteProject}
                  disabled={deleting}
                  style={{
                    border: `1px solid ${deleteArmed ? "var(--danger)" : "var(--border-strong)"}`,
                    background: deleteArmed ? "var(--danger-bg)" : "none",
                    color: deleteArmed ? "var(--danger)" : "var(--text-secondary)",
                    borderRadius: 7, padding: "6px 13px", fontSize: 12.5, cursor: "pointer",
                  }}
                >{deleteArmed ? "Confirm delete stash?" : "Delete stash"}</button>
                <div style={{ fontSize: 11.5, color: "var(--text-fainter)", marginTop: 7 }}>Removes every bookmark in this stash and starts a fresh empty one.</div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
