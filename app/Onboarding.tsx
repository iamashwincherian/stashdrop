"use client";

import { useEffect, useState } from "react";
import { Building2, User, Check, Mail } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { completeOnboarding } from "@/lib/workspace-actions";
import { createTeamAndStash, acceptInvite } from "@/lib/workspace-client";

const inputClass =
  "w-full rounded-lg border border-default bg-card px-3 py-2.5 text-sm text-primary font-sans outline-none";

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
          await completeOnboarding({ scope: "organization", organizationId, stashName: stashName.trim() || "First stash" });
        } else {
          await createTeamAndStash({ teamName, stashName });
        }
      } else {
        await completeOnboarding({ scope: "user", stashName: stashName.trim() || "First stash" });
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
    <div className="fixed inset-0 z-100 grid place-items-center bg-overlay p-5 backdrop-blur-[6px]">
      <div className="w-[min(440px,100%)] animate-sheet rounded-[16px] border border-default bg-surface-solid px-7 py-[30px] shadow-[0_30px_70px_rgba(var(--shadow-color),.18)] [animation-duration:.24s]">
        <div className="mb-5 flex items-center gap-1.5">
          {steps.map((_, i) => (
            <div key={i} className={`h-[3px] flex-1 rounded-sm ${i <= step ? "bg-primary" : "bg-default"}`} />
          ))}
        </div>
        {steps.length > 1 && (
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[.1em] text-faint">
            Step {step + 1} of {steps.length}
          </div>
        )}
        <div className="mb-5 font-serif text-2xl text-primary">{steps[step]}</div>

        {!initialScope && step === 0 && (
          <div className="flex flex-col gap-2.5">
            {invites.map((invite) => (
              <button
                key={invite.id}
                onClick={() => joinInvite(invite)}
                disabled={busy}
                className={`flex cursor-pointer items-center gap-3 rounded-[10px] border border-accent-border bg-accent-bg px-3.5 py-[13px] text-left ${busy ? "cursor-default" : "cursor-pointer"}`}
              >
                <Mail size={18} className="text-secondary" />
                <div className="flex-1">
                  <div className="text-sm font-medium text-primary">Join {invite.organizationName}</div>
                  <div className="mt-px text-xs text-muted">You&apos;ve been invited to this team.</div>
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
                className={`flex cursor-pointer items-center gap-3 rounded-[10px] border px-3.5 py-[13px] text-left ${scope === o.id ? "border-primary bg-accent-bg" : "border-default bg-card"}`}
              >
                <o.Icon size={18} className="text-secondary" />
                <div className="flex-1">
                  <div className="text-sm font-medium text-primary">{o.label}</div>
                  <div className="mt-px text-xs text-muted">{o.desc}</div>
                </div>
                {scope === o.id && <Check size={16} className="text-primary" />}
              </button>
            ))}
            {scope === "organization" && (
              <input value={teamName} onChange={(e) => setTeamName(e.target.value)} placeholder="Team name" className={inputClass} autoFocus />
            )}
          </div>
        )}

        {step === steps.length - 1 && (
          <div>
            <div className="mb-3 text-[13px] text-muted">
              A stash is your board — everything you keep lives here. You can make more later.
            </div>
            <input value={stashName} onChange={(e) => setStashName(e.target.value)} placeholder="First stash" className={inputClass} autoFocus />
          </div>
        )}

        {error && <div className="mt-3 text-[12.5px] text-danger">{error}</div>}

        <div className="mt-6 flex justify-between">
          <button
            onClick={() => setStep((s) => s - 1)}
            disabled={step === 0 || busy}
            className={`border-none bg-transparent px-1 py-2 text-[13px] text-muted ${step === 0 ? "cursor-default opacity-0" : "cursor-pointer"}`}
          >Back</button>
          <button
            onClick={() => (step < steps.length - 1 ? setStep((s) => s + 1) : finish())}
            disabled={!canContinue || busy}
            className={`rounded-lg border border-primary bg-primary px-[18px] py-[9px] text-[13.5px] font-medium text-card ${canContinue && !busy ? "cursor-pointer" : "cursor-not-allowed opacity-45"}`}
          >{busy ? "Setting up…" : step < steps.length - 1 ? "Continue" : "Start stashing"}</button>
        </div>
      </div>
    </div>
  );
}