"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { Sparkles } from "lucide-react";
import { fade } from "@/lib/motion";
import type { SectionMeta } from "@/components/shell/sections";
import { Avatar } from "@/components/ui/avatar";
import { Card, CardDivider, CardRow } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { SectionLabel } from "@/components/ui/section-label";
import { colorForChat } from "@/components/chat/chat-list";
import { getConversationId } from "@/lib/data/chats";
import { useChats } from "@/hooks/use-chat";
import { useAppPathname } from "@/lib/navigation";
import { useWorkspaces } from "@/stores/workspace-store";
import { cn } from "@/lib/utils";
import { HOME_MOCK } from "@/lib/mock/home";
import { useUiStore } from "@/stores/ui-store";

type RightPanelProps = {
  section: SectionMeta;
};

const CHAT_TYPE_LABEL: Record<string, string> = {
  group: "Grupo",
  dm: "Mensaje directo",
  posts: "Publicaciones",
  ai: "Asistente",
};

function ChatDetails(): React.JSX.Element | null {
  const pathname = useAppPathname();
  const searchParams = useSearchParams();
  const chatId = getConversationId(pathname, searchParams.get("id"));
  const { currentWorkspaceId, currentWorkspace } = useWorkspaces();
  const chatsQuery = useChats(chatId === "loki-ia" ? null : currentWorkspaceId);
  if (chatId === null) return null;
  if (chatId === "loki-ia") {
    return (
      <div>
        <SectionLabel>Detalles del chat</SectionLabel>
        <Card>
          <CardRow>
            <span
              aria-hidden="true"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-foreground text-background dark:bg-white dark:text-black"
            >
              <Icon icon={Sparkles} size={22} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body-sm font-medium text-foreground">
                Loki IA
              </span>
              <span className="block truncate text-meta text-muted-foreground">
                Asistente · siempre disponible
              </span>
            </span>
          </CardRow>
        </Card>
      </div>
    );
  }
  const chat = (chatsQuery.data ?? []).find((item) => item.id === chatId) ?? null;
  if (chat === null) return null;
  const membersLabel =
    chat.memberIds.length === 0
      ? `Todo el espacio${currentWorkspace ? ` · ${currentWorkspace.name}` : ""}`
      : `${chat.memberIds.length} ${chat.memberIds.length === 1 ? "miembro" : "miembros"}`;
  return (
    <div>
      <SectionLabel>Detalles del chat</SectionLabel>
      <Card>
        <CardRow>
          {chat.emoji ? (
            <Avatar emoji={chat.emoji} size={44} />
          ) : (
            <Avatar
              initial={chat.name.charAt(0).toUpperCase()}
              color={colorForChat(chat.id)}
              size={44}
            />
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body-sm font-medium text-foreground">
              {chat.name}
            </span>
            <span className="block truncate text-meta text-muted-foreground">
              {CHAT_TYPE_LABEL[chat.type] ?? chat.type}
            </span>
          </span>
        </CardRow>
        <CardDivider />
        <CardRow>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body-sm font-medium text-foreground">
              Miembros
            </span>
            <span className="block truncate text-meta text-muted-foreground">
              {membersLabel}
            </span>
          </span>
        </CardRow>
      </Card>
    </div>
  );
}

export function RightPanel({ section }: RightPanelProps): React.JSX.Element {
  const rightPanelOpen = useUiStore((state) => state.rightPanelOpen);

  const contextItems = React.useMemo(() => {
    if (section.key !== "inicio") return section.contextItems;
    const openTasks = HOME_MOCK.todayTasks.filter((task) => !task.done).length;
    const nextEvent = HOME_MOCK.upcomingEvents[0];
    return [
      { title: "Resumen", meta: "Tu día de un vistazo" },
      {
        title: "Pendientes",
        meta: `${openTasks} ${openTasks === 1 ? "tarea abierta" : "tareas abiertas"}`,
      },
      {
        title: "Próximo evento",
        meta:
          nextEvent === undefined
            ? "Nada programado"
            : `${nextEvent.title} · ${nextEvent.when}`,
      },
    ];
  }, [section]);

  return (
    <div
      className={cn(
        "sticky top-0 hidden h-dvh shrink-0 self-start overflow-hidden transition-[width] duration-200 ease-out xl:block",
        rightPanelOpen ? "xl:w-[320px]" : "xl:w-0",
      )}
    >
      <AnimatePresence initial={false}>
        {rightPanelOpen ? (
          <motion.aside
            key="right-panel"
            aria-label={`Panel contextual de ${section.label}`}
            variants={fade}
            initial="hidden"
            animate="show"
            exit="exit"
            className="h-dvh w-[320px] overflow-y-auto border-l border-divider px-3 py-3"
          >
            <React.Suspense fallback={null}>
              <ChatDetails />
            </React.Suspense>
            <div className="mt-3">
              <SectionLabel>{section.contextTitle}</SectionLabel>
              <Card>
                {contextItems.map((item, index) => (
                  <React.Fragment key={item.title}>
                    {index > 0 ? <CardDivider /> : null}
                    <CardRow>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-body-sm font-medium text-foreground">
                          {item.title}
                        </span>
                        <span className="block truncate text-meta text-muted-foreground">
                          {item.meta}
                        </span>
                      </span>
                    </CardRow>
                  </React.Fragment>
                ))}
              </Card>
            </div>
          </motion.aside>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
