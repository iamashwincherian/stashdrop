"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Settings, LogOut } from "lucide-react";
import { authClient } from "@/lib/auth-client";

const SERIF = "var(--font-serif), serif";
const SANS = "var(--font-sans), system-ui, sans-serif";
const MONO = "var(--font-mono), monospace";

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
}

export default function UserMenu({ user }: { user: { name: string; email: string } }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [name, setName] = useState(user.name);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  async function saveName() {
    setSaving(true);
    await authClient.updateUser({ name: name.trim() || user.name });
    setSaving(false);
    setSaved(true);
    router.refresh();
    setTimeout(() => setSaved(false), 1800);
  }

  async function logout() {
    await authClient.signOut();
    router.push("/sign-in");
    router.refresh();
  }

  return (
    <div style={{ position: "relative" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title={user.name}
        aria-label="Account menu"
        style={{
          width: 26, height: 26, borderRadius: "50%", background: "var(--hover-bg)", border: "1px solid var(--border-strong)",
          display: "grid", placeItems: "center", fontFamily: MONO, fontSize: 9.5, color: "var(--text-muted)", cursor: "pointer",
        }}
      >{initials(user.name)}</button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 60 }} />
          <div style={{
            position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 61, minWidth: 200,
            background: "var(--card-bg)", border: "1px solid var(--border-default)", borderRadius: 10,
            boxShadow: "0 10px 34px rgba(var(--shadow-color),.16)", overflow: "hidden", padding: 4,
          }}>
            <div style={{ padding: "8px 10px 9px", borderBottom: "1px solid var(--border-subtle)", marginBottom: 4 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-primary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user.name}</div>
              <div style={{ fontSize: 11.5, color: "var(--text-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", marginTop: 1 }}>{user.email}</div>
            </div>
            <button
              onClick={() => { setAccountOpen(true); setOpen(false); }}
              className="sd-hover-bg"
              style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", border: "none", background: "none", color: "var(--text-secondary)", borderRadius: 6, padding: "7px 10px", fontSize: 12.5, cursor: "pointer", textAlign: "left" }}
            ><Settings size={13} /> Settings</button>
            <button
              onClick={logout}
              className="sd-hover-bg"
              style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", border: "none", background: "none", color: "var(--danger)", borderRadius: 6, padding: "7px 10px", fontSize: 12.5, cursor: "pointer", textAlign: "left" }}
            ><LogOut size={13} /> Log out</button>
          </div>
        </>
      )}

      {accountOpen && (
        <div onClick={() => setAccountOpen(false)} style={{ position: "fixed", inset: 0, background: "var(--overlay-bg)", backdropFilter: "blur(4px)", zIndex: 70, display: "grid", placeItems: "center", padding: 20 }}>
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(360px, 100%)", background: "var(--surface-solid)", border: "1px solid var(--border-default)", borderRadius: 14,
              boxShadow: "0 24px 60px rgba(var(--shadow-color),.16)", padding: "24px 24px 22px", animation: "sd-sheet .22s cubic-bezier(.2,.8,.2,1) both",
            }}
          >
            <div style={{ fontFamily: SERIF, fontSize: 21, color: "var(--text-primary)", marginBottom: 18 }}>Account</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-faint)", marginBottom: 5 }}>Name</div>
                <input
                  value={name} onChange={(e) => setName(e.target.value)}
                  style={{ width: "100%", border: "1px solid var(--border-default)", background: "var(--card-bg)", borderRadius: 8, padding: "9px 11px", fontSize: 13.5, color: "var(--text-primary)", fontFamily: SANS, outline: "none" }}
                />
              </div>
              <div>
                <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--text-faint)", marginBottom: 5 }}>Email</div>
                <div style={{ fontSize: 13.5, color: "var(--text-muted)", padding: "9px 11px", border: "1px solid var(--border-subtle)", borderRadius: 8, background: "var(--hover-bg)" }}>{user.email}</div>
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 16 }}>
              <button
                onClick={saveName}
                disabled={saving}
                style={{
                  border: "1px solid var(--text-primary)", background: "var(--text-primary)", color: "var(--card-bg)",
                  borderRadius: 7, padding: "7px 14px", fontSize: 12.5, fontWeight: 500, cursor: saving ? "default" : "pointer", opacity: saving ? 0.6 : 1,
                }}
              >{saving ? "Saving…" : "Save"}</button>
              {saved && <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Saved.</span>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
