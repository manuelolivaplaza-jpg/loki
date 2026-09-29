"use client";

import * as React from "react";
import { MessageCircle, Sparkles } from "lucide-react";
import { AiConnecting } from "@/components/chat/ai-connecting";
import { AiSuggestions } from "@/components/chat/ai-suggestions";
import { Composer } from "@/components/chat/composer";
import { MessageList } from "@/components/chat/message-list";
import { NewMessagesPill } from "@/components/chat/new-messages-pill";
import { ThreadPanel } from "@/components/chat/thread-panel";
import { TypingIndicator } from "@/components/chat/typing-indicator";
import { EmptyState } from "@/components/ui/empty-state";
import {
  useAiMessages,
  useChats,
  useMarkChatRead,
  useMembers,
  useMessages,
  useNotifyTyping,
  useSendAiAssistantMessage,
  useSendAiMessage,
  useSendMessage,
  useTyping,
} from "@/hooks/use-chat";
import {
  deleteMessage,
  editMessage,
  membersToCandidates,
  newMessageId,
  toggleReaction,
} from "@/lib/data/chat";
import {
  buildLokiDisabledMessage,
  isAiEnabled,
  LOKI_CANDIDATE,
  mentionsLoki,
} from "@/lib/chat/mentions";
import {
  AI_CHAT_ID,
  AI_CHAT_NAME,
  AI_EMPTY_DESCRIPTION,
  AI_EMPTY_TITLE,
  AI_PLACEHOLDER,
  buildMockAiReply,
} from "@/lib/chat/ai-mock";
import { useMessageStatusStore } from "@/lib/chat/message-status";
import { useProfileStore } from "@/stores/profile-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaces } from "@/stores/workspace-store";
import type { MessageDoc, MessageReplyRef } from "@/types/chat";

const NEAR_BOTTOM_PX = 120;

function scrollToBottom(el: HTMLElement, smooth: boolean): void {
  const reduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduced ? "smooth" : "auto" });
}

/**
 * Vista de conversación real: mensajes de Firestore + composer Grok.
 *
 * Con `chatId === "loki-ia"` los mensajes salen del chat PRIVADO del usuario
 * (`users/{uid}/aiChats/loki-ia/messages`, T18): no hay paging hacia atrás,
 * ni typing, ni reacciones, y la respuesta de la IA va sin burbuja. El resto
 * de la vista (scroll, pill, composer, hilos) es el mismo de T13–T16.
 */
