"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { LogOut, Settings, User } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Avatar, type AvatarSize } from "@/components/ui/avatar";
import { MenuItem } from "@/components/ui/menu-card";
import { ThemeSegmented } from "@/components/shell/theme-segmented";
import { signOutUser } from "@/lib/auth/actions";
import { useProfileStore } from "@/stores/profile-store";
import { useSessionStore } from "@/stores/session-store";
import { AVATAR_FALLBACK_COLOR, getAvatarInitial } from "@/types/models";
import { cn } from "@/lib/utils";

export function ProfileMenu({
  className,
  size = 40,
}: {
  className?: string;
  size?: AvatarSize;
}): React.JSX.Element {
  const router = useRouter();
  const user = useSessionStore((state) => state.user);
  const profile = useProfileStore((state) => state.profile);
  const [open, setOpen] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);

  const displayName =
    profile?.displayName.trim() !== "" &&
    profile?.displayName !== undefined &&
    profile.displayName !== null
      ? profile.displayName
      : (user?.displayName?.trim() !== "" ? user?.displayName : null) ??
        "Usuario";
  const email = profile?.email ?? user?.email ?? null;
  const initial =
    profile?.avatarInitial ??
    getAvatarInitial(user?.displayName ?? null, user?.email ?? null);
  const color = profile?.avatarColor ?? AVATAR_FALLBACK_COLOR;

  async function handleSignOut(): Promise<void> {
    setSigningOut(true);
    try {
      await signOutUser();
    } finally {
      setOpen(false);
      setSigningOut(false);
      router.replace("/login");
    }
  }

  function go(path: string): void {
    setOpen(false);
    router.push(path);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Menu de perfil"
          aria-haspopup="menu"
          aria-expanded={open}
          className={cn(
            "flex shrink-0 items-center justify-center rounded-full shadow-float outline-none focus-visible:ring-2 focus-visible:ring-accent",
            className,
          )}
        >
          <Avatar initial={initial} color={color} size={size} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <div className="flex items-center gap-3 px-2 py-2">
          <Avatar initial={initial} color={color} size={40} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body font-semibold leading-6 text-foreground">
              {displayName}
            </span>
            {email !== null ? (
              <span className="block truncate text-meta leading-5 text-muted-foreground">
                {email}
              </span>
            ) : null}
          </span>
        </div>
        <div className="px-2 py-2">
          <ThemeSegmented />
        </div>
        <div role="menu" aria-label="Menú de perfil" className="flex flex-col">
          <MenuItem icon={User} role="menuitem" onClick={() => go("/perfil")}>
            Perfil
          </MenuItem>
          <MenuItem icon={Settings} role="menuitem" onClick={() => go("/configuracion")}>
            Configuración
          </MenuItem>
        </div>
        <div aria-hidden="true" className="mx-2 my-2 h-px bg-divider" />
        <MenuItem
          icon={LogOut}
          danger
          role="menuitem"
          aria-label="Cerrar sesion"
          onClick={() => void handleSignOut()}
          disabled={signingOut}
        >
          {signingOut ? "Cerrando..." : "Cerrar sesión"}
        </MenuItem>
      </PopoverContent>
    </Popover>
  );
}
