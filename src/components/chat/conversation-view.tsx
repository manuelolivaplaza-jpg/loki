"use client";

import * as React from "react";
import { Timestamp } from "firebase/firestore";
import { MessageCircle } from "lucide-react";
import { Composer } from "@/components/chat/composer";
import { MessageList } from "@/components/chat/message-list";
import { NewMessagesPill } from "@/components/chat/new-messages-pill";
import { EmptyState } from "@/components/ui/empty-state";
import { useChats, useMessages, useSendMessage } from "@/hooks/use-chat";
import { LOKI_IA_MESSAGES } from "@/lib/data/chats";
import { useProfileStore } from "@/stores/profile-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaces } from "@/stores/workspace-store";
import type { MessageDoc } from "@/types/chat";

const NEAR_BOTTOM_PX = 120;

function toMockAiMessages(): MessageDoc[] {
  const base = Date.now();
  return LOKI_IA_MESSAGES.map((item, index) => ({
    id: item.id,
    authorId: item.from === "me" ? "me" : "loki",
    authorName: item.from === "me" ? "Tú" : "Loki",
    text: item.text,
    mentions: [],
    replyTo: null,
    threadParentId: null,
    threadCount: 0,
    lastReplyAt: null,
    attachments: [],
    reactions: {},
    lastReaction: null,
    createdAt: Timestamp.fromMillis(base - (LOKI_IA_MESSAGES.length - index) * 60000),
    editedAt: null,
    deleted: false,
    type: item.from === "me" ? ("user" as const) : ("ai" as const),
  }));
}

function scrollToBottom(el: HTMLElement, smooth: boolean): void {
  const reduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduced ? "smooth" : "auto" });
}

