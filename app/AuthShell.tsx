import type { ReactNode } from "react";

export const inputClass =
  "w-full rounded-lg border border-default bg-card px-3 py-[11px] text-sm text-primary font-sans outline-none";

export const otpClass =
  `${inputClass} text-center font-mono text-[22px] py-[13px] tracking-[.3em]`;

export const cardClass =
  "rounded-[14px] border border-default bg-card px-7 py-[30px] shadow-[0_24px_60px_rgba(var(--shadow-color),.1)] animate-fade";

export const doneClass =
  "mt-5 rounded-[10px] border border-accent-border bg-accent-bg px-[15px] py-[13px] font-serif text-sm italic text-secondary";

export function submitClass(busy: boolean): string {
  return `mt-[7px] rounded-lg border border-primary bg-primary px-[13px] py-[11px] text-sm font-medium text-card ${busy ? "cursor-default opacity-60" : "cursor-pointer"}`;
}

export function Logo() {
  return (
    <div className="mb-[30px] flex items-center justify-center gap-2.5">
      <div className="relative size-[15px] rounded bg-primary">
        <div className="absolute -right-1 -bottom-1 size-[9px] rounded-[3px] border border-primary bg-paper" />
      </div>
      <div className="font-mono text-[11px] uppercase tracking-[.2em] text-muted">Stashdrop</div>
    </div>
  );
}

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 grid place-items-center bg-paper p-5 font-sans text-sm text-primary [background-image:radial-gradient(circle_at_1px_1px,rgba(var(--shadow-color),.05)_1px,transparent_0)] [background-size:26px_26px]">
      <div className="w-[min(384px,100%)]">
        <Logo />
        {children}
      </div>
    </div>
  );
}