"use client";

import { useState, type FormEvent } from "react";
import { authClient } from "@/lib/auth-client";
import { AuthShell, cardClass, inputClass, doneClass, submitClass } from "../AuthShell";

export default function ResetPasswordClient({ token }: { token?: string }) {
  const [password, setPassword] = useState("");
  const [password2, setPassword2] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (password.length < 8) { setError("Passwords need at least 8 characters."); return; }
    if (password !== password2) { setError("Those two passwords don't match."); return; }
    setError(null);
    setBusy(true);
    const { error: err } = await authClient.resetPassword({ newPassword: password, token });
    setBusy(false);
    if (err) { setError(err.message || "That reset link didn't work."); return; }
    setDone(true);
  }

  if (!token) {
    return (
      <AuthShell>
        <div className={cardClass}>
          <div className="font-serif text-[27px] leading-[1.15] tracking-[-.01em] text-primary">Link expired</div>
          <div className="mt-1.5 text-[13.5px] text-muted">
            This password reset link is invalid or has expired. Request a new one from the sign-in page.
          </div>
        </div>
        <div className="mt-5 text-center text-[13px] text-muted">
          <a href="/sign-in" className="text-primary underline">Back to sign in</a>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className={cardClass}>
        <div className="font-serif text-[27px] leading-[1.15] tracking-[-.01em] text-primary">Set a new password</div>
        <div className="mt-1.5 text-[13.5px] text-muted">Choose a new password for your account.</div>

        {done ? (
          <div className={doneClass}>Password changed. Sign in with the new one.</div>
        ) : (
          <form onSubmit={onSubmit} className="mt-5 flex flex-col gap-[11px]">
            <input
              value={password} onChange={(e) => setPassword(e.target.value)} placeholder="New password" type="password"
              minLength={8} required autoFocus autoComplete="new-password" className={inputClass}
            />
            <input
              value={password2} onChange={(e) => setPassword2(e.target.value)} placeholder="Repeat new password" type="password"
              required autoComplete="new-password" className={inputClass}
            />
            {error && <div className="text-[12.5px] text-danger">{error}</div>}
            <button type="submit" disabled={busy} className={submitClass(busy)}>
              {busy ? "Saving…" : "Change password"}
            </button>
          </form>
        )}
      </div>
      <div className="mt-5 text-center text-[13px] text-muted">
        <a href="/sign-in" className="text-primary underline">
          {done ? "Sign in" : "Back to sign in"}
        </a>
      </div>
    </AuthShell>
  );
}