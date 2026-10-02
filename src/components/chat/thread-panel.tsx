"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import { Composer } from "@/components/chat/composer";
import {
  MESSAGE_BUBBLE_FIT_CLASS,
  MESSAGE_ROW_CLASS,
  MessageBubble,
} from "@/components/chat/message-bubble";
import type { VoiceContext } from "@/components/media/message-attachments";
import { Icon } from "@/components/ui/icon";
import { QueryRetry } from "@/components/ui/query-retry";
import { useNotifyTyping, useThread } from "@/hooks/use-chat";
import { sendMessage } from "@/lib/data/chat";
import { continueAgentRun, fetchRunsForMessages, startAgentTask } from "@/lib/data/agents";
import { AgentCardsForMessage } from "@/components/agents/agent-cards-for-message";
import {
  findInvokedAgents,
  LOKI_CANDIDATE,
  stripAgentMention,
} from "@/lib/chat/mentions";
import { POSTS_CHAT_ID } from "@/lib/chat/posts";
import { fade, fadeScale } from "@/lib/motion";
import type { MentionCandidate } from "@/lib/chat/mentions";
import type { MessageAttachment, MessageDoc } from "@/types/chat";
import { cn } from "@/lib/utils";

type ThreadPanelProps = {
  wsId: string;
  chatId: string;
  /** Mensaje padre del hilo. */
  parent: MessageDoc;
  currentUid: string | null;
  authorName: string;
  /** Miembros del espacio (para el menú @ del composer del hilo). */
  members: MentionCandidate[];
  onClose: () => void;
  /** Título del drawer: "Hilo" en el chat, "Comentarios" en Publicaciones. */
  title?: string;
  /** Etiqueta del bloque del padre: "Mensaje original" o "Publicación". */
  parentLabel?: string;
  /** Placeholder del composer de respuestas. */
  composerPlaceholder?: string;
};

/**
 * Panel de hilo (T16).
 *
 * Monta un portal en `document.body`: en escritorio es un drawer fijo
 * de 420px a la derecha (por encima del panel contextual, con scrim) y
 * en móvil un bottom sheet casi a pantalla completa. Muestra el mensaje
 * padre, las respuestas en vivo (`useThread` → `listenThread`) y un
 * composer que envía con `threadParentId`.
 *
 * Las respuestas NO se escriben con el envío optimista de
 * `useSendMessage` (ese hook inserta en la caché del timeline
 * principal); aquí va directo con `sendMessage` y las muestra el
 * listener del hilo.
 *
 * T17: `title`/`parentLabel` hacen que Publicaciones lo reutilice como
 * panel de comentarios ("Comentarios" sobre "Publicación"): el contador
 * y el estado vacío hablan de comentarios, no de respuestas.
 */
