"use client";

import * as React from "react";
import { Sparkles } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Icon } from "@/components/ui/icon";
import { useAuthorAvatarColor } from "@/hooks/use-avatar-color";
import { avatarColorFor } from "@/lib/avatar-color";
import { formatHour } from "@/lib/chat/format";
import { formatPostTime } from "@/lib/chat/posts";
import { parseMentionSegments } from "@/lib/chat/mentions";
import type { MessageDoc, MessageSendStatus } from "@/types/chat";
import { cn } from "@/lib/utils";

type MessageBubbleProps = {
  message: MessageDoc;
  isMine: boolean;
  /** Mostrar avatar + nombre (primer mensaje del grupo). */
  showAuthor: boolean;
  /** Mostrar hora bajo el mensaje (último del grupo). */
  showTime: boolean;
  /** Estado local del envío optimista (solo mensajes propios). */
  sendStatus?: MessageSendStatus;
  /** Reintenta el envío con el mismo id de cliente. */
  onRetry?: (message: MessageDoc) => void;
  /**
   * T17: `post` no es una burbuja sino la fila plana del feed de
   * publicaciones (avatar + nombre + tiempo relativo + texto, sin
   * alineación por autor). Lo usa `PostRow` y el padre del panel de
   * comentarios.
   */
  variant?: "bubble" | "post";
  /** Reloj para el tiempo relativo de la fila de post. */
  now?: Date;
};

/**
 * Fila de mensaje: ocupa TODO el ancho de la columna.
 *
 * Importa (el `max-w-[78%]` de la burbuja necesita una base real):
 * si la fila encoge al contenido, un `max-width` en % se resuelve contra
 * ese ancho intrínseco y las burbujas cortas se parten a la mitad del
 * ancho disponible. La burbuja crece dentro de `MESSAGE_BUBBLE_FIT_CLASS`.
 */
export const MESSAGE_ROW_CLASS = "relative flex w-full";

/** Burbuja: `w-fit` (crece con el texto) con tope del 78% de la columna. */
export const MESSAGE_BUBBLE_FIT_CLASS = "relative w-fit max-w-[78%]";

/** Base común de las burbujas de usuario (mismo radio y ritmo en ambos lados). */
const USER_BUBBLE_CLASS =
  "break-words rounded-[22px] px-[14px] py-[10px] text-[15px] leading-[1.45]";

/**
 * Borrado suave: sin relleno sólido (pesaba como una burbuja real), solo
 * borde 1px `divider` + itálica muted, con el mismo radio y alineado
 * según el autor. Idéntico en claro y en oscuro (los tokens ya cambian).
 */
const DELETED_BUBBLE_CLASS = "border border-divider italic text-muted-foreground";

/**
 * Burbuja de mensaje estilo Grok.
 * - Propios: bg-bubble-mine (#0F0F0F / #2A2A2A). Otros: bg-bubble-other (#F0F0F0 / #16181C).
 * - IA (type "ai"): texto sobre fondo, ancho completo, con "Loki" + Sparkles.
 * - System: centrado muted. Eliminado: sin relleno, borde 1px divider e
 *   itálica muted (mismo radio, alineado según el autor, sin interacción).
 * - Menciones conocidas (@Nombre o lookup por mentions[]): color mention
 *   (#1D9BF0), peso 600, sin subrayado. El texto plano sigue igual.
 * - Avatar solo en el último del grupo (showTime), nombre solo en el primero (showAuthor).
 * - Hora de 13px muted centrada bajo la burbuja del grupo, nunca al lado del avatar.
 *   Si el mensaje fue editado, la misma línea añade "(editado)".
 * - El ancho (78%) lo aplica el contenedor de la fila
 *   (`MESSAGE_BUBBLE_FIT_CLASS`): aquí solo hay `max-w-full` para no
 *   encoger la burbuja dos veces.
 */
function MentionedText({
  text,
  mentions,
}: {
  text: string;
  mentions?: readonly string[];
}): React.JSX.Element {
  const segments = React.useMemo(
    () => parseMentionSegments(text, undefined, mentions),
    [text, mentions],
  );
  return (
    <>
      {segments.map((segment, index) =>
        segment.isMention ? (
          <span
            key={index}
            className="font-semibold text-mention no-underline"
          >
            {segment.text}
          </span>
        ) : (
          <React.Fragment key={index}>{segment.text}</React.Fragment>
        ),
      )}
    </>
  );
}

