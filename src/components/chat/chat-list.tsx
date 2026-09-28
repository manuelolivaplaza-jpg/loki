"use client";

import Link from "next/link";
import { ChevronRight, MessageCircle, Newspaper, Pin, Sparkles } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Card, CardRow } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { ListRow } from "@/components/ui/list-row";
import { SectionLabel } from "@/components/ui/section-label";
import { LOKI_IA_CHAT } from "@/lib/data/chats";
import { formatChatTime } from "@/lib/chat/format";
import { useChats } from "@/hooks/use-chat";
import { useWorkspaces } from "@/stores/workspace-store";
import { DEFAULT_AVATAR_COLOR } from "@/types/models";

export function colorForChat(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  const palette = ["#00b4d8", "#1d9bf0", "#00ba7c", "#ffad1f", "#f4212e", "#6d5fc0", "#536471"];
  return palette[hash % palette.length] ?? DEFAULT_AVATAR_COLOR;
}

/**
 * Lista de chats del espacio actual: Loki IA fijado, tarjeta de
 * Publicaciones y conversaciones reales desde useChats.
 */
export function ChatList(): React.JSX.Element {
  const { currentWorkspaceId } = useWorkspaces();
  const chatsQuery = useChats(currentWorkspaceId);
  const chats = chatsQuery.data ?? [];

  const realChats = chats.filter((chat) => chat.type !== "posts");

  return (
    <div className="px-2 py-2 md:px-4">
      <ul>
        <li>
          <Link
            href="/chat/loki-ia"
            className="flex items-center gap-3 rounded-lg px-2 py-4 outline-none interactive"
          >
            <span
              aria-hidden="true"
              className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full bg-foreground text-background dark:bg-white dark:text-black"
            >
              <Icon icon={Sparkles} size={22} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate text-body font-semibold leading-6 text-foreground">
                  {LOKI_IA_CHAT.name}
                </span>
                <span className="shrink-0 rounded-full bg-surface-soft px-2 py-0.5 text-meta leading-4 text-muted-foreground">
                  Fijado
                </span>
              </span>
              <span className="block truncate text-body-sm leading-5 text-muted-foreground">
                {LOKI_IA_CHAT.preview}
              </span>
            </span>
            <span className="flex shrink-0 flex-col items-end gap-1">
              <span className="text-meta leading-4 text-muted-foreground">
                {LOKI_IA_CHAT.time}
              </span>
              <span className="flex h-4 items-center">
                <Icon icon={Pin} size={20} className="text-muted-foreground" />
              </span>
            </span>
          </Link>
        </li>
      </ul>

      <div className="mt-2 px-2 md:px-0">
        <Card>
          <Link
            href="/chat/publicaciones"
            aria-label="Ver publicaciones del espacio"
            className="block rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <CardRow minHeight="15">
              <span
                aria-hidden="true"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-background text-foreground dark:bg-surface-2"
              >
                <Icon icon={Newspaper} size={22} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body font-semibold leading-6 text-foreground">
                  Publicaciones
                </span>
                <span className="block truncate text-body-sm leading-5 text-muted-foreground">
                  Lo compartido en este espacio
                </span>
              </span>
              <Icon icon={ChevronRight} size={20} className="shrink-0 text-muted-foreground" />
            </CardRow>
          </Link>
        </Card>
      </div>

      <div className="mt-2 px-2 md:px-0">
        <SectionLabel>Conversaciones</SectionLabel>
      </div>
      {chatsQuery.isPending ? (
        <ul aria-label="Cargando conversaciones">
          {[0, 1].map((index) => (
            <li key={index} className="flex items-center gap-3 px-2 py-4" aria-hidden="true">
              <span className="h-[52px] w-[52px] animate-pulse rounded-full bg-surface-soft" />
              <span className="min-w-0 flex-1">
                <span className="block h-4 w-2/3 animate-pulse rounded-full bg-surface-soft" />
                <span className="mt-2 block h-3 w-1/2 animate-pulse rounded-full bg-surface-soft" />
              </span>
            </li>
          ))}
        </ul>
      ) : realChats.length === 0 ? (
        <EmptyState
          icon={MessageCircle}
          title="Sin conversaciones"
          description="Todavía no hay chats en este espacio. General se crea con el espacio."
        />
      ) : (
        <ul>
          {realChats.map((chat) => {
            const preview =
              chat.lastMessage === null
                ? "Sin mensajes todavía"
                : `${chat.lastMessage.authorName}: ${chat.lastMessage.text}`;
            const meta = formatChatTime(chat.lastMessage?.createdAt ?? chat.updatedAt);
            return (
              <li key={chat.id}>
                {chat.emoji ? (
                  <Link
                    href={`/chat/c?id=${chat.id}`}
                    className="flex items-center gap-3 rounded-lg px-2 py-4 outline-none interactive"
                  >
                    <Avatar emoji={chat.emoji} size={52} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-body font-semibold leading-6 text-foreground">
                        {chat.name}
                      </span>
                      <span className="block truncate text-body-sm leading-5 text-muted-foreground">
                        {preview}
                      </span>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-1">
                      <span className="text-meta leading-4 text-muted-foreground">{meta}</span>
                      <span className="flex h-4 items-center" />
                    </span>
                  </Link>
                ) : (
                  <ListRow
                    href={`/chat/c?id=${chat.id}`}
                    title={chat.name}
                    subtitle={preview}
                    meta={meta}
                    initial={chat.name.charAt(0).toUpperCase()}
                    color={colorForChat(chat.id)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {chatsQuery.isError ? (
        <p role="alert" className="px-2 py-2 text-body-sm text-danger">
          No se pudieron cargar las conversaciones.
        </p>
      ) : null}
    </div>
  );
}
