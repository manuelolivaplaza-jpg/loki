"use client";

import * as React from "react";
import { CheckCircle2, ListPlus, MessageSquareReply, MoreHorizontal } from "lucide-react";
import {
  MESSAGE_BUBBLE_FIT_CLASS,
  MESSAGE_ROW_CLASS,
  MessageBubble,
} from "@/components/chat/message-bubble";
import { MessageContextMenu, type MessageMenuAction } from "@/components/chat/message-context-menu";
import { ReactionBar } from "@/components/chat/reaction-bar";
import { ReactionChips } from "@/components/chat/reaction-chips";
import { Icon } from "@/components/ui/icon";
import type { VoiceContext } from "@/components/media/message-attachments";
import { formatHour } from "@/lib/chat/format";
import { useMessageLinks } from "@/lib/data/message-links";
import type { MessageDoc, MessageSendStatus } from "@/types/chat";
import { cn } from "@/lib/utils";

/** Long-press en táctil antes de abrir la barra de reacciones. */
const LONG_PRESS_MS = 500;

function truncate(text: string, max = 80): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * Chip discreto del vínculo ("✓ Tarea: Comprar torta"). En vivo: si la
 * tarea se completa, el chip lo refleja (tacha el título).
 */
function MessageLinkChip({ messageId }: { messageId: string }): React.JSX.Element | null {
  const links = useMessageLinks(messageId);
  if (links.length === 0) return null;
  return (
    <ul aria-label="Convertido en" className="mt-1 flex flex-col items-start gap-1">
      {links.map((link) => (
        <li
          key={link.id}
          className="flex items-center gap-1 text-meta font-medium leading-4 text-muted-foreground"
        >
          <Icon icon={CheckCircle2} size={20} aria-hidden="true" />
          <span className={cn(link.done && "line-through")}>
            {link.kind === "task" ? "Tarea" : "Evento"}: {truncate(link.targetTitle, 40)}
          </span>
        </li>
      ))}
    </ul>
  );
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
  onConvert?: (message: MessageDoc, kind: "task" | "event" | "reminder") => void;
  /**
   * Contexto de las notas de voz ("Ver transcripción"). Lo pasa MessageList
   * solo en chats de espacio: sin él, el audio se reproduce sin transcribir.
   */
  voice?: Omit<VoiceContext, "messageId"> | null;
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
  onConvert,
  voice = null,
  disableOwnReactions = false,
}: MessageItemProps): React.JSX.Element {
  const [reactionsOpen, setReactionsOpen] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [hovered, setHovered] = React.useState(false);
  // Tras elegir un emoji con hover el mouse sigue encima: no reabrimos
  // la barra hasta que vuelva a salir de la fila.
  const [hoverDismissed, setHoverDismissed] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  // Deslizar a la izquierda revela la hora (estilo Instagram).
  const [swipeX, setSwipeX] = React.useState(0);
  const swipeRef = React.useRef({ x: 0, y: 0, active: false });
  const SWIPE_MAX = 84;

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

  const swipeEnd = React.useCallback(() => {
    swipeRef.current.active = false;
    setSwipeX(0);
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
      else if (action === "convert_task") onConvert?.(message, "task");
      else if (action === "convert_event") onConvert?.(message, "event");
      else if (action === "convert_reminder") onConvert?.(message, "reminder");
    },
    [closeUnified, message, onReply, onOpenThread, onCopy, onEdit, onDelete, onConvert],
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
          // Deslizar horizontal revela la hora; el scroll vertical lo
          // sigue gestionando el navegador.
          "touch-pan-y",
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
                swipeRef.current = {
                  x: event.clientX,
                  y: event.clientY,
                  active: true,
                };
                startTimer();
              }
            : undefined
        }
        onPointerUp={interactive ? () => { cancelTimer(); swipeEnd(); } : undefined}
        onPointerCancel={interactive ? () => { cancelTimer(); swipeEnd(); } : undefined}
        onPointerMove={
          interactive
            ? (event) => {
                const swipe = swipeRef.current;
                if (swipe.active && event.buttons !== 0) {
                  const dx = event.clientX - swipe.x;
                  const dy = event.clientY - swipe.y;
                  if (Math.abs(dx) > 8 || Math.abs(dy) > 8) cancelTimer();
                  if (dx < -10 && Math.abs(dx) > Math.abs(dy)) {
                    setSwipeX(Math.max(dx, -SWIPE_MAX));
                  }
                } else {
                  cancelTimer();
                }
              }
            : undefined
        }
        onPointerLeave={
          interactive
            ? () => {
                cancelTimer();
                swipeEnd();
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
        {/* Hora al deslizar a la izquierda (estilo Instagram) o al
            pasar el puntero en escritorio. */}
        {!wide ? (
          <span
            aria-hidden="true"
            style={{ opacity: swipeX < -8 || hovered ? 1 : 0 }}
            className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-meta tabular-nums text-muted-foreground transition-opacity duration-150"
          >
            {formatHour(message.createdAt)}
          </span>
        ) : null}
        <div
          className={cn(
            wide ? "relative w-full" : MESSAGE_BUBBLE_FIT_CLASS,
            !wide && swipeX === 0 && "transition-transform duration-150 ease-out",
          )}
          style={wide ? undefined : { transform: `translateX(${swipeX}px)` }}
        >
          <MessageBubble
            message={message}
            isMine={isMine}
            showAuthor={showAuthor}
            showTime={showTime}
            sendStatus={sendStatus}
            onRetry={onRetry}
            voice={voice}
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

          {interactive && onConvert !== undefined ? (
            <button
              type="button"
              aria-label="Convertir en tarea, evento o recordatorio"
              title="Convertir en…"
              onClick={(event) => {
                event.stopPropagation();
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
                isMine ? "-left-[68px]" : "-right-[68px]",
              )}
            >
              <Icon icon={ListPlus} size={20} />
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
          {interactive ? <MessageLinkChip messageId={message.id} /> : null}
        </div>
      ) : null}
    </div>
  );
}