export function ConversationView({ chatId }: { chatId: string }): React.JSX.Element {
  // El chat de Loki no tiene typing de otras personas: la lista y los hilos
  // son de los chats de espacio (T14).
  const isLoki = chatId === AI_CHAT_ID;
  const { currentWorkspaceId } = useWorkspaces();
  const user = useSessionStore((state) => state.user);
  const profile = useProfileStore((state) => state.profile);
  const chatsQuery = useChats(isLoki ? null : currentWorkspaceId);
  const chat = React.useMemo(
    () => (chatsQuery.data ?? []).find((item) => item.id === chatId) ?? null,
    [chatsQuery.data, chatId],
  );
  const chatName = isLoki ? AI_CHAT_NAME : (chat?.name ?? "Chat");

  const messagesState = useMessages(
    isLoki ? null : currentWorkspaceId,
    isLoki ? null : chatId,
  );
  const sendMutation = useSendMessage(
    isLoki ? null : currentWorkspaceId,
    isLoki ? null : chatId,
  );

  // T18: chat privado con Loki (mensajes reales de Firestore, no mocks).
  const currentUid = user?.uid ?? null;
  const aiQuery = useAiMessages(isLoki ? currentUid : null, isLoki ? chatId : null);
  const sendAiUser = useSendAiMessage(isLoki ? currentUid : null, isLoki ? chatId : null);
  const sendAiReply = useSendAiAssistantMessage(
    isLoki ? currentUid : null,
    isLoki ? chatId : null,
  );
  // Con la IA activada se espera la callable `aiChat` (sin inventar nada).
  const [aiConnecting, setAiConnecting] = React.useState(false);

  const messages = React.useMemo(
    () => (isLoki ? (aiQuery.data ?? []) : messagesState.messages),
    [isLoki, aiQuery.data, messagesState.messages],
  );
  const hasMore = isLoki ? false : messagesState.hasMore;
  const isLoadingOlder = isLoki ? false : messagesState.isLoadingOlder;
  const loadOlder = React.useCallback(async (): Promise<void> => {
    if (isLoki) return;
    await messagesState.loadOlder();
  }, [isLoki, messagesState]);

  const profileName = profile?.displayName?.trim() ?? "";
  const sessionName = user?.displayName?.trim() ?? "";
  const authorName = profileName !== "" ? profileName : sessionName !== "" ? sessionName : "Miembro";

  // T14: typing en vivo (sin mí), aviso de escritura y marcas de lectura.
  const wsForLive = isLoki ? null : currentWorkspaceId;
  const chatForLive = isLoki ? null : chatId;
  const typingNames = useTyping(wsForLive, chatForLive, currentUid);
  // T15: miembros del espacio para el menú @ del composer.
  const membersQuery = useMembers(wsForLive);
  const mentionMembers = React.useMemo(
    () => membersToCandidates(membersQuery.data ?? []),
    [membersQuery.data],
  );
  // En el chat privado con Loki no hay menú de menciones (se habla con la IA
  // sin escribir @nombre). `wsForLive` es null ahí, así que `useMembers` no
  // consulta nada y esta lista ya sale vacía.
  const { notify: notifyTyping } = useNotifyTyping(
    wsForLive,
    chatForLive,
    currentUid,
    authorName,
  );
  const markAsRead = useMarkChatRead(wsForLive, chatForLive, currentUid);
  const sendStatus = useMessageStatusStore((state) => state.status);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const sentinelRef = React.useRef<HTMLDivElement | null>(null);
  const nearBottomRef = React.useRef(true);
  const primedRef = React.useRef(false);
  const [animatedIds, setAnimatedIds] = React.useState<Set<string>>(new Set());
  const [showNewPill, setShowNewPill] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);
  // T16: cita en el composer, edición en curso, hilo abierto y avisos
  // efímeros (copiado) que no son errores.
  const [replyTo, setReplyTo] = React.useState<MessageReplyRef | null>(null);
  const [editing, setEditing] = React.useState<{ id: string; text: string } | null>(null);
  const [threadParent, setThreadParent] = React.useState<MessageDoc | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const noticeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = React.useCallback((text: string) => {
    if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
    setNotice(text);
    noticeTimerRef.current = setTimeout(() => {
      noticeTimerRef.current = null;
      setNotice(null);
    }, 1800);
  }, []);

  React.useEffect(
    () => () => {
      if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  // Id del último mensaje: al abrir y al llegar al fondo se marca leído.
  const latestId =
    messages.length > 0 ? (messages[messages.length - 1]?.id ?? null) : null;
  const latestIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    latestIdRef.current = latestId;
    if (!isLoki && latestId !== null && nearBottomRef.current) {
      markAsRead(latestId);
    }
  }, [isLoki, latestId, markAsRead]);

  // Apertura: scroll al final sin animación.
  React.useEffect(() => {
    primedRef.current = false;
    setAnimatedIds(new Set());
    setShowNewPill(false);
    // T16: al cambiar de chat no queda cita, edición ni hilo abiertos.
    setReplyTo(null);
    setEditing(null);
    setThreadParent(null);
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
    if (nearBottomRef.current) {
      setShowNewPill(false);
      // Al llegar al fondo se actualiza la marca de lectura.
      const latestId = latestIdRef.current;
      if (!isLoki && latestId !== null) markAsRead(latestId);
    }
  }, [isLoki, markAsRead]);

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
    (text: string, mentions: string[]) => {
      setSendError(null);
      // T16: la cita vive solo en el envío siguiente.
      const quote = replyTo;
      setReplyTo(null);
      if (isLoki) {
        // T18: mi mensaje va al chat privado y la respuesta depende del flag.
        if (currentUid === null) {
          setSendError("Inicia sesión para hablar con Loki.");
          return;
        }
        setAiConnecting(false);
        sendAiUser.mutate(
          { authorName, text },
          {
            onSuccess: () => {
              requestAnimationFrame(() => {
                const el = scrollRef.current;
                if (el !== null) scrollToBottom(el, false);
              });
              if (isAiEnabled()) {
                // TODO(T18-siguiente): aquí se invocará la callable `aiChat`
                // (functions/src/index.ts) con
                // httpsCallable(getFunctions(), "aiChat", { chatId, text })
                // y la respuesta real llegará por `onSnapshot` a
                // `useAiMessages`. El deploy está PROHIBIDO en fase 1-2, así
                // que de momento solo se avisa "Conectando con Loki…" y no se
                // inventa ninguna respuesta.
                setAiConnecting(true);
                return;
              }
              // Fase 1-2 (IA apagada): respuesta MOCK escrita por la app con
              // type "ai" (las reglas permiten type "ai" al propio usuario en
              // su aiChats). Lleva el prefijo "[Simulado] " y `MessageBubble`
              // la revela palabra a palabra (30 ms).
              sendAiReply.mutate(
                { text: buildMockAiReply(text) },
                { onError: (error) => setSendError(error.message) },
              );
            },
            onError: (error) => setSendError(error.message),
          },
        );
        return;
      }
      if (currentUid === null) {
        setSendError("Inicia sesión para enviar mensajes.");
        return;
      }
      if (wsForLive === null || chatForLive === null) {
        setSendError("Falta el espacio o el chat.");
        return;
      }
      // Id de cliente para el envío optimista (el reintento reusa el mismo).
      const messageId = newMessageId(wsForLive, chatForLive);
      sendMutation.mutate(
        {
          authorId: currentUid,
          authorName,
          text,
          mentions,
          replyTo: quote,
          type: "user",
          messageId,
        },
        {
          onSuccess: () => {
            requestAnimationFrame(() => {
              const el = scrollRef.current;
              if (el !== null) scrollToBottom(el, false);
            });
            // T15/T18: si nombra a Loki ("@loki"/"@ai") y la IA está
            // desactivada (NEXT_PUBLIC_AI_ENABLED !== "true"), se avisa
            // seguido con un mensaje type "system" del propio usuario, con
            // el texto LOKI_DISABLED_TEXT y mentions ["loki-disabled"]: es un
            // aviso SUTIL y CENTRADO en el timeline (sin burbuja), no un
            // toast ni un banner. En los chats de espacio las reglas
            // prohíben type "ai" al cliente y exigen authorId == uid, así
            // que este system es lo único escribible desde el cliente.
            // T18: cuando haya backend desplegado, `onMention` escribirá la
            // respuesta real con type "ai" usando Admin SDK y este aviso
            // dejará de usarse; con el flag en "true" el cliente no inventa
            // nada.
            // El aviso NO actualiza `lastMessage`/`updatedAt` del chat
            // (`updatesChatPreview` en sendMessage excluye type "system"), así
            // que la lista sigue enseñando el último mensaje real.
            if (mentionsLoki(text, mentions) && !isAiEnabled()) {
              const disabled = buildLokiDisabledMessage(currentUid, authorName);
              sendMutation.mutate(
                {
                  authorId: disabled.authorId,
                  authorName: disabled.authorName,
                  text: disabled.text,
                  mentions: disabled.mentions,
                  type: disabled.type,
                },
                {
                  onError: (error) => setSendError(error.message),
                },
              );
            }
          },
          onError: (error) => setSendError(error.message),
        },
      );
    },
    [isLoki, currentUid, authorName, sendAiUser, sendAiReply, sendMutation, wsForLive, chatForLive, replyTo],
  );

  // --- T16: reacciones, citas, edición, borrado e hilos ----------------------

  /** Contexto real de escritura; null en el chat de Loki o sin sesión. */
  const liveContext = React.useMemo(
    () =>
      isLoki ||
      currentUid === null ||
      wsForLive === null ||
      chatForLive === null
        ? null
        : { wsId: wsForLive, chatId: chatForLive, uid: currentUid },
    [isLoki, currentUid, wsForLive, chatForLive],
  );

  /** Agrega o quita SOLO mi uid en ese emoji (lo que permiten las reglas). */
  const handleToggleReaction = React.useCallback(
    (message: MessageDoc, emoji: string, hasReacted: boolean) => {
      const ctx = liveContext;
      if (ctx === null) return;
      setSendError(null);
      void toggleReaction(
        ctx.wsId,
        ctx.chatId,
        message.id,
        emoji,
        ctx.uid,
        hasReacted,
      ).catch((error: unknown) => {
        setSendError(
          error instanceof Error ? error.message : "No se pudo reaccionar.",
        );
      });
    },
    [liveContext],
  );

  const handleReply = React.useCallback((message: MessageDoc) => {
    setEditing(null);
    setReplyTo({
      id: message.id,
      authorName: message.authorName,
      text: message.deleted ? "Mensaje eliminado" : message.text,
    });
  }, []);

  const handleCancelReply = React.useCallback(() => setReplyTo(null), []);

  const handleCopy = React.useCallback(
    (message: MessageDoc) => {
      const text = message.text;
      if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
        setSendError("Este navegador no permite copiar.");
        return;
      }
      void navigator.clipboard.writeText(text).then(
        () => showNotice("Mensaje copiado"),
        () => setSendError("No se pudo copiar."),
      );
    },
    [showNotice],
  );

  const handleEdit = React.useCallback((message: MessageDoc) => {
    setReplyTo(null);
    setEditing({ id: message.id, text: message.text });
  }, []);

  const handleCancelEdit = React.useCallback(() => setEditing(null), []);

  /** Enter en modo edición: `editMessage` con el texto y sus menciones. */
  const handleSaveEdit = React.useCallback(
    (text: string, mentions: string[]) => {
      const ctx = liveContext;
      if (ctx === null || editing === null) return;
      setSendError(null);
      void editMessage(ctx.wsId, ctx.chatId, editing.id, text, mentions).then(
        () => {
          setEditing(null);
        },
        (error: unknown) => {
          setSendError(
            error instanceof Error ? error.message : "No se pudo editar.",
          );
        },
      );
    },
    [liveContext, editing],
  );

  /** Borrado suave: el doc queda `deleted` y la burbuja muestra el aviso. */
  const handleDelete = React.useCallback(
    (message: MessageDoc) => {
      const ctx = liveContext;
      if (ctx === null) return;
      setSendError(null);
      void deleteMessage(ctx.wsId, ctx.chatId, message.id).catch(
        (error: unknown) => {
          setSendError(
            error instanceof Error ? error.message : "No se pudo eliminar.",
          );
        },
      );
    },
    [liveContext],
  );

  const handleOpenThread = React.useCallback((message: MessageDoc) => {
    setThreadParent(message);
  }, []);

  const handleCloseThread = React.useCallback(() => setThreadParent(null), []);

  // El padre se resuelve contra la lista viva: si le llegan reacciones o
  // respuestas mientras el hilo está abierto, el panel no queda viejo.
  const threadParentLive = React.useMemo(() => {
    if (threadParent === null) return null;
    return messages.find((item) => item.id === threadParent.id) ?? threadParent;
  }, [threadParent, messages]);

  // Reintenta un mensaje fallido con el mismo id de cliente.
  const handleRetry = React.useCallback(
    (message: MessageDoc) => {
      setSendError(null);
      if (isLoki || currentUid === null) return;
      const retryType =
        message.type === "post" || message.type === "system" ? message.type : "user";
      sendMutation.mutate(
        {
          authorId: message.authorId,
          authorName: message.authorName,
          text: message.text,
          mentions: message.mentions,
          replyTo: message.replyTo,
          threadParentId: message.threadParentId,
          attachments: message.attachments,
          type: retryType,
          messageId: message.id,
        },
        {
          onError: (error) => setSendError(error.message),
        },
      );
    },
    [isLoki, currentUid, sendMutation],
  );

  const handlePillClick = React.useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    scrollToBottom(el, true);
    setShowNewPill(false);
  }, []);

  // Sin uid no hay chat privado que escuchar: `useAiMessages` queda
  // deshabilitado y su query "pendiente" para siempre, así que el esqueleto
  // solo se muestra cuando sí hay sesión (el resto de la vista ya avisa al
  // enviar con "Inicia sesión para hablar con Loki.").
  const isPending = isLoki
    ? currentUid !== null && aiQuery.isPending
    : messagesState.isPending;
  const loadError = isLoki ? aiQuery.error : messagesState.error;

  /** Un chip de sugerencia se envía como mensaje del usuario (T18). */
  const handleSuggestion = React.useCallback(
    (text: string) => {
      handleSend(text, []);
    },
    [handleSend],
  );

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
          isLoki ? (
            // T18: estado vacío con los chips de arranque. Al tocar uno se
            // envía su texto como mensaje del usuario.
            <div className="mx-auto w-full max-w-[760px] px-4">
              <EmptyState
                icon={Sparkles}
                title={AI_EMPTY_TITLE}
                description={AI_EMPTY_DESCRIPTION}
                // Menos padding abajo: los chips van justo debajo y no hace
                // falta el aire de 64px del estado vacío normal.
                className="pb-6"
              />
              <AiSuggestions onPick={handleSuggestion} />
            </div>
          ) : (
            <EmptyState
              icon={MessageCircle}
              title={`Bienvenido a ${chatName}`}
              description="Sé la primera persona en escribir en este chat."
            />
          )
        ) : (
          <div className="mx-auto w-full max-w-[760px]">
            <MessageList
              messages={messages}
              currentUid={currentUid}
              animatedIds={animatedIds}
              topSentinelRef={sentinelRef}
              isLoadingOlder={isLoadingOlder}
              hasMore={hasMore}
              sendStatus={sendStatus}
              onRetryMessage={handleRetry}
              onToggleReaction={handleToggleReaction}
              onReply={handleReply}
              onOpenThread={handleOpenThread}
              onCopy={handleCopy}
              onEdit={handleEdit}
              onDelete={handleDelete}
            />
          </div>
        )}
      </div>

      {!isLoki ? <TypingIndicator names={typingNames} /> : null}
      {isLoki && aiConnecting ? <AiConnecting /> : null}
      <div className="relative bg-gradient-to-t from-background via-background/85 to-transparent">
        <div className="absolute -top-12 left-0 right-0 flex justify-center">
          <NewMessagesPill visible={showNewPill} onClick={handlePillClick} />
        </div>
        {sendError !== null ? (
          <p role="alert" className="px-4 pb-1 text-center text-body-sm text-danger">
            {sendError}
          </p>
        ) : null}
        {notice !== null ? (
          <p
            role="status"
            className="px-4 pb-1 text-center text-body-sm text-muted-foreground"
          >
            {notice}
          </p>
        ) : null}
        <Composer
          chatName={chatName}
          isLoki={isLoki}
          sending={
            isLoki
              ? sendAiUser.isPending || sendAiReply.isPending
              : sendMutation.isPending
          }
          placeholder={isLoki ? AI_PLACEHOLDER : undefined}
          members={mentionMembers}
          onSend={handleSend}
          onValueChange={notifyTyping}
          edit={editing}
          onSaveEdit={handleSaveEdit}
          onCancelEdit={handleCancelEdit}
          replyTo={replyTo}
          onCancelReply={handleCancelReply}
        />
      </div>

      {threadParentLive !== null && wsForLive !== null && chatForLive !== null ? (
        <ThreadPanel
          wsId={wsForLive}
          chatId={chatForLive}
          parent={threadParentLive}
          currentUid={currentUid}
          authorName={authorName}
          members={[LOKI_CANDIDATE, ...mentionMembers]}
          onClose={handleCloseThread}
        />
      ) : null}
    </div>
  );
}
