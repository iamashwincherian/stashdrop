"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { UserPlus, Trash2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { getCurrentStash, updateStashSettings, getMyRole, deleteStash } from "@/lib/workspace-actions";
import type { Stash } from "@/lib/db";
import { initials } from "./UserMenu";

const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", member: "User" };
interface MemberRow { id: string; role: string; user: { id: string; name: string; email: string } }
interface InviteRow { id: string; email: string; role: string }

const TABS = [
  { id: "account", label: "Account" },
  { id: "people", label: "People" },
  { id: "other", label: "Other" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const fieldClass =
  "mt-4 w-full max-w-[420px] rounded-lg border border-default bg-hover-alt px-3 py-2.5 text-[13.5px] font-sans text-primary outline-none";
const areaClass = `${fieldClass} resize-y leading-[1.5]`;
const sectionClass = (last?: boolean): string => last ? "pt-8" : "border-b border-subtle py-8";
const sectionTitleClass = "text-[14.5px] font-medium text-primary";
const sectionSubClass = "mt-[5px] text-[13.5px] text-muted";
const ghostButtonClass = "cursor-pointer rounded-lg border border-strong bg-card px-[15px] py-[9px] text-[13px] text-secondary";
const primaryButtonClass = (busy: boolean): string =>
  `rounded-[7px] border border-primary bg-primary px-3.5 py-[7px] text-[12.5px] font-medium text-card ${busy ? "cursor-default opacity-60" : "cursor-pointer"}`;

export default function SettingsModal({ onClose, user, paperGrid, onSetPaperGrid }: {
  onClose: () => void;
  user: { name: string; email: string };
  paperGrid: boolean;
  onSetPaperGrid: (on: boolean) => void;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<TabId>("account");
  const [stash, setStash] = useState<Stash | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [role, setRole] = useState<string>("owner");

  const [displayName, setDisplayName] = useState(user.name);
  const [nameSaving, setNameSaving] = useState(false);
  const [nameSaved, setNameSaved] = useState(false);

  const [changingPassword, setChangingPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newPassword2, setNewPassword2] = useState("");
  const [pwError, setPwError] = useState<string | null>(null);
  const [pwBusy, setPwBusy] = useState(false);
  const [pwDone, setPwDone] = useState(false);

  const [signOutBusy, setSignOutBusy] = useState(false);
  const [signOutDone, setSignOutDone] = useState(false);

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
    void getCurrentStash().then((s) => {
      if (!s) return;
      setStash(s);
      setName(s.name);
      setDescription(s.description);
      if (s.ownerType === "organization") loadMembersAndInvites(s.ownerId);
    });
    void getMyRole().then(setRole);
  }, []);

  const canManage = role === "owner" || role === "admin";

  async function save() {
    if (!stash) return;
    setSaving(true);
    await updateStashSettings(stash.id, { name: name.trim() || stash.name, description });
    setSaving(false);
    setSaved(true);
    router.refresh(); // picks up the renamed stash on the canvas title
    setTimeout(() => setSaved(false), 1800);
  }

  async function saveDisplayName() {
    setNameSaving(true);
    await authClient.updateUser({ name: displayName.trim() || user.name });
    setNameSaving(false);
    setNameSaved(true);
    router.refresh();
    setTimeout(() => setNameSaved(false), 1800);
  }

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    if (newPassword.length < 8) { setPwError("Passwords need at least 8 characters."); return; }
    if (newPassword !== newPassword2) { setPwError("Those two passwords don't match."); return; }
    setPwError(null);
    setPwBusy(true);
    const { error } = await authClient.changePassword({ currentPassword, newPassword });
    setPwBusy(false);
    if (error) { setPwError(error.message || "Couldn't change your password."); return; }
    setCurrentPassword(""); setNewPassword(""); setNewPassword2("");
    setPwDone(true);
    setTimeout(() => { setPwDone(false); setChangingPassword(false); }, 1800);
  }

  async function signOutOtherSessions() {
    setSignOutBusy(true);
    await authClient.revokeOtherSessions();
    setSignOutBusy(false);
    setSignOutDone(true);
    setTimeout(() => setSignOutDone(false), 2600);
  }

  async function invite() {
    if (!stash || !inviteEmail.trim()) return;
    setInviting(true);
    setInviteNote(null);
    const { error } = await authClient.organization.inviteMember({
      email: inviteEmail.trim(), role: "member", organizationId: stash.ownerId,
    });
    setInviting(false);
    setInviteNote(error ? error.message || "Couldn't send that invite." : `Invited ${inviteEmail.trim()}.`);
    if (!error) {
      setInviteEmail("");
      loadMembersAndInvites(stash.ownerId);
    }
  }

  async function changeRole(member: MemberRow, newRole: string) {
    if (!stash) return;
    const { error } = await authClient.organization.updateMemberRole({
      memberId: member.id, role: newRole, organizationId: stash.ownerId,
    });
    if (!error) setMembers((prev) => prev && prev.map((m) => (m.id === member.id ? { ...m, role: newRole } : m)));
  }

  async function removeMember(member: MemberRow) {
    if (!stash) return;
    if (removeArmedId !== member.id) { setRemoveArmedId(member.id); setTimeout(() => setRemoveArmedId((cur) => (cur === member.id ? null : cur)), 4000); return; }
    setRemoveArmedId(null);
    const { error } = await authClient.organization.removeMember({
      memberIdOrEmail: member.id, organizationId: stash.ownerId,
    });
    if (!error) setMembers((prev) => prev && prev.filter((m) => m.id !== member.id));
  }

  async function cancelInvite(invite: InviteRow) {
    if (!stash) return;
    const { error } = await authClient.organization.cancelInvitation({ invitationId: invite.id });
    if (!error) setInvites((prev) => prev.filter((i) => i.id !== invite.id));
  }

  // Invitations pin their role at invite time — better-auth has no way to
  // edit one in place. Changing the role therefore re-sends the invite with
  // the new role (cancel + re-invite); the pending row disappears and the
  // fresh one takes its place.
  async function changeInviteRole(invite: InviteRow, newRole: string) {
    if (!stash || invite.role === newRole) return;
    await authClient.organization.cancelInvitation({ invitationId: invite.id });
    const { error } = await authClient.organization.inviteMember({
      email: invite.email, role: newRole as "member" | "admin", organizationId: stash.ownerId,
    });
    loadMembersAndInvites(stash.ownerId);
    setInviteNote(error ? error.message || "Couldn't update that invite." : `Role updated for ${invite.email}.`);
  }

  async function handleDeleteStash() {
    if (!stash) return;
    if (!deleteArmed) { setDeleteArmed(true); setTimeout(() => setDeleteArmed(false), 4000); return; }
    setDeleting(true);
    await deleteStash(stash.id);
    router.refresh();
    onClose();
  }

  return (
    <div onClick={onClose} className="fixed inset-0 z-70 flex items-start justify-center overflow-y-auto bg-overlay px-6 pb-6 pt-[9vh] backdrop-blur-[4px]">
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[min(720px,100%)] max-h-[82vh] animate-sheet overflow-y-auto rounded-[14px] border border-default bg-card shadow-[0_24px_70px_rgba(var(--shadow-color),.14)]"
      >
        <div className="relative px-14 pt-[38px]">
          <button
            onClick={onClose}
            className="absolute right-[18px] top-[18px] size-[26px] cursor-pointer rounded-[7px] border border-default bg-surface font-mono text-[11px] text-muted hover:border-primary hover:text-primary"
          >✕</button>
          <div className="font-serif text-[40px] leading-[1.05] tracking-[-.015em] text-primary">Settings</div>
          <div className="mt-[26px] flex gap-[26px] border-b border-default">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`-mb-px cursor-pointer border-none bg-transparent pb-[11px] text-[13.5px] hover:text-primary ${tab === t.id ? "border-b-2 border-primary font-medium text-primary" : "border-b-2 border-transparent font-normal text-faint"}`}
              >{t.label}</button>
            ))}
          </div>
        </div>

        {!stash ? (
          <div className="px-14 pb-11 pt-[38px] text-[13px] text-faint">Loading…</div>
        ) : (
          <>
            {tab === "account" && (
              <div className="px-14 pb-11">
                <div className={sectionClass()}>
                  <div className={sectionTitleClass}>Board mark</div>
                  <div className={sectionSubClass}>Shown in the workspace switcher.</div>
                  <div className="mt-[18px] grid size-[68px] place-items-center rounded-[14px] bg-primary font-mono text-[17px] tracking-[.06em] text-paper">
                    {initials(name || "Stashdrop")}
                  </div>
                </div>

                <div className={sectionClass()}>
                  <div className={sectionTitleClass}>Stash name</div>
                  <div className={sectionSubClass}>Visible to you and everyone invited to this stash.</div>
                  <input value={name} onChange={(e) => setName(e.target.value)} className={fieldClass} />
                </div>

                <div className={sectionClass()}>
                  <div className={sectionTitleClass}>Description</div>
                  <div className={sectionSubClass}>Sits under the title on the desk.</div>
                  <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="What's this stash for?" className={areaClass} />
                  <div className="mt-3.5 flex items-center gap-2.5">
                    <button onClick={save} disabled={saving} className={primaryButtonClass(saving)}>{saving ? "Saving…" : "Save"}</button>
                    {saved && <span className="text-xs text-muted">Saved.</span>}
                  </div>
                </div>

                <div className={sectionClass()}>
                  <div className={sectionTitleClass}>Your name</div>
                  <div className={sectionSubClass}>Shown to people you share a stash with.</div>
                  <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={fieldClass} />
                  <div className="mt-3.5 flex items-center gap-2.5">
                    <button onClick={saveDisplayName} disabled={nameSaving} className={primaryButtonClass(nameSaving)}>{nameSaving ? "Saving…" : "Save"}</button>
                    {nameSaved && <span className="text-xs text-muted">Saved.</span>}
                  </div>
                </div>

                <div className={sectionClass()}>
                  <div className={sectionTitleClass}>Account email</div>
                  <div className={sectionSubClass}>The address you sign in with and get invites at.</div>
                  <div className={`${fieldClass} text-muted`}>{user.email}</div>
                </div>

                <div className={sectionClass(true)}>
                  <div className={sectionTitleClass}>Password &amp; security</div>
                  <div className={sectionSubClass}>Change your password, or sign out everywhere else.</div>
                  <div className="mt-4 flex flex-wrap gap-[9px]">
                    <button onClick={() => { setChangingPassword((v) => !v); setPwError(null); }} className={`${ghostButtonClass} hover:border-primary`}>Change password</button>
                    <button onClick={signOutOtherSessions} disabled={signOutBusy} className={`${ghostButtonClass} bg-transparent hover:border-primary ${signOutBusy ? "opacity-60" : ""}`}>
                      {signOutBusy ? "Signing out…" : signOutDone ? "Done." : "Sign out other sessions"}
                    </button>
                  </div>

                  {changingPassword && (
                    <form onSubmit={changePassword} className="mt-4 flex max-w-[420px] flex-col gap-2.5">
                      <input value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} placeholder="Current password" type="password" required autoComplete="current-password" className={`${fieldClass} mt-0`} />
                      <input value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="New password" type="password" minLength={8} required autoComplete="new-password" className={`${fieldClass} mt-0`} />
                      <input value={newPassword2} onChange={(e) => setNewPassword2(e.target.value)} placeholder="Repeat new password" type="password" required autoComplete="new-password" className={`${fieldClass} mt-0`} />
                      {pwError && <div className="text-[12.5px] text-danger">{pwError}</div>}
                      <div className="flex items-center gap-2.5">
                        <button type="submit" disabled={pwBusy} className={primaryButtonClass(pwBusy)}>{pwBusy ? "Saving…" : "Update password"}</button>
                        {pwDone && <span className="text-xs text-muted">Password changed.</span>}
                      </div>
                    </form>
                  )}
                </div>
              </div>
            )}

            {tab === "people" && (
              <div className="px-14 pb-11">
                {stash.ownerType === "organization" ? (
                  <>
                    <div className={sectionClass()}>
                      <div className={sectionTitleClass}>People</div>
                      <div className={sectionSubClass}>Everyone who can keep things in this stash.</div>
                      <div className="mt-4 flex flex-col gap-1.5">
                        {members === null && <div className="text-xs text-faint">Loading…</div>}
                        {members?.map((m) => (
                          <div key={m.id} className="flex items-center gap-3 border-t border-subtle py-3">
                            <div className="grid size-[30px] flex-none place-items-center rounded-full border border-strong bg-hover font-mono text-[10px] text-muted">
                              {initials(m.user.name)}
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[13.5px] text-primary">{m.user.name}</div>
                              <div className="mt-0.5 truncate font-mono text-[10px] text-faint">{m.user.email}</div>
                            </div>
                            {canManage && m.role !== "owner" ? (
                              <select
                                value={m.role}
                                onChange={(e) => changeRole(m, e.target.value)}
                                className="cursor-pointer rounded-md border border-default bg-card px-1.5 py-1 text-xs text-secondary"
                              >
                                <option value="member">User</option>
                                <option value="admin">Admin</option>
                              </select>
                            ) : (
                              <span className="font-mono text-[9.5px] uppercase tracking-[.08em] text-fainter">{ROLE_LABEL[m.role] || m.role}</span>
                            )}
                            {canManage && m.role !== "owner" && (
                              removeArmedId === m.id ? (
                                <button
                                  onClick={() => removeMember(m)}
                                  className="cursor-pointer whitespace-nowrap rounded-md border border-danger bg-danger-bg px-2 py-1 text-[11.5px] text-danger hover:bg-hover hover:text-primary"
                                >Confirm?</button>
                              ) : (
                                <button
                                  onClick={() => removeMember(m)}
                                  title="Remove from team"
                                  className="flex cursor-pointer rounded-md border-none bg-transparent p-1 text-faint hover:bg-hover hover:text-primary"
                                ><Trash2 size={13} /></button>
                              )
                            )}
                          </div>
                        ))}
                        {invites.map((invite) => (
                          <div key={invite.id} className="flex items-center gap-3 border-t border-subtle py-3">
                            <div className="min-w-0 flex-1">
                              <div className="truncate text-[13.5px] text-muted">
                                {invite.email} <span className="text-faint">(invited)</span>
                              </div>
                            </div>
                            <select
                              value={invite.role}
                              onChange={(e) => changeInviteRole(invite, e.target.value)}
                              className="cursor-pointer rounded-md border border-default bg-card px-1.5 py-1 text-xs text-secondary"
                            >
                              <option value="member">User</option>
                              <option value="admin">Admin</option>
                            </select>
                            {canManage && (
                              <button
                                onClick={() => cancelInvite(invite)}
                                title="Cancel invite"
                                className="flex cursor-pointer rounded-md border-none bg-transparent p-1 text-faint hover:bg-hover hover:text-primary"
                              ><Trash2 size={13} /></button>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>

                    {canManage && (
                      <div className={sectionClass(true)}>
                        <div className={sectionTitleClass}>Invite someone</div>
                        <div className={sectionSubClass}>They get an email and land straight on this desk.</div>
                        <div className="flex max-w-[460px] items-end gap-2.5">
                          <input value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="email@example.com" type="email" className={`${fieldClass} flex-1`} />
                          <button
                            onClick={invite}
                            disabled={inviting || !inviteEmail.trim()}
                            className={`mt-4 flex flex-none items-center gap-1.5 rounded-lg border border-primary bg-primary px-4 py-2.5 text-[13px] text-card ${inviting || !inviteEmail.trim() ? "cursor-not-allowed opacity-45" : "cursor-pointer"}`}
                          ><UserPlus size={13} /> Invite</button>
                        </div>
                        {inviteNote && <div className="mt-3 font-serif text-[13.5px] italic text-muted">{inviteNote}</div>}
                      </div>
                    )}
                  </>
                ) : (
                  <div className={sectionClass(true)}>
                    <div className="text-[13px] text-faint">Invites are available on team workspaces. Create a team to invite people.</div>
                  </div>
                )}
              </div>
            )}

            {tab === "other" && (
              <div className="px-14 pb-11">
                <div className={sectionClass()}>
                  <div className={sectionTitleClass}>Paper grid</div>
                  <div className={sectionSubClass}>The dotted grid under the desk. Off gives you plain paper.</div>
                  <button
                    onClick={() => onSetPaperGrid(!paperGrid)}
                    className={`${ghostButtonClass} mt-4 font-mono text-[10px] uppercase tracking-[.1em] hover:border-primary`}
                  >{paperGrid ? "On" : "Off"}</button>
                </div>

                {role === "owner" && (
                  <div className={sectionClass(true)}>
                    <div className="text-[14.5px] font-medium text-danger">Delete this stash</div>
                    <div className={sectionSubClass}>Everything on the desk goes with it. This cannot be undone.</div>
                    <button
                      onClick={handleDeleteStash}
                      disabled={deleting}
                      className={`mt-4 cursor-pointer rounded-lg border border-danger px-[15px] py-[9px] text-[13px] ${deleteArmed ? "bg-danger text-card" : "bg-danger-bg text-danger"}`}
                    >{deleteArmed ? "Confirm delete stash?" : "Delete stash"}</button>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}