export function ThreadPanel({
  wsId,
  chatId,
  parent,
  currentUid,
  authorName,
  members,
  onClose,
  title = "Hilo",
  parentLabel = "Mensaje original",
  composerPlaceholder = "Responder en el hilo",
}: ThreadPanelProps): React.JSX.Element | null {
  const [mounted, setMounted] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const listRef = React.useRef<HTMLDivElement>(null);
  const thread = useThread(wsId, chatId, parent.id);
  const replies = React.useMemo(() => thread.data ?? [], [thread.data]);
  const { notify: notifyTyping } = useNotifyTyping(wsId, chatId, currentUid, authorName);
  const parentIsMine = currentUid !== null && parent.authorId === currentUid;
  // Contexto de transcripción del hilo: habilita "Ver transcripción" en las
  // notas de voz del padre y de las respuestas (heredan la del mensaje). El
  // autor real lo pone cada burbuja.
  const voice = React.useMemo(
    () => ({ chatId, authorId: currentUid }),
    [chatId, currentUid],
  );
  // T17: abierto desde Publicaciones el panel es de comentarios: el padre
  // se muestra con la fila plana del feed (no con burbuja) y el contador y
  // el estado vacío hablan de comentarios en vez de respuestas.
  const isPostParent = parent.type === "post";

  React.useEffect(() => {
    setMounted(true);
  }, []);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  // Las respuestas del hilo no están en el timeline: el scroll los sigue.
  React.useEffect(() => {
    const el = listRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [replies.length]);

  const handleSend = React.useCallback(
    (text: string, mentions: string[], attachments?: MessageAttachment[]) => {
      if (currentUid === null || sending) return;
      setSending(true);
      setError(null);
      const candidates: MentionCandidate[] = [LOKI_CANDIDATE, ...members];
      const invoked = findInvokedAgents(text, candidates);
      void sendMessage(wsId, chatId, {
        authorId: currentUid,
        authorName,
        text,
        mentions,
        threadParentId: parent.id,
        attachments,
        type: "user",
      })
        .then((replyId) => {
          // needs_input: la respuesta en el hilo viaja como continuación
          // (solo quien invocó; la RPC lo valida).
          if (currentUid !== null) {
            const replyUid = currentUid;
            const replyText = text;
            const replyParentId = parent.id;
            void fetchRunsForMessages([replyParentId])
              .then((runs) => {
                for (const run of runs) {
                  if (run.status !== "needs_input") continue;
                  if (run.requestedBy !== replyUid) continue;
                  void continueAgentRun(run.id, replyText).catch(() => undefined);
                }
              })
              .catch(() => undefined);
          }
          // @handle en el hilo también invoca (tarjeta bajo la respuesta).
          if (invoked.length > 0 && currentUid !== null) {
            const invokeUid = currentUid;
            void (async () => {
              for (const candidate of invoked) {
                if (candidate.kind !== "agent") continue;
                const connectionId = candidate.id.slice("agent:".length);
                if (connectionId === "") continue;
                const instruction = stripAgentMention(text, candidate);
                try {
                  await startAgentTask({
                    connectionId,
                    workspaceId: wsId,
                    chatId,
                    messageId: replyId,
                    uid: invokeUid,
                    instruction: instruction === "" ? text : instruction,
                  });
                } catch (err) {
                  setError(err instanceof Error ? err.message : "No se pudo invocar al agente.");
                  break;
                }
              }
            })();
          }
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : "No se pudo enviar.");
        })
        .finally(() => {
          setSending(false);
        });
    },
    [currentUid, sending, wsId, chatId, authorName, parent.id, members],
  );

  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <motion.button
        type="button"
        aria-label="Cerrar hilo"
        variants={fade}
        initial="hidden"
        animate="show"
        onClick={onClose}
        className="absolute inset-0 bg-black/20"
      />
      <motion.div
        variants={fadeScale}
        initial="hidden"
        animate="show"
        style={{ transformOrigin: "50% 100%" }}
        className={cn(
          "absolute flex flex-col overflow-hidden bg-background shadow-overlay",
          // Móvil: bottom sheet casi a pantalla completa.
          "inset-x-0 bottom-0 top-[6dvh] rounded-t-2xl",
          // Escritorio: drawer derecho de 420px sobre el panel contextual.
          "md:inset-y-0 md:left-auto md:right-0 md:top-0 md:w-[420px] md:rounded-none md:border-l md:border-divider",
        )}
      >
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-divider px-4">
          <h2 className="min-w-0 flex-1 truncate text-body font-semibold text-foreground">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar hilo"
            className="flex h-9 w-9 items-center justify-center rounded-full text-foreground outline-none interactive active:bg-surface-soft"
          >
            <Icon icon={X} size={20} />
          </button>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <p className="px-1 pb-1.5 text-meta font-semibold leading-4 text-muted-foreground">
            {parentLabel}
          </p>
          {isPostParent ? (
            // T17: el padre de un post se muestra como la fila plana del
            // feed (no como una burbuja de chat).
            <div className="rounded-xl border-l-2 border-accent bg-surface-2 p-3">
              <MessageBubble
                message={parent}
                isMine={parentIsMine}
                showAuthor
                showTime
                variant="post"
                voice={voice}
              />
              <AgentCardsForMessage
                wsId={wsId}
                messageId={parent.id}
                uid={currentUid}
              />
            </div>
          ) : (
            <div className="rounded-xl border-l-2 border-accent bg-surface-2 p-3">
              <div
                className={cn(
                  MESSAGE_ROW_CLASS,
                  parentIsMine ? "justify-end" : "justify-start",
                )}
              >
                <div className={MESSAGE_BUBBLE_FIT_CLASS}>
                  <MessageBubble
                    message={parent}
                    isMine={parentIsMine}
                    showAuthor
                    showTime
                    voice={voice}
                  />
                </div>
              </div>
              <AgentCardsForMessage
                wsId={wsId}
                messageId={parent.id}
                uid={currentUid}
              />
            </div>
          )}
          <p className="px-1 py-2 text-meta leading-5 text-muted-foreground">
            {replies.length === 0
              ? isPostParent
                ? "Sin comentarios todavía."
                : "Sin respuestas todavía. Responde para abrir el hilo."
              : isPostParent
                ? `${replies.length} ${replies.length === 1 ? "comentario" : "comentarios"}`
                : `${replies.length} ${replies.length === 1 ? "respuesta" : "respuestas"}`}
          </p>
          {thread.isPending && replies.length === 0 ? (
            <div className="flex flex-col gap-3" aria-hidden="true">
              <span className="h-9 w-2/3 animate-pulse rounded-[22px] bg-surface-soft" />
              <span className="h-9 w-3/5 animate-pulse rounded-[22px] bg-surface-soft" />
            </div>
          ) : null}
          {thread.isError ? (
            <QueryRetry
              message="No se pudieron cargar las respuestas."
              onRetry={() => void thread.refetch()}
            />
          ) : null}
          <ul aria-label={`Respuestas: ${title}`} className="flex flex-col gap-3">
            {replies.map((reply) => (
              <li key={reply.id}>
                <MessageReply reply={reply} currentUid={currentUid} voice={voice} />
                <div className="pt-1.5">
                  <AgentCardsForMessage wsId={wsId} messageId={reply.id} uid={currentUid} />
                </div>
              </li>
            ))}
          </ul>
        </div>

        {error !== null ? (
          <p role="alert" className="px-4 pb-1 text-center text-body-sm text-danger">
            {error}
          </p>
        ) : null}
        <Composer
          isLoki={false}
          chatName=""
          placeholder={composerPlaceholder}
          sending={sending}
          members={members}
          onSend={handleSend}
          wsId={wsId}
          mediaBucket={chatId === POSTS_CHAT_ID ? "post-media" : "chat-media"}
          onValueChange={notifyTyping}
        />
      </motion.div>
    </div>,
    document.body,
  );
}

/**
 * Una respuesta del hilo: burbuja con tope del 78% de la columna del panel.
 *
 * `voice` habilita "Ver transcripción" en las notas de voz: la transcripción
 * lleva el id del mensaje, así que hereda su visibilidad (en un DM, solo sus
 * miembros).
 */
function MessageReply({
  reply,
  currentUid,
  voice,
}: {
  reply: MessageDoc;
  currentUid: string | null;
  voice: Omit<VoiceContext, "messageId">;
}): React.JSX.Element {
  const isMine = currentUid !== null && reply.authorId === currentUid;
  return (
    <div className={cn(MESSAGE_ROW_CLASS, isMine ? "justify-end" : "justify-start")}>
      <div className={MESSAGE_BUBBLE_FIT_CLASS}>
        <MessageBubble
          message={reply}
          isMine={isMine}
          showAuthor
          showTime
          voice={voice}
        />
      </div>
    </div>
  );
}
