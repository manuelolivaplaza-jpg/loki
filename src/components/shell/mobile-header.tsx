"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ThemeToggle } from "@/components/theme-toggle";
import { signOutUser } from "@/lib/auth/actions";
import { useProfileStore } from "@/stores/profile-store";
import { useSessionStore } from "@/stores/session-store";
import { avatarTextColor } from "@/types/models";

type MobileHeaderProps = {
  title: string;
};

function getInitial(displayName: string | null, email: string | null): string {
  const source = displayName?.trim() !== "" ? displayName : email;
  if (source === null || source === undefined || source.trim() === "") {
    return "L";
  }
  return source.trim().charAt(0).toUpperCase();
}

export function MobileHeader({ title }: MobileHeaderProps): React.JSX.Element {
  const router = useRouter();
  const user = useSessionStore((state) => state.user);
  const profile = useProfileStore((state) => state.profile);
  const avatarInitial =
    profile?.avatarInitial ?? getInitial(user?.displayName ?? null, user?.email ?? null);
  const avatarColor = profile?.avatarColor ?? null;
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);

  async function handleSignOut(): Promise<void> {
    setSigningOut(true);
    try {
      await signOutUser();
    } finally {
      setMenuOpen(false);
      setSigningOut(false);
      router.replace("/login");
    }
  }

  return (
    <header className="sticky top-0 z-20 flex h-[53px] items-center justify-between border-b border-border bg-background/80 px-4 backdrop-blur md:hidden">
      <div className="relative">
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-label="Abrir menú de sesión"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          className="rounded-full p-1 outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span
            aria-hidden
            style={
              avatarColor !== null
                ? {
                    backgroundColor: avatarColor,
                    color: avatarTextColor(avatarColor),
                  }
                : undefined
            }
            className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-2 text-base font-semibold text-foreground"
          >
            {avatarInitial}
          </span>
        </button>
        {menuOpen ? (
          <div
            role="menu"
            aria-label="Menú de sesión"
            className="absolute left-0 top-11 z-30 w-52 rounded-xl border border-border bg-popover p-1 shadow-lg"
          >
            {user?.email !== null && user?.email !== undefined ? (
              <p className="truncate px-3 py-2 text-[13px] text-muted-foreground">
                {user.email}
              </p>
            ) : null}
            <button
              type="button"
              role="menuitem"
              aria-label="Cerrar sesión"
              onClick={handleSignOut}
              disabled={signingOut}
              className="w-full rounded-lg px-3 py-2 text-left text-[14px] font-medium text-foreground outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-60"
            >
              {signingOut ? "Cerrando..." : "Cerrar sesión"}
            </button>
          </div>
        ) : null}
      </div>
      <h1 className="text-[16px] font-semibold text-foreground">{title}</h1>
      <ThemeToggle />
    </header>
  );
}
