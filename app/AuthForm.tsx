"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { AuthShell, cardClass, inputClass, otpClass, doneClass, submitClass } from "./AuthShell";

type View = "form" | "verify" | "forgot";

const linkButtonClass = "cursor-pointer border-none bg-transparent py-0.5 text-[12.5px] text-faint";

export default function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const router = useRouter();
  const [view, setView] = useState<View>("form");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [otp, setOtp] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resent, setResent] = useState(false);
  const [resetSent, setResetSent] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const { error: err } =
      mode === "sign-up"
        ? await authClient.signUp.email({ name: name.trim() || "Anonymous", email: email.trim(), password })
        : await authClient.signIn.email({ email: email.trim(), password });
    setBusy(false);
    if (err) {
      if (err.code === "EMAIL_NOT_VERIFIED") { setView("verify"); return; }
      setError(err.message || "Something went wrong.");
      return;
    }
    if (mode === "sign-up") { setView("verify"); return; }
    router.push("/");
    router.refresh();
  }

  async function onVerify(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const { error: err } = await authClient.emailOtp.verifyEmail({ email: email.trim(), otp: otp.trim() });
    setBusy(false);
    if (err) { setError(err.message || "That code didn't work."); return; }
    router.push("/");
    router.refresh();
  }

  async function resend() {
    setError(null);
    setResent(false);
    const { error: err } = await authClient.emailOtp.sendVerificationOtp({ email: email.trim(), type: "email-verification" });
    if (err) setError(err.message || "Couldn't resend the code.");
    else { setResent(true); setTimeout(() => setResent(false), 3000); }
  }

  async function onForgotSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const { error: err } = await authClient.requestPasswordReset({ email: email.trim(), redirectTo: "/reset-password" });
    setBusy(false);
    if (err) { setError(err.message || "Couldn't send that reset link."); return; }
    setResetSent(true);
  }

  function backToForm() {
    setView("form");
    setError(null);
    setOtp("");
    setResetSent(false);
  }

  if (view === "verify") {
    return (
      <AuthShell>
        <div className={cardClass}>
          <div className="font-serif text-[27px] leading-[1.15] tracking-[-.01em] text-primary">Check your email</div>
          <div className="mt-1.5 text-[13.5px] text-muted">We sent a 6-digit code to {email.trim()}.</div>
          <form onSubmit={onVerify} className="mt-5 flex flex-col gap-[11px]">
            <input
              value={otp} onChange={(e) => setOtp(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
              placeholder="000000" inputMode="numeric" maxLength={6} autoFocus className={otpClass}
            />
            {error && <div className="text-[12.5px] text-danger">{error}</div>}
            <button type="submit" disabled={busy || otp.trim().length < 6} className={submitClass(busy)}>
              {busy ? "Verifying…" : "Verify"}
            </button>
          </form>
          <div className="mt-4 flex items-center gap-2">
            <button onClick={resend} className={`${linkButtonClass} text-muted underline`}>
              {resent ? "Code sent." : "Resend code"}
            </button>
            <div className="flex-1" />
            <button onClick={backToForm} className={linkButtonClass}>use another email</button>
          </div>
        </div>
      </AuthShell>
    );
  }

  if (view === "forgot") {
    return (
      <AuthShell>
        <div className={cardClass}>
          <div className="font-serif text-[27px] leading-[1.15] tracking-[-.01em] text-primary">Reset your password</div>
          <div className="mt-1.5 text-[13.5px] text-muted">We&apos;ll email you a link to set a new one.</div>

          {resetSent ? (
            <div className={doneClass}>Check your email — we&apos;ve sent a link to reset your password.</div>
          ) : (
            <form onSubmit={onForgotSubmit} className="mt-5 flex flex-col gap-[11px]">
              <input
                value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" type="email" required
                autoFocus autoComplete="email" className={inputClass}
              />
              {error && <div className="text-[12.5px] text-danger">{error}</div>}
              <button type="submit" disabled={busy} className={submitClass(busy)}>
                {busy ? "Sending…" : "Send reset link"}
              </button>
            </form>
          )}
        </div>
        <div className="mt-5 text-center text-[13px] text-muted">
          Remembered it? <button onClick={backToForm} className="cursor-pointer border-none bg-transparent px-0.5 text-[13px] text-primary underline decoration-[var(--link-underline)] hover:text-primary">Back to sign in</button>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className={cardClass}>
        <div className="font-serif text-[27px] leading-[1.15] tracking-[-.01em] text-primary">
          {mode === "sign-up" ? "Create your account" : "Welcome back"}
        </div>
        <div className="mt-1.5 text-[13.5px] text-muted">
          {mode === "sign-up" ? "Everything you keep, in one place." : "Sign in to your stash."}
        </div>

        <form onSubmit={onSubmit} className="mt-5 flex flex-col gap-[11px]">
          {mode === "sign-up" && (
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" className={inputClass} autoComplete="name" />
          )}
          <input
            value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" type="email" required
            className={inputClass} autoComplete="email"
          />
          <input
            value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" type="password" required
            minLength={8} className={inputClass} autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
          />

          {mode === "sign-in" && (
            <div className="mt-[-3px] flex justify-end">
              <button type="button" onClick={() => { setView("forgot"); setError(null); }} className={linkButtonClass}>
                Forgot your password?
              </button>
            </div>
          )}

          {error && <div className="text-[12.5px] text-danger">{error}</div>}

          <button type="submit" disabled={busy} className={submitClass(busy)}>
            {busy ? "Please wait…" : mode === "sign-up" ? "Create account" : "Sign in"}
          </button>
        </form>
      </div>

      <div className="mt-5 text-center text-[13px] text-muted">
        {mode === "sign-up" ? (
          <>Already have an account? <a href="/sign-in" className="text-primary underline">Sign in</a></>
        ) : (
          <>New here? <a href="/sign-up" className="text-primary underline">Create an account</a></>
        )}
      </div>
    </AuthShell>
  );
}