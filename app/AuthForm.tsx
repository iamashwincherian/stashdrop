"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

const SERIF = "var(--font-serif), serif";
const SANS = "var(--font-sans), system-ui, sans-serif";
const MONO = "var(--font-mono), monospace";

const inputStyle: React.CSSProperties = {
  width: "100%", border: "1px solid var(--border-default)", background: "var(--card-bg)",
  borderRadius: 8, padding: "10px 12px", fontSize: 14, color: "var(--text-primary)",
  fontFamily: SANS, outline: "none",
};

export default function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const { error: err } =
      mode === "sign-up"
        ? await authClient.signUp.email({ name: name.trim() || "Anonymous", email: email.trim(), password })
        : await authClient.signIn.email({ email: email.trim(), password });
    setBusy(false);
    if (err) { setError(err.message || "Something went wrong."); return; }
    router.push("/");
    router.refresh();
  }

  return (
    <div style={{
      position: "fixed", inset: 0, background: "var(--paper)", display: "grid", placeItems: "center", padding: 20,
    }}>
      <div style={{ width: "min(360px, 100%)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 28, justifyContent: "center" }}>
          <div style={{ width: 15, height: 15, borderRadius: 4, background: "var(--text-primary)", position: "relative" }}>
            <div style={{ position: "absolute", right: -4, bottom: -4, width: 9, height: 9, borderRadius: 3, background: "var(--paper)", border: "1px solid var(--text-primary)" }} />
          </div>
          <div style={{ fontFamily: MONO, fontSize: 12, letterSpacing: ".2em", textTransform: "uppercase", color: "var(--text-muted)" }}>Stashdrop</div>
        </div>

        <div style={{
          background: "var(--surface-solid)", border: "1px solid var(--border-default)", borderRadius: 14,
          padding: "28px 26px", boxShadow: "0 24px 60px rgba(var(--shadow-color),.1)",
        }}>
          <div style={{ fontFamily: SERIF, fontSize: 24, color: "var(--text-primary)", marginBottom: 4 }}>
            {mode === "sign-up" ? "Create your account" : "Welcome back"}
          </div>
          <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 22 }}>
            {mode === "sign-up" ? "Everything you keep, in one place." : "Sign in to your stash."}
          </div>

          <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {mode === "sign-up" && (
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" style={inputStyle} autoComplete="name" />
            )}
            <input
              value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email" type="email" required
              style={inputStyle} autoComplete="email"
            />
            <input
              value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" type="password" required
              minLength={8} style={inputStyle} autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
            />

            {error && <div style={{ fontSize: 12.5, color: "var(--danger)" }}>{error}</div>}

            <button
              type="submit"
              disabled={busy}
              style={{
                marginTop: 6, border: "1px solid var(--text-primary)", background: "var(--text-primary)", color: "var(--card-bg)",
                borderRadius: 8, padding: "10px 13px", fontSize: 14, fontWeight: 500, cursor: busy ? "default" : "pointer",
                opacity: busy ? 0.6 : 1,
              }}
            >{busy ? "Please wait…" : mode === "sign-up" ? "Create account" : "Sign in"}</button>
          </form>
        </div>

        <div style={{ textAlign: "center", marginTop: 18, fontSize: 13, color: "var(--text-muted)" }}>
          {mode === "sign-up" ? (
            <>Already have an account? <a href="/sign-in" style={{ color: "var(--text-primary)", textDecoration: "underline" }}>Sign in</a></>
          ) : (
            <>New here? <a href="/sign-up" style={{ color: "var(--text-primary)", textDecoration: "underline" }}>Create an account</a></>
          )}
        </div>
      </div>
    </div>
  );
}
