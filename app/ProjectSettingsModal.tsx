"use client";

import { useEffect, useState } from "react";
import { UserPlus } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { getCurrentWorkspace, updateProjectSettings } from "@/lib/workspace-actions";
import type { Project, Stash } from "@/lib/db";

const SERIF = "var(--font-serif), serif";
const SANS = "var(--font-sans), system-ui, sans-serif";
const MONO = "var(--font-mono), monospace";

const inputStyle: React.CSSProperties = {
  width: "100%", border: "1px solid var(--border-default)", background: "var(--card-bg)",
  borderRadius: 8, padding: "9px 11px", fontSize: 13.5, color: "var(--text-primary)",
  fontFamily: SANS, outline: "none",
};

export default function ProjectSettingsModal({ onClose }: { onClose: () => void }) {
  const [workspace, setWorkspace] = useState<{ project: Project; stash: Stash } | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [inviteNote, setInviteNote] = useState<string | null>(null);

  useEffect(() => {
    void getCurrentWorkspace().then((w) => {
      if (!w) return;
      setWorkspace(w);
      setName(w.project.name);
      setDescription(w.project.description);
    });
  }, []);

  async function save() {
    if (!workspace) return;
    setSaving(true);
    await updateProjectSettings(workspace.project.id, { name: name.trim() || workspace.project.name, description });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 1800);
  }

  // Dummy for now: creates a real pending invitation row (better-auth), but
  // there's no accept-invite flow yet, so nothing ever consumes it.
  async function invite() {
    if (!workspace || !inviteEmail.trim()) return;
    setInviting(true);
    setInviteNote(null);
    const { error } = await authClient.organization.inviteMember({
      email: inviteEmail.trim(), role: "member", organizationId: workspace.project.ownerId,
    });
    setInviting(false);
    setInviteNote(error ? error.message || "Couldn't send that invite." : `Invited ${inviteEmail.trim()}.`);
    if (!error) setInviteEmail("");
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
        <div style={{ fontFamily: SERIF, fontSize: 21, color: "var(--text-primary)", marginBottom: 18 }}>Project settings</div>

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
                <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="What's this project for?" style={{ ...inputStyle, resize: "vertical" }} />
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
                  <div style={{ fontSize: 11.5, color: "var(--text-fainter)", marginTop: 7 }}>Invites don&apos;t send email yet — this just records the invite.</div>
                </>
              ) : (
                <div style={{ fontSize: 12.5, color: "var(--text-faint)" }}>Invites are available on team projects. Create a team to invite people.</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
