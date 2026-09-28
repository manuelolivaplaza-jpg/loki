"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { ChevronLeft, Info, Plus, Search, X } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Pill } from "@/components/ui/pill";
import { ProfileMenu } from "@/components/shell/profile-menu";
import {
  PlaceholderDialog,
  QuickActionsMobileMenu,
} from "@/components/shell/quick-actions";
import { spring } from "@/lib/motion";
import { getChatById, getChatIdFromPath } from "@/lib/data/chats";
import { MobileWorkspaceSwitcher } from "@/components/workspaces/mobile-workspace-switcher";
import { AVATAR_FALLBACK_COLOR } from "@/types/models";

type MobileHeaderProps = {
  title: string;
};

export function MobileHeader({ title }: MobileHeaderProps): React.JSX.Element {
  const pathname = usePathname();
  const router = useRouter();
  const [actionsOpen, setActionsOpen] = React.useState(false);
  const [searchOpen, setSearchOpen] = React.useState(false);

  const chatId = getChatIdFromPath(pathname);
  const isChatList = pathname === "/chat";
  const isPerfil =
    pathname === "/perfil" || (pathname?.startsWith("/perfil/") ?? false);
  const isConfig =
    pathname === "/configuracion" ||
    (pathname?.startsWith("/configuracion/") ?? false);

  // Vista de conversación: volver + pastilla del chat + botón circular.
  if (chatId !== null) {
    const chat = getChatById(chatId);
    return (
      <header className="sticky top-0 z-40 bg-gradient-to-b from-background via-background/70 to-transparent md:hidden">
        <div className="flex h-[68px] items-center justify-between gap-2 px-3">
          <IconButton variant="floating" aria-label="Volver" onClick={() => router.push("/chat")}>
            <Icon icon={ChevronLeft} size={24} />
          </IconButton>
          <Pill
            aria-label={chat?.name ?? "Chat"}
            chevron={false}
            leading={
              <Avatar
                initial={(chat?.name ?? "C").charAt(0)}
                color={chat?.color ?? AVATAR_FALLBACK_COLOR}
                size={32}
              />
            }
            text={chat?.name ?? "Chat"}
            onClick={() => undefined}
            className="py-2 pl-2 pr-4"
          />
          <IconButton variant="floating" aria-label="Detalles de la conversación" title="Próximamente">
            <Icon icon={Info} size={20} />
          </IconButton>
        </div>
      </header>
    );
  }

  // Perfil y configuración en móvil: pantalla completa con X para cerrar.
  if (isPerfil || isConfig) {
    return (
      <header className="sticky top-0 z-40 bg-gradient-to-b from-background via-background/70 to-transparent md:hidden">
        <div className="flex h-[68px] items-center justify-between gap-2 px-3">
          <IconButton variant="floating" aria-label="Cerrar" onClick={() => router.back()}>
            <Icon icon={X} size={24} />
          </IconButton>
          <h1 className="min-w-0 flex-1 truncate text-center text-body font-semibold text-foreground">
            {isPerfil ? "Perfil" : "Configuración"}
          </h1>
          <span aria-hidden="true" className="h-11 w-11 shrink-0" />
        </div>
      </header>
    );
  }

  // Cabecera general: pastilla del espacio al centro + avatar a la derecha.
  // En la lista de chats, avatar a la izquierda y Buscar/+ a la derecha.
  return (
    <header className="sticky top-0 z-40 bg-gradient-to-b from-background via-background/70 to-transparent md:hidden">
      <div className="flex h-[68px] items-center justify-between gap-2 px-3">
        {isChatList ? (
          <ProfileMenu size={44} />
        ) : (
          <span aria-hidden="true" className="h-11 w-11 shrink-0" />
        )}
        <div className="flex min-w-0 flex-1 justify-center">
          <MobileWorkspaceSwitcher />
        </div>
        {isChatList ? (
          <div className="flex shrink-0 items-center gap-2">
            <IconButton variant="floating" aria-label="Buscar" onClick={() => setSearchOpen(true)}>
              <Icon icon={Search} size={20} />
            </IconButton>
            <IconButton
              variant="floating"
              aria-label="Acciones rapidas"
              aria-haspopup="menu"
              aria-expanded={actionsOpen}
              onClick={() => setActionsOpen((value) => !value)}
            >
              <motion.span
                animate={{ rotate: actionsOpen ? 45 : 0 }}
                transition={spring}
                className="flex items-center justify-center"
              >
                <Icon icon={Plus} size={24} />
              </motion.span>
            </IconButton>
          </div>
        ) : (
          <ProfileMenu size={44} />
        )}
      </div>
      <span className="sr-only">{title}</span>
      <QuickActionsMobileMenu
        open={actionsOpen}
        onClose={() => setActionsOpen(false)}
      />
      <PlaceholderDialog
        title="Buscar"
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
      />
    </header>
  );
}
