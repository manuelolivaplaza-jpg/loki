"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { ChevronLeft, Info, Plus, Search, Sparkles, X } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/icon-button";
import { Pill } from "@/components/ui/pill";
import { ProfileMenu } from "@/components/shell/profile-menu";
import {
  PlaceholderDialog,
  QuickActionsMobileMenu,
} from "@/components/shell/quick-actions";
import { avatarColorFor } from "@/lib/avatar-color";
import { AI_CHAT_ID, AI_CHAT_NAME } from "@/lib/chat/ai-mock";
import { POSTS_CHAT_EMOJI, POSTS_CHAT_NAME } from "@/lib/chat/posts";
import { spring } from "@/lib/motion";
import { getConversationId } from "@/lib/data/chats";
import { useChats } from "@/hooks/use-chat";
import { useAppPathname } from "@/lib/navigation";
import { MobileWorkspaceSwitcher } from "@/components/workspaces/mobile-workspace-switcher";
import { useWorkspaces } from "@/stores/workspace-store";
import { AVATAR_FALLBACK_COLOR } from "@/types/models";

type MobileHeaderProps = {
  title: string;
};

function ConversationHeader({ chatId }: { chatId: string }): React.JSX.Element {
  const router = useRouter();
  const { currentWorkspaceId } = useWorkspaces();
  const chatsQuery = useChats(chatId === AI_CHAT_ID ? null : currentWorkspaceId);
  const chat =
    (chatsQuery.data ?? []).find((item) => item.id === chatId) ?? null;
  const isLoki = chatId === AI_CHAT_ID;
  const name = isLoki ? AI_CHAT_NAME : (chat?.name ?? "Chat");
  const leading = isLoki ? (
    <span
      aria-hidden="true"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background dark:bg-white dark:text-black"
    >
      <Icon icon={Sparkles} size={20} />
    </span>
  ) : chat?.emoji ? (
    <Avatar emoji={chat.emoji} size={32} />
  ) : (
    <Avatar
      initial={name.charAt(0).toUpperCase()}
      color={chat ? avatarColorFor(chat.id) : AVATAR_FALLBACK_COLOR}
      size={32}
    />
  );

  return (
    <header className="sticky top-0 z-40 bg-gradient-to-b from-background via-background/70 to-transparent md:hidden">
      <div className="flex h-[68px] items-center justify-between gap-2 px-3">
        <IconButton variant="floating" aria-label="Volver" onClick={() => router.push("/chat")}>
          <Icon icon={ChevronLeft} size={24} />
        </IconButton>
        <Pill
          aria-label={name}
          chevron={false}
          leading={leading}
          text={name}
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

/**
 * Cabecera de Publicaciones en móvil: misma cabecera que una conversación
 * (volver a /chat, pastilla con el emoji de periódico y el nombre, botón
 * circular a la derecha), pero fija y sin consultar los chats del espacio.
 */
function PostsHeader(): React.JSX.Element {
  const router = useRouter();
  return (
    <header className="sticky top-0 z-40 bg-gradient-to-b from-background via-background/70 to-transparent md:hidden">
      <div className="flex h-[68px] items-center justify-between gap-2 px-3">
        <IconButton variant="floating" aria-label="Volver" onClick={() => router.push("/chat")}>
          <Icon icon={ChevronLeft} size={24} />
        </IconButton>
        <Pill
          aria-label={POSTS_CHAT_NAME}
          chevron={false}
          leading={<Avatar emoji={POSTS_CHAT_EMOJI} size={32} />}
          text={POSTS_CHAT_NAME}
          onClick={() => undefined}
          className="py-2 pl-2 pr-4"
        />
        <IconButton
          variant="floating"
          aria-label="Detalles de las publicaciones"
          title="Próximamente"
        >
          <Icon icon={Info} size={20} />
        </IconButton>
      </div>
    </header>
  );
}

function MobileHeaderInner({ title }: MobileHeaderProps): React.JSX.Element {
  const pathname = useAppPathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [actionsOpen, setActionsOpen] = React.useState(false);
  const [searchOpen, setSearchOpen] = React.useState(false);

  const chatId = getConversationId(pathname, searchParams.get("id"));
  const isChatList = pathname === "/chat";
  const isPosts = pathname === "/chat/publicaciones";
  const isPerfil =
    pathname === "/perfil" || (pathname?.startsWith("/perfil/") ?? false);
  const isConfig =
    pathname === "/configuracion" ||
    (pathname?.startsWith("/configuracion/") ?? false);

  // Vista de conversación: volver + pastilla del chat + botón circular.
  if (chatId !== null) {
    return <ConversationHeader chatId={chatId} />;
  }

  // T17: el feed de Publicaciones es una conversación más en móvil.
  if (isPosts) {
    return <PostsHeader />;
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

export function MobileHeader({ title }: MobileHeaderProps): React.JSX.Element {
  return (
    <React.Suspense fallback={<header className="sticky top-0 z-40 md:hidden"><div className="h-[68px]" /></header>}>
      <MobileHeaderInner title={title} />
    </React.Suspense>
  );
}
