"use client";

import Link from "next/link";
import { ChevronRight, MessageCircle, Newspaper, Pin, Sparkles } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Card, CardRow } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon } from "@/components/ui/icon";
import { SectionLabel } from "@/components/ui/section-label";
import { LOKI_IA_CHAT } from "@/lib/data/chats";
import { formatChatTime } from "@/lib/chat/format";
import { POSTS_CHAT_ID } from "@/lib/chat/posts";
import { avatarColorFor } from "@/lib/avatar-color";
import { useChats, useUnread } from "@/hooks/use-chat";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaces } from "@/stores/workspace-store";
import type { ChatDoc } from "@/types/chat";

/**
 * Fila de conversación con no leídos (T14): punto azul + contador cuando
 * lastMessage es más nuevo que mi lastReadAt y el autor no soy yo.
 * Réplica el layout de ListRow sin salir del ámbito de chat (ListRow
 * vive en ui/ y no acepta contador).
 */
function ChatRow({ wsId, uid, chat }: { wsId: string; uid: string | null; chat: ChatDoc }): React.JSX.Element {
  const { unread, count } = useUnread(wsId, chat, uid);
  const preview =
    chat.lastMessage === null
      ? "Sin mensajes todavía"
      : `${chat.lastMessage.authorName}: ${chat.lastMessage.text}`;
  const meta = formatChatTime(chat.lastMessage?.createdAt ?? chat.updatedAt);
  return (
    <Link
      href={`/chat/c?id=${chat.id}`}
      aria-label={`${chat.name}${unread ? `, ${count > 0 ? count : "mensajes"} sin leer` : ""}`}
      className="flex items-center gap-3 rounded-lg px-2 py-4 outline-none interactive"
    >
      {chat.emoji ? (
        <Avatar emoji={chat.emoji} size={52} />
      ) : (
        <Avatar
          initial={chat.name.charAt(0).toUpperCase()}
          color={avatarColorFor(chat.id)}
          size={52}
        />
      )}
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
        <span className="flex h-4 items-center gap-1">
          {count > 0 ? (
            <span
              aria-hidden="true"
              className="flex h-4 min-w-4 items-center justify-center rounded-full bg-mention px-1 text-[11px] font-semibold leading-4 text-white"
            >
              {count > 99 ? "99+" : count}
            </span>
          ) : null}
          {unread ? (
            <span aria-hidden="true" className="h-2 w-2 rounded-full bg-mention" />
          ) : null}
        </span>
      </span>
    </Link>
  );
}

/**
 * Lista de chats del espacio actual: Loki IA fijado, tarjeta de
 * Publicaciones y conversaciones reales desde useChats.
 */
export function ChatList(): React.JSX.Element {
  const { currentWorkspaceId } = useWorkspaces();
  const uid = useSessionStore((state) => state.user?.uid ?? null);
  const chatsQuery = useChats(currentWorkspaceId);
  const chats = chatsQuery.data ?? [];

  const realChats = chats.filter((chat) => chat.type !== "posts");

  // T17: la tarjeta muestra el preview real del último post del chat
  // `posts` (mismo formato "Autor: texto" que las conversaciones) en vez
  // del texto genérico. Sin posts todavía mantiene la frase original.
  const postsChat = chats.find((chat) => chat.id === POSTS_CHAT_ID) ?? null;
  const postsLast = postsChat?.lastMessage ?? null;
  const postsPreview =
    postsLast === null
      ? "Lo compartido en este espacio"
      : `${postsLast.authorName}: ${postsLast.text}`;
  const postsMeta =
    postsLast === null ? null : formatChatTime(postsLast.createdAt);

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
                  {postsPreview}
                </span>
              </span>
              {postsMeta !== null ? (
                <span className="shrink-0 text-meta leading-4 text-muted-foreground">
                  {postsMeta}
                </span>
              ) : (
                <Icon icon={ChevronRight} size={20} className="shrink-0 text-muted-foreground" />
              )}
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
          {realChats.map((chat) => (
            <li key={chat.id}>
              {currentWorkspaceId !== null ? (
                <ChatRow wsId={currentWorkspaceId} uid={uid} chat={chat} />
              ) : null}
            </li>
          ))}
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
