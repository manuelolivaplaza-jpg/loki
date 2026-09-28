"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { NAV_ITEMS } from "@/components/shell/sections";
import { ThemeToggle } from "@/components/theme-toggle";
import { WorkspaceSwitcher } from "@/components/workspaces/workspace-switcher";
import { signOutUser } from "@/lib/auth/actions";
import { useProfileStore } from "@/stores/profile-store";
import { useSessionStore } from "@/stores/session-store";
import { avatarTextColor } from "@/types/models";
import { cn } from "@/lib/utils";

function getInitial(displayName: string | null, email: string | null): string {
  const source = displayName?.trim() !== "" ? displayName : email;
  if (source === null || source === undefined || source.trim() === "") {
    return "L";
  }
  return source.trim().charAt(0).toUpperCase();
}

export function Sidebar(): React.JSX.Element {
  const pathname = usePathname();
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
    <aside className="sticky top-0 hidden h-dvh w-[68px] shrink-0 flex-col border-r border-border bg-background md:flex xl:w-[220px]">
      <div className="flex h-[53px] items-center justify-center px-1 xl:justify-start xl:px-2">
        <WorkspaceSwitcher />
      </div>

      <nav aria-label="Navegación principal" className="mt-2 flex-1 px-2 xl:px-3">
        <ul className="flex flex-col items-center gap-1 xl:items-stretch">
          {NAV_ITEMS.map((item) => {
            const active =
              pathname === item.href || pathname?.startsWith(`${item.href}/`) === true;
            const Icon = item.icon;
            return (
              <li key={item.key} className="w-full">
                <Link
                  href={item.href}
                  aria-label={item.label}
                  title={item.label}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "group relative flex h-10 items-center justify-center rounded-full px-3 py-2 outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent xl:justify-start xl:gap-3",
                    active
                      ? "font-semibold text-foreground"
                      : "font-normal text-foreground",
                  )}
                >
                  <span className="relative flex items-center justify-center">
                    <Icon
                      aria-hidden
                      className="h-6 w-6 shrink-0"
                      strokeWidth={active ? 2.5 : 1.75}
                      fill={active && item.key === "chat" ? "currentColor" : "none"}
                    />
                    {active ? (
                      <span
                        aria-hidden
                        className="absolute -right-1.5 top-0 h-1.5 w-1.5 rounded-full bg-accent xl:hidden"
                      />
                    ) : null}
                  </span>
                  <span className="hidden text-[15px] xl:inline">{item.label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="relative flex flex-col items-center gap-3 px-2 py-3 xl:flex-row xl:justify-between xl:px-3">
        <ThemeToggle />
        <button
          type="button"
          onClick={() => setMenuOpen((open) => !open)}
          aria-label="Abrir menú de sesión"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          style={
            avatarColor !== null
              ? {
                  backgroundColor: avatarColor,
                  borderColor: avatarColor,
                  color: avatarTextColor(avatarColor),
                }
              : undefined
          }
          className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-surface-2 text-meta font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <span aria-hidden>{avatarInitial}</span>
        </button>
        {menuOpen ? (
          <div
            role="menu"
            aria-label="Menú de sesión"
            className="absolute bottom-12 left-2 z-30 w-48 rounded-xl border border-border bg-popover p-1 shadow-lg xl:left-auto xl:right-2"
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
    </aside>
  );
}
