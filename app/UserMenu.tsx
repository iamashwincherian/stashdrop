"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Settings, LogOut, Building2 } from "lucide-react";
import { authClient } from "@/lib/auth-client";

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts[1]?.[0] || "")).toUpperCase();
}

export default function UserMenu({ user, onSwitchWorkspace, onOpenSettings }: { user: { name: string; email: string }; onSwitchWorkspace: () => void; onOpenSettings: () => void }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  async function logout() {
    await authClient.signOut();
    router.push("/sign-in");
    router.refresh();
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title={user.name}
        aria-label="Account menu"
        className="grid size-[26px] cursor-pointer place-items-center rounded-full border border-strong bg-hover font-mono text-[9.5px] text-muted"
      >{initials(user.name)}</button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} className="fixed inset-0 z-60" />
          <div className="absolute right-0 top-[calc(100%+6px)] z-61 min-w-[200px] overflow-hidden rounded-[10px] border border-default bg-card p-1 shadow-[0_10px_34px_rgba(var(--shadow-color),.16)]">
            <div className="mb-1 border-b border-subtle px-2.5 pb-[9px] pt-2">
              <div className="truncate text-[13px] font-medium text-primary">{user.name}</div>
              <div className="mt-px truncate text-[11.5px] text-faint">{user.email}</div>
            </div>
            <button
              onClick={() => { onSwitchWorkspace(); setOpen(false); }}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md bg-transparent px-2.5 py-[7px] text-left text-[12.5px] text-secondary hover:bg-hover hover:text-primary"
            ><Building2 size={13} /> Switch workspace</button>
            <button
              onClick={() => { onOpenSettings(); setOpen(false); }}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md bg-transparent px-2.5 py-[7px] text-left text-[12.5px] text-secondary hover:bg-hover hover:text-primary"
            ><Settings size={13} /> Settings</button>
            <button
              onClick={logout}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md bg-transparent px-2.5 py-[7px] text-left text-[12.5px] text-danger hover:bg-hover hover:text-primary"
            ><LogOut size={13} /> Log out</button>
          </div>
        </>
      )}
    </div>
  );
}