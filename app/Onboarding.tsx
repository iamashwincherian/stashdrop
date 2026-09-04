"use client";

import { useEffect, useState } from "react";
import { Building2, User, Check, Mail } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { completeOnboarding } from "@/lib/workspace-actions";
import { createTeamAndProject, acceptInvite } from "@/lib/workspace-client";

const SERIF = "var(--font-serif), serif";
const SANS = "var(--font-sans), system-ui, sans-serif";
const MONO = "var(--font-mono), monospace";

const inputStyle: React.CSSProperties = {
  width: "100%", border: "1px solid var(--border-default)", background: "var(--card-bg)",
  borderRadius: 8, padding: "10px 12px", fontSize: 14, color: "var(--text-primary)",
  fontFamily: SANS, outline: "none",
};

interface PendingInvite { id: string; organizationId: string; organizationName: string }

interface OnboardingProps {
  onComplete: () => void;
  // When set, the workspace is already decided (the user just switched to
  // it) — the "Personal or team" step is skipped and only the first stash
  // name is needed. organizationId is the pre-existing team to create the
  // stash under when initialScope is "organization" (otherwise a brand-new
  // team is created from the team-name field in step 0).
  initialScope?: "user" | "organization";
  organizationId?: string;
}

export default function Onboarding({ onComplete, initialScope, organizationId }: OnboardingProps) {
  const [step, setStep] = useState(0);
  const [scope, setScope] = useState<"user" | "organization" | null>(initialScope ?? null);
  const [teamName, setTeamName] = useState("");
  const [stashName, setStashName] = useState("First stash");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [invites, setInvites] = useState<PendingInvite[]>([]);
  useEffect(() => {
    void authClient.organization.listUserInvitations().then(({ data }) => {
      if (!data) return;
      setInvites(data.filter((i) => i.status === "pending").map((i) => ({ id: i.id, organizationId: i.organizationId, organizationName: i.organizationName ?? "a team" })));
    });
  }, []);

  const steps = initialScope ? ["Name your first stash"] : ["Personal or team", "Name your first stash"];

  async function joinInvite(invite: PendingInvite) {
    setBusy(true);
    setError(null);
    try {
      await acceptInvite(invite.id, invite.organizationId);
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't join that team.");
      setBusy(false);
    }
  }

  async function finish() {
    setBusy(true);
    setError(null);
    try {
      if (scope === "organization") {
        if (organizationId) {
          // Switching into an existing team — reuse it instead of creating
          // another one.
          await completeOnboarding({ scope: "organization", organizationId, projectName: stashName.trim() || "First stash", projectDescription: "", stashName });
        } else {
          await createTeamAndProject({ teamName, stashName });
        }
      } else {
        await completeOnboarding({ scope: "user", projectName: stashName.trim() || "First stash", projectDescription: "", stashName });
      }
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
      setBusy(false);
    }
  }

  const canContinue =
    step === 0
      ? initialScope
        ? scope !== null
        : scope === "user" || (scope === "organization" && teamName.trim().length > 0)
      : stashName.trim().length > 0;

  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--overlay-bg)", backdropFilter: "blur(6px)", zIndex: 100, display: "grid", placeItems: "center", padding: 20 }}>
      <div style={{
        width: "min(440px, 100%)", background: "var(--surface-solid)", border: "1px solid var(--border-default)", borderRadius: 16,
        boxShadow: "0 30px 70px rgba(var(--shadow-color),.18)", padding: "30px 28px", animation: "sd-sheet .24s cubic-bezier(.2,.8,.2,1) both",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 20 }}>
          {steps.map((_, i) => (
            <div key={i} style={{ height: 3, flex: 1, borderRadius: 2, background: i <= step ? "var(--text-primary)" : "var(--border-default)" }} />
          ))}
        </div>
        {steps.length > 1 && (
          <div style={{ fontFamily: MONO, fontSize: 10, letterSpacing: ".1em", textTransform: "uppercase", color: "var(--text-faint)", marginBottom: 6 }}>
            Step {step + 1} of {steps.length}
          </div>
        )}
        <div style={{ fontFamily: SERIF, fontSize: 24, color: "var(--text-primary)", marginBottom: 20 }}>{steps[step]}</div>

        {!initialScope && step === 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {invites.map((invite) => (
              <button
                key={invite.id}
                onClick={() => joinInvite(invite)}
                disabled={busy}
                style={{
                  display: "flex", alignItems: "center", gap: 12, textAlign: "left", cursor: busy ? "default" : "pointer",
                  border: "1px solid var(--accent-border)", background: "var(--accent-bg)", borderRadius: 10, padding: "13px 14px",
                }}
              >
                <Mail size={18} color="var(--text-secondary)" />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text-primary)" }}>Join {invite.organizationName}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 1 }}>You&apos;ve been invited to this team.</div>
                </div>
              </button>
            ))}
            {([
              { id: "user" as const, label: "Personal", desc: "Just for you.", Icon: User },
              { id: "organization" as const, label: "Team", desc: "Create a team to share it with others.", Icon: Building2 },
            ]).map((o) => (
              <button
                key={o.id}
                onClick={() => setScope(o.id)}
                style={{
                  display: "flex", alignItems: "center", gap: 12, textAlign: "left", cursor: "pointer",
                  border: `1px solid ${scope === o.id ? "var(--text-primary)" : "var(--border-default)"}`,
                  background: scope === o.id ? "var(--accent-bg)" : "var(--card-bg)", borderRadius: 10, padding: "13px 14px",
                }}
              >
                <o.Icon size={18} color="var(--text-secondary)" />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, color: "var(--text-primary)" }}>{o.label}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 1 }}>{o.desc}</div>
                </div>
                {scope === o.id && <Check size={16} color="var(--text-primary)" />}
              </button>
            ))}
            {scope === "organization" && (
              <input value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="Team name" style={inputStyle} autoFocus />
            )}
          </div>
        )}

        {step === steps.length - 1 && (
          <div>
            <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 12 }}>
              A stash is your board — everything you keep lives here. You can make more later.
            </div>
            <input value={stashName} onChange={(e) => setStashName(e.target.value)} placeholder="First stash" style={inputStyle} autoFocus />
          </div>
        )}

        {error && <div style={{ fontSize: 12.5, color: "var(--danger)", marginTop: 12 }}>{error}</div>}

        <div style={{ display: "flex", justifyContent: "space-between", marginTop: 24 }}>
          <button
            onClick={() => setStep((s) => s - 1)}
            disabled={step === 0 || busy}
            style={{
              border: "none", background: "none", color: "var(--text-muted)", fontSize: 13, cursor: step === 0 ? "default" : "pointer",
              opacity: step === 0 ? 0 : 1, padding: "8px 4px",
            }}
          >Back</button>
          <button
            onClick={() => (step < steps.length - 1 ? setStep((s) => s + 1) : finish())}
            disabled={!canContinue || busy}
            style={{
              border: "1px solid var(--text-primary)", background: "var(--text-primary)", color: "var(--card-bg)",
              borderRadius: 8, padding: "9px 18px", fontSize: 13.5, fontWeight: 500,
              cursor: canContinue && !busy ? "pointer" : "not-allowed", opacity: canContinue && !busy ? 1 : 0.45,
            }}
          >{busy ? "Setting up…" : step < steps.length - 1 ? "Continue" : "Start stashing"}</button>
        </div>
      </div>
    </div>
  );
}