/** "HH:mm · (editado)" (el borrado suave no cuenta como edición). */
function MessageMeta({ message }: { message: MessageDoc }): React.JSX.Element {
  const edited = message.editedAt !== null && !message.deleted;
  return (
    <p className="mt-1 text-center text-meta leading-4 text-muted-foreground">
      {formatHour(message.createdAt)}
      {edited ? " · (editado)" : ""}
    </p>
  );
}

export function MessageBubble({
  message,
  isMine,
  showAuthor,
  showTime,
  sendStatus,
  onRetry,
  variant = "bubble",
  now,
}: MessageBubbleProps): React.JSX.Element {
  // Color determinista por autor (el mío sale del perfil).
  const avatarColor = useAuthorAvatarColor(message.authorId);

  // T17: fila plana de publicación (no hay burbuja ni lado a lado).
  if (variant === "post") {
    const name = message.authorName.trim() === "" ? "Miembro" : message.authorName;
    return (
      <div className="flex gap-3">
        <Avatar
          initial={name.charAt(0).toUpperCase()}
          color={avatarColorFor(message.authorId)}
          size={40}
        />
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <span className="min-w-0 truncate text-body-sm font-semibold leading-5 text-foreground">
              {name}
            </span>
            <span className="shrink-0 text-meta leading-5 text-muted-foreground">
              {formatPostTime(message.createdAt, now ?? new Date())}
            </span>
          </p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-body-sm leading-5 text-foreground">
            <MentionedText text={message.text} mentions={message.mentions} />
          </p>
        </div>
      </div>
    );
  }

  if (message.type === "system") {
    return (
      <div className="flex justify-center px-4">
        <p className="text-center text-meta leading-5 text-muted-foreground">
          {message.deleted ? (
            "Mensaje eliminado"
          ) : (
            <MentionedText text={message.text} mentions={message.mentions} />
          )}
        </p>
      </div>
    );
  }

  if (message.type === "ai") {
    return (
      <div className="w-full px-1">
        {showAuthor ? (
          <p className="flex items-center gap-1 text-meta font-semibold leading-5 text-muted-foreground">
            <Icon icon={Sparkles} size={20} />
            Loki
          </p>
        ) : null}
        <div className="mt-1 w-full text-body-sm leading-6 text-foreground">
          {message.deleted ? (
            <span className="italic text-muted-foreground">Mensaje eliminado</span>
          ) : (
            <MentionedText text={message.text} mentions={message.mentions} />
          )}
        </div>
        {showTime ? <MessageMeta message={message} /> : null}
      </div>
    );
  }

  const deleted = message.deleted;
  const body = deleted ? (
    "Mensaje eliminado"
  ) : (
    <MentionedText text={message.text} mentions={message.mentions} />
  );

  if (isMine) {
    return (
      <div className="flex w-fit max-w-full flex-col items-center">
        <p
          className={cn(
            "max-w-full",
            USER_BUBBLE_CLASS,
            deleted ? DELETED_BUBBLE_CLASS : "bg-bubble-mine text-white",
          )}
        >
          {body}
        </p>
        {showTime ? <MessageMeta message={message} /> : null}
        {sendStatus === "error" ? (
          <p className="mt-1 text-center text-meta leading-4 text-danger">
            No se pudo enviar ·{" "}
            <button
              type="button"
              onClick={() => onRetry?.(message)}
              className="font-semibold underline outline-none"
            >
              Reintentar
            </button>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="w-full">
      {showAuthor ? (
        <p className="mb-1 ml-9 text-meta font-semibold leading-4 text-muted-foreground">
          {message.authorName}
        </p>
      ) : null}
      <div className="flex w-full items-end gap-2">
        <span aria-hidden="true" className="flex w-7 shrink-0 justify-center">
          {showTime ? (
            <Avatar
              initial={(message.authorName || "?").charAt(0).toUpperCase()}
              color={avatarColor}
              size={28}
            />
          ) : (
            <span className="block h-7 w-7" />
          )}
        </span>
        <p
          className={cn(
            "min-w-0 max-w-full",
            USER_BUBBLE_CLASS,
            deleted ? DELETED_BUBBLE_CLASS : "bg-bubble-other text-foreground",
          )}
        >
          {body}
        </p>
      </div>
      {showTime ? <MessageMeta message={message} /> : null}
    </div>
  );
}
