"use client";

import * as React from "react";
import { MessageSquareReply, MoreHorizontal } from "lucide-react";
import {
  MESSAGE_BUBBLE_FIT_CLASS,
  MESSAGE_ROW_CLASS,
  MessageBubble,
} from "@/components/chat/message-bubble";
import { MessageContextMenu, type MessageMenuAction } from "@/components/chat/message-context-menu";
import { ReactionBar } from "@/components/chat/reaction-bar";
import { ReactionChips } from "@/components/chat/reaction-chips";
import { Icon } from "@/components/ui/icon";
import type { MessageDoc, MessageSendStatus } from "@/types/chat";
import { cn } from "@/lib/utils";

/** Long-press en táctil antes de abrir la barra de reacciones. */
const LONG_PRESS_MS = 500;

function truncate(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

type MessageItemProps = {
  message: MessageDoc;
  isMine: boolean;
  showAuthor: boolean;
  showTime: boolean;
  currentUid: string | null;
  sendStatus?: MessageSendStatus;
  onRetry?: (message: MessageDoc) => void;
  onToggleReaction: (message: MessageDoc, emoji: string, hasReacted: boolean) => void;
  onReply: (message: MessageDoc) => void;
  onOpenThread: (message: MessageDoc) => void;
  onCopy: (message: MessageDoc) => void;
  onEdit: (message: MessageDoc) => void;
  onDelete: (message: MessageDoc) => void;
  /** Chat de IA: oculta reacciones en los mensajes propios. */
  disableOwnReactions?: boolean;
};

/**
 * Mensaje interactivo (T16, menú unificado T34).
 *
 * Gestos: long-press 500ms en táctil, click derecho en escritorio o botón
 * "…" abren EL MISMO menú unificado: emojis de `ReactionBar` arriba y
 * acciones de `MessageContextMenu` abajo (Responder, Responder en hilo,
 * Copiar, Editar, Eliminar). La barra y el menú cuelgan de la burbuja (no
 * de la fila) y se alinean al borde exterior, así que nunca se salen de
 * pantalla. Debajo: cita `replyTo`, chips de reacciones y "N respuestas".
 */
export function MessageItem({
  message,
  isMine,
  showAuthor,
  showTime,
  currentUid,
  sendStatus,
  onRetry,
  onToggleReaction,
  onReply,
  onOpenThread,
  onCopy,
  onEdit,
  onDelete,
  disableOwnReactions = false,
}: MessageItemProps): React.JSX.Element {
  const [reactionsOpen, setReactionsOpen] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [hovered, setHovered] = React.useState(false);
  // Tras elegir un emoji con hover el mouse sigue encima: no reabrimos
  // la barra hasta que vuelva a salir de la fila.
  const [hoverDismissed, setHoverDismissed] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // IA y mensajes de sistema no admiten reacciones ni menú.
  const interactive =
    message.type !== "system" && message.type !== "ai" && !message.deleted;
  // En el chat de IA no se reacciona a los mensajes propios.
  const ownReactionsOff = disableOwnReactions && isMine;
  // IA y system ocupan toda la columna (sin el tope del 78%).
  const wide = message.type === "system" || message.type === "ai";

  const cancelTimer = React.useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const openUnified = React.useCallback(() => {
    setReactionsOpen(true);
    setMenuOpen(true);
  }, []);

  const openFromLongPress = React.useCallback(() => {
    openUnified();
  }, [openUnified]);

  const startTimer = React.useCallback(() => {
    if (!interactive) return;
    cancelTimer();
    timerRef.current = setTimeout(openFromLongPress, LONG_PRESS_MS);
  }, [interactive, cancelTimer, openFromLongPress]);

  React.useEffect(() => cancelTimer, [cancelTimer]);

  const closeUnified = React.useCallback(() => {
    cancelTimer();
    setReactionsOpen(false);
    setMenuOpen(false);
    // Con el puntero todavía encima, sin esto la barra volvería a salir.
    setHoverDismissed(true);
  }, [cancelTimer]);

  const closeReactions = React.useCallback(() => {
    setReactionsOpen(false);
    setHoverDismissed(true);
  }, []);

  // Cambia el mensaje (o el grupo): nada de menús heredados. El id previo
  // en un ref evita que el reset corra también al MONTAR: si dejara
  // hoverDismissed=true, el PRIMER hover del ratón no abriría la barra
  // (solo aparecería al salir y volver a entrar).
  const prevMessageIdRef = React.useRef(message.id);
  React.useEffect(() => {
    if (prevMessageIdRef.current === message.id) return;
    prevMessageIdRef.current = message.id;
    cancelTimer();
    setReactionsOpen(false);
    setMenuOpen(false);
    setHovered(false);
    setHoverDismissed(false);
  }, [message.id, cancelTimer]);

  const handleAction = React.useCallback(
    (action: MessageMenuAction) => {
      closeUnified();
      if (action === "reply") onReply(message);
      else if (action === "thread") onOpenThread(message);
      else if (action === "copy") onCopy(message);
      else if (action === "edit") onEdit(message);
      else if (action === "delete") onDelete(message);
    },
    [closeUnified, message, onReply, onOpenThread, onCopy, onEdit, onDelete],
  );

  const selectReaction = React.useCallback(
    (emoji: string) => {
      const uids = message.reactions?.[emoji] ?? [];
      onToggleReaction(
        message,
        emoji,
        currentUid !== null && uids.includes(currentUid),
      );
      closeUnified();
    },
    [message, currentUid, onToggleReaction, closeUnified],
  );

  const quote = message.replyTo;
  const threadCount = message.threadCount ?? 0;
  const showThreadLink = threadCount > 0 && message.threadParentId === null;
  const showReactions =
    interactive && !ownReactionsOff && (reactionsOpen || (hovered && !hoverDismissed));

  return (
    <div
      className={cn(
        "group relative flex w-full flex-col",
        isMine ? "items-end" : "items-start",
      )}
    >
      {quote ? (
        <div
          aria-label={`En respuesta a ${quote.authorName}`}
          className="mb-1 w-fit max-w-[78%] rounded-lg border-l-2 border-accent/60 bg-surface-soft px-2.5 py-1.5"
        >
          <p className="truncate text-meta font-semibold leading-4 text-accent">
            {quote.authorName}
          </p>
          <p className="truncate text-meta leading-4 text-muted-foreground">
            {truncate(quote.text)}
          </p>
        </div>
      ) : null}

      <div
        className={cn(
          MESSAGE_ROW_CLASS,
          // Sin selección ni callout de iOS: en esta zona el long-press
          // abre reacciones y menú.
          "long-press",
          !wide && (isMine ? "justify-end" : "justify-start"),
        )}
        onContextMenu={
          interactive
            ? (event) => {
                event.preventDefault();
                // Click derecho abre EL MISMO menú unificado que el
                // long-press: emojis arriba + acciones abajo.
                openUnified();
              }
            : undefined
        }
        onPointerDown={
          interactive
            ? (event) => {
                // Dentro de la barra o del menú ya está abierto: el
                // long-press no vuelve a dispararlos.
                if ((event.target as HTMLElement).closest("[data-floating]") !== null) {
                  return;
                }
                startTimer();
              }
            : undefined
        }
        onPointerUp={interactive ? cancelTimer : undefined}
        onPointerCancel={interactive ? cancelTimer : undefined}
        onPointerMove={interactive ? cancelTimer : undefined}
        onPointerLeave={
          interactive
            ? () => {
                cancelTimer();
                setHovered(false);
                setHoverDismissed(false);
              }
            : undefined
        }
        onPointerEnter={
          interactive
            ? (event) => {
                if (event.pointerType !== "mouse") return;
                setHovered(true);
              }
            : undefined
        }
        // Con teclado la fila se abre al recibir el foco (el único control
        // que hay dentro es el botón "..."), así la barra es alcanzable
        // sin ratón.
        onFocus={interactive ? () => setHovered(true) : undefined}
        onBlur={
          interactive
            ? (event) => {
                if (event.currentTarget.contains(event.relatedTarget as Node)) return;
                setHovered(false);
              }
            : undefined
        }
      >
        <div
          className={cn(
            wide ? "relative w-full" : MESSAGE_BUBBLE_FIT_CLASS,
          )}
        >
          <MessageBubble
            message={message}
            isMine={isMine}
            showAuthor={showAuthor}
            showTime={showTime}
            sendStatus={sendStatus}
            onRetry={onRetry}
          />

          {interactive ? (
            <button
              type="button"
              aria-label="Abrir menú del mensaje"
              aria-haspopup="menu"
              aria-expanded={menuOpen || reactionsOpen}
              onClick={(event) => {
                event.stopPropagation();
                // El botón "…" abre el mismo menú unificado.
                if (menuOpen || reactionsOpen) {
                  closeUnified();
                } else {
                  openUnified();
                }
              }}
              onPointerDown={(event) => event.stopPropagation()}
              className={cn(
                "absolute -top-3 hidden h-7 w-7 items-center justify-center rounded-full bg-background shadow-float outline-none",
                "md:flex md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100",
                isMine ? "-left-9" : "-right-9",
              )}
            >
              <Icon icon={MoreHorizontal} size={20} />
            </button>
          ) : null}

          {showReactions ? (
            <ReactionBar
              isMine={isMine}
              onSelect={selectReaction}
              onClose={closeReactions}
            />
          ) : null}

          {interactive && menuOpen ? (
            <MessageContextMenu
              message={message}
              isMine={isMine}
              onAction={handleAction}
              onClose={() => setMenuOpen(false)}
            />
          ) : null}
        </div>
      </div>

      {interactive ? (
        <div
          className={cn(
            "flex max-w-[78%] flex-col",
            isMine ? "items-end" : "items-start",
          )}
        >
          {!ownReactionsOff ? (
            <ReactionChips
              reactions={message.reactions ?? {}}
              currentUid={currentUid}
              onToggle={(emoji, hasReacted) =>
                onToggleReaction(message, emoji, hasReacted)
              }
            />
          ) : null}
          {showThreadLink ? (
            <button
              type="button"
              onClick={() => onOpenThread(message)}
              aria-label={`Abrir hilo con ${threadCount} ${threadCount === 1 ? "respuesta" : "respuestas"}`}
              className="mt-1 flex items-center gap-1 text-meta font-medium leading-4 text-accent outline-none interactive"
            >
              <Icon icon={MessageSquareReply} size={20} />
              {threadCount} {threadCount === 1 ? "respuesta" : "respuestas"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