/** Vista de conversación real: mensajes de Firestore + composer Grok. */
export function ConversationView({ chatId }: { chatId: string }): React.JSX.Element {
  const isLoki = chatId === "loki-ia";
  const { currentWorkspaceId } = useWorkspaces();
  const user = useSessionStore((state) => state.user);
  const profile = useProfileStore((state) => state.profile);
  const chatsQuery = useChats(isLoki ? null : currentWorkspaceId);
  const chat = React.useMemo(
    () => (chatsQuery.data ?? []).find((item) => item.id === chatId) ?? null,
    [chatsQuery.data, chatId],
  );
  const chatName = isLoki ? "Loki IA" : (chat?.name ?? "Chat");

  const messagesState = useMessages(
    isLoki ? null : currentWorkspaceId,
    isLoki ? null : chatId,
  );
  const sendMutation = useSendMessage(
    isLoki ? null : currentWorkspaceId,
    isLoki ? null : chatId,
  );

  // Loki IA: mocks locales con los mismos componentes (T18 lo conecta).
  const [lokiMessages, setLokiMessages] = React.useState<MessageDoc[] | null>(null);
  React.useEffect(() => {
    if (isLoki) setLokiMessages(toMockAiMessages());
    else setLokiMessages(null);
  }, [isLoki]);

  const messages = React.useMemo(
    () => (isLoki ? (lokiMessages ?? []) : messagesState.messages),
    [isLoki, lokiMessages, messagesState.messages],
  );
  const hasMore = isLoki ? false : messagesState.hasMore;
  const isLoadingOlder = isLoki ? false : messagesState.isLoadingOlder;
  const loadOlder = React.useCallback(async (): Promise<void> => {
    if (isLoki) return;
    await messagesState.loadOlder();
  }, [isLoki, messagesState]);

  const currentUid = user?.uid ?? null;
  const profileName = profile?.displayName?.trim() ?? "";
  const sessionName = user?.displayName?.trim() ?? "";
  const authorName = profileName !== "" ? profileName : sessionName !== "" ? sessionName : "Miembro";

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const sentinelRef = React.useRef<HTMLDivElement | null>(null);
  const nearBottomRef = React.useRef(true);
  const primedRef = React.useRef(false);
  const [animatedIds, setAnimatedIds] = React.useState<Set<string>>(new Set());
  const [showNewPill, setShowNewPill] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);

  // Apertura: scroll al final sin animación.
  React.useEffect(() => {
    primedRef.current = false;
    setAnimatedIds(new Set());
    setShowNewPill(false);
  }, [chatId]);

  // Marca como animables los ids que llegan tras el primer pintado.
  const initialIdsRef = React.useRef<Set<string> | null>(null);
  React.useEffect(() => {
    if (messages.length === 0) return;
    if (initialIdsRef.current === null) {
      initialIdsRef.current = new Set(messages.map((m) => m.id));
      const el = scrollRef.current;
      if (el !== null && !primedRef.current) {
        primedRef.current = true;
        el.scrollTop = el.scrollHeight;
      }
      return;
    }
    const known = initialIdsRef.current;
    const fresh = messages.map((m) => m.id).filter((id) => !known.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) known.add(id);
    setAnimatedIds((prev) => new Set([...prev, ...fresh]));
    const el = scrollRef.current;
    if (el === null) return;
    const last = messages[messages.length - 1];
    const mine = last !== undefined && currentUid !== null && last.authorId === currentUid;
    if (mine) {
      scrollToBottom(el, false);
      setShowNewPill(false);
      return;
    }
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < NEAR_BOTTOM_PX) {
      scrollToBottom(el, false);
    } else {
      setShowNewPill(true);
    }
  }, [messages, currentUid]);

  React.useEffect(() => {
    initialIdsRef.current = null;
  }, [chatId]);

  const onScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    nearBottomRef.current = distance < NEAR_BOTTOM_PX;
    if (nearBottomRef.current) setShowNewPill(false);
  }, []);

  // Paginación hacia atrás conservando la posición.
  React.useEffect(() => {
    const sentinel = sentinelRef.current;
    const scroller = scrollRef.current;
    if (sentinel === null || scroller === null || isLoki) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry === undefined || !entry.isIntersecting) return;
        if (!hasMore || isLoadingOlder) return;
        const el = scrollRef.current;
        const prevHeight = el?.scrollHeight ?? 0;
        const prevTop = el?.scrollTop ?? 0;
        void loadOlder().then(() => {
          requestAnimationFrame(() => {
            const next = scrollRef.current;
            if (next !== null) {
              next.scrollTop = prevTop + (next.scrollHeight - prevHeight);
            }
          });
        });
      },
      { root: scroller, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, isLoadingOlder, loadOlder, isLoki, messages.length]);

  const handleSend = React.useCallback(
    (text: string) => {
      setSendError(null);
      if (isLoki) {
        const now = Timestamp.now();
        const uid = currentUid ?? "me";
        setLokiMessages((prev) => [
          ...(prev ?? []),
          {
            id: `local-${now.toMillis()}`,
            authorId: uid,
            authorName: "Tú",
            text,
            mentions: [],
            replyTo: null,
            threadParentId: null,
            threadCount: 0,
            lastReplyAt: null,
            attachments: [],
            reactions: {},
            lastReaction: null,
            createdAt: now,
            editedAt: null,
            deleted: false,
            type: "user",
          },
        ]);
        requestAnimationFrame(() => {
          const el = scrollRef.current;
          if (el !== null) scrollToBottom(el, false);
        });
        return;
      }
      if (currentUid === null) {
        setSendError("Inicia sesión para enviar mensajes.");
        return;
      }
      sendMutation.mutate(
        { authorId: currentUid, authorName, text, mentions: [], type: "user" },
        {
          onSuccess: () => {
            requestAnimationFrame(() => {
              const el = scrollRef.current;
              if (el !== null) scrollToBottom(el, false);
            });
          },
          onError: (error) => setSendError(error.message),
        },
      );
    },
    [isLoki, currentUid, authorName, sendMutation],
  );

  const handlePillClick = React.useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    scrollToBottom(el, true);
    setShowNewPill(false);
  }, []);

  const isPending = isLoki ? lokiMessages === null : messagesState.isPending;
  const loadError = isLoki ? null : messagesState.error;

  return (
    <div className="flex h-[calc(100dvh-68px)] flex-col md:h-[calc(100dvh-48px)]">
      <span className="sr-only">Conversación con {chatName}</span>
      <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        {isPending ? (
          <ul aria-label="Cargando mensajes" className="flex flex-col gap-2 px-4 py-4">
            {[0, 1, 2].map((index) => (
              <li
                key={index}
                aria-hidden="true"
                className={index % 2 === 0 ? "flex justify-start" : "flex justify-end"}
              >
                <span className="h-10 w-2/3 animate-pulse rounded-[22px] bg-surface-soft" />
              </li>
            ))}
          </ul>
        ) : loadError ? (
          <p role="alert" className="px-4 py-8 text-center text-body-sm text-danger">
            No se pudieron cargar los mensajes.
          </p>
        ) : messages.length === 0 ? (
          <EmptyState
            icon={MessageCircle}
            title={isLoki ? "Habla con Loki" : `Bienvenido a ${chatName}`}
            description={
              isLoki
                ? "Pregunta lo que necesites para empezar."
                : "Sé la primera persona en escribir en este chat."
            }
          />
        ) : (
          <div className="mx-auto w-full max-w-[760px]">
            <MessageList
              messages={messages}
              currentUid={currentUid}
              animatedIds={animatedIds}
              topSentinelRef={sentinelRef}
              isLoadingOlder={isLoadingOlder}
              hasMore={hasMore}
            />
          </div>
        )}
      </div>

      <div className="relative bg-gradient-to-t from-background via-background/85 to-transparent">
        <div className="absolute -top-12 left-0 right-0 flex justify-center">
          <NewMessagesPill visible={showNewPill} onClick={handlePillClick} />
        </div>
        {sendError !== null ? (
          <p role="alert" className="px-4 pb-1 text-center text-body-sm text-danger">
            {sendError}
          </p>
        ) : null}
        <Composer
          chatName={chatName}
          isLoki={isLoki}
          sending={sendMutation.isPending}
          onSend={handleSend}
        />
      </div>
    </div>
  );
}
