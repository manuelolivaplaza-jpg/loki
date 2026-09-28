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
import { Icon } from "@/components/ui/icon";
import { useNotifyTyping, useThread } from "@/hooks/use-chat";
import { sendMessage } from "@/lib/data/chat";
import { fade, fadeScale } from "@/lib/motion";
import type { MentionCandidate } from "@/lib/chat/mentions";
import type { MessageDoc } from "@/types/chat";
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
 */
export function ThreadPanel({
  wsId,
  chatId,
  parent,
  currentUid,
  authorName,
  members,
  onClose,
}: ThreadPanelProps): React.JSX.Element | null {
  const [mounted, setMounted] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [sending, setSending] = React.useState(false);
  const listRef = React.useRef<HTMLDivElement>(null);
  const thread = useThread(wsId, chatId, parent.id);
  const replies = React.useMemo(() => thread.data ?? [], [thread.data]);
  const { notify: notifyTyping } = useNotifyTyping(wsId, chatId, currentUid, authorName);
  const parentIsMine = currentUid !== null && parent.authorId === currentUid;

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
    (text: string, mentions: string[]) => {
      if (currentUid === null || sending) return;
      setSending(true);
      setError(null);
      void sendMessage(wsId, chatId, {
        authorId: currentUid,
        authorName,
        text,
        mentions,
        threadParentId: parent.id,
        type: "user",
      })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : "No se pudo enviar.");
        })
        .finally(() => {
          setSending(false);
        });
    },
    [currentUid, sending, wsId, chatId, authorName, parent.id],
  );

  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50"
      role="dialog"
      aria-modal="true"
      aria-label={`Hilo de ${parent.authorName}`}
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
            Hilo
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
            Mensaje original
          </p>
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
                />
              </div>
            </div>
          </div>
          <p className="px-1 py-2 text-meta leading-5 text-muted-foreground">
            {replies.length === 0
              ? "Sin respuestas todavía. Responde para abrir el hilo."
              : `${replies.length} ${replies.length === 1 ? "respuesta" : "respuestas"}`}
          </p>
          {thread.isPending && replies.length === 0 ? (
            <div className="flex flex-col gap-3" aria-hidden="true">
              <span className="h-9 w-2/3 animate-pulse rounded-[22px] bg-surface-soft" />
              <span className="h-9 w-3/5 animate-pulse rounded-[22px] bg-surface-soft" />
            </div>
          ) : null}
          {thread.isError ? (
            <p role="alert" className="py-2 text-center text-body-sm text-danger">
              No se pudieron cargar las respuestas.
            </p>
          ) : null}
          <ul aria-label="Respuestas del hilo" className="flex flex-col gap-3">
            {replies.map((reply) => (
              <li key={reply.id}>
                <MessageReply reply={reply} currentUid={currentUid} />
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
          placeholder="Responder en el hilo"
          sending={sending}
          members={members}
          onSend={handleSend}
          onValueChange={notifyTyping}
        />
      </motion.div>
    </div>,
    document.body,
  );
}

/** Una respuesta del hilo: burbuja con tope del 78% de la columna del panel. */
function MessageReply({
  reply,
  currentUid,
}: {
  reply: MessageDoc;
  currentUid: string | null;
}): React.JSX.Element {
  const isMine = currentUid !== null && reply.authorId === currentUid;
  return (
    <div className={cn(MESSAGE_ROW_CLASS, isMine ? "justify-end" : "justify-start")}>
      <div className={MESSAGE_BUBBLE_FIT_CLASS}>
        <MessageBubble message={reply} isMine={isMine} showAuthor showTime />
      </div>
    </div>
  );
}
