"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { Sparkles } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Icon } from "@/components/ui/icon";
import { MessageAttachments, type VoiceContext } from "@/components/media/message-attachments";
import { SafeText } from "@/components/chat/safe-text";
import { useAuthorAvatarColor } from "@/hooks/use-avatar-color";
import { avatarColorFor } from "@/lib/avatar-color";
import { formatPostTime } from "@/lib/chat/posts";
import { parseMentionSegments } from "@/lib/chat/mentions";
import type { MessageDoc, MessageSendStatus } from "@/types/chat";
import { cn } from "@/lib/utils";

/** Tarjeta viva de lista (code splitting: solo se descarga al verla). */
const ListCard = dynamic(
  () => import("@/components/lists/list-card").then((mod) => mod.ListCard),
  {
    ssr: false,
    loading: () => (
      <span aria-label="Cargando lista" className="block h-20 animate-pulse rounded-xl bg-surface-soft" />
    ),
  },
);

/** Tarjeta de encuesta (code splitting: solo se descarga al verla). */
const PollCard = dynamic(
  () => import("@/components/polls/poll-card").then((mod) => mod.PollCard),
  {
    ssr: false,
    loading: () => (
      <span
        aria-label="Cargando encuesta"
        className="block h-32 w-[280px] max-w-full animate-pulse rounded-xl bg-surface-soft"
      />
    ),
  },
);

/**
 * Burbuja de tarjeta compartida (lista viva): título + progreso + marcar
 * desde el chat. El texto siempre por SafeText (nunca HTML).
 */
function ListShareBubble({
  message,
  showAuthor,
  showTime,
}: {
  message: MessageDoc;
  showAuthor: boolean;
  showTime: boolean;
}): React.JSX.Element {
  const listId = typeof message.meta?.list_id === "string" ? message.meta.list_id : "";
  return (
    <div className="w-full">
      {showAuthor ? (
        <p className="mb-1 ml-9 text-meta font-semibold leading-4 text-muted-foreground">
          {message.authorName}
        </p>
      ) : null}
      <div className="w-fit max-w-full rounded-[22px] border border-divider bg-card px-[14px] py-[10px]">
        <p className="mb-1 break-words text-[15px] font-semibold leading-[1.45] text-foreground">
          <SafeText text={message.text} />
        </p>
        {listId !== "" && !message.deleted ? <ListCard listId={listId} /> : null}
      </div>
      {showTime ? <MessageMeta message={message} /> : null}
    </div>
  );
}

/** Id de encuesta del mensaje ('card' con meta {kind:"poll"}). "" si no es. */
function pollIdOf(message: MessageDoc): string {
  const meta = message.meta;
  if (meta === null || meta === undefined) return "";
  if (meta.kind !== "poll") return "";
  const id = meta.poll_id;
  return typeof id === "string" && id !== "" ? id : "";
}

/**
 * Burbuja de encuesta: la tarjeta ES el mensaje (la pregunta ya viene en la
 * tarjeta, así que no se repite arriba). Las opiniones van en el hilo del
 * mensaje, como en el resto.
 */
function PollBubble({
  message,
  showAuthor,
  showTime,
}: {
  message: MessageDoc;
  showAuthor: boolean;
  showTime: boolean;
}): React.JSX.Element {
  const pollId = pollIdOf(message);
  return (
    <div className="w-full">
      {showAuthor ? (
        <p className="mb-1 ml-9 text-meta font-semibold leading-4 text-muted-foreground">
          {message.authorName}
        </p>
      ) : null}
      {message.deleted || pollId === "" ? (
        <div className="w-fit max-w-full rounded-[22px] border border-divider bg-card px-[14px] py-[10px]">
          <p className="break-words text-[15px] leading-[1.45] text-muted-foreground">
            <span className="italic">Encuesta eliminada</span>
          </p>
        </div>
      ) : (
        <div className="w-full max-w-[320px] rounded-[22px] border border-divider bg-card p-3">
          <PollCard pollId={pollId} />
        </div>
      )}
      {showTime ? <MessageMeta message={message} /> : null}
    </div>
  );
}

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
  /**
   * Datos del mensaje para las notas de voz: habilita "Ver transcripción"
   * (que hereda la visibilidad del mensaje). Sin esto el audio se reproduce
   * igual, pero no se transcribe.
   */
  voice?: Omit<VoiceContext, "messageId"> | null;
  /**
   * Cursor de escritura visible (streaming en vivo de la Edge Function).
   * El texto ya viene completo en `message`; esto solo fuerza el cursor.
   */
  streaming?: boolean;
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
          <SafeText key={index} text={segment.text} />
        ),
      )}
    </>
  );
}

/** "(editado)" (el borrado suave no cuenta como edición). La hora no se
 *  muestra bajo el mensaje: se revela al deslizar la burbuja a la izquierda
 *  (estilo Instagram) o al pasar el puntero en escritorio. */
function MessageMeta({ message }: { message: MessageDoc }): React.JSX.Element | null {
  const edited = message.editedAt !== null && !message.deleted;
  if (!edited) return null;
  return (
    <p className="mt-1 text-center text-meta leading-4 text-muted-foreground">
      (editado)
    </p>
  );
}

/**
 * Respuesta de Loki (`type: "ai"`).
 *
 * Sin burbuja y a ancho completo, con el nombre "Loki" + icono Sparkles solo
 * en el primer mensaje del grupo (como el resto de autores). El texto llega
 * completo (por realtime o por el stream en vivo); `streaming` muestra el
 * cursor mientras la Edge Function sigue generando.
 */
function AiReply({
  message,
  showAuthor,
  showTime,
  streaming = false,
}: {
  message: MessageDoc;
  showAuthor: boolean;
  showTime: boolean;
  streaming?: boolean;
}): React.JSX.Element {
  const full = message.deleted ? "" : message.text;
  const typing = !message.deleted && (streaming || full === "");
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
          <>
            <MentionedText text={full} mentions={message.mentions} />
            {/* Cursor de escritura: solo mientras llega el texto. */}
            {typing ? (
              <span
                aria-hidden="true"
                className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[3px] bg-accent"
              />
            ) : null}
          </>
        )}
      </div>
      {showTime ? <MessageMeta message={message} /> : null}
    </div>
  );
}

/**
 * Respuesta de un agente externo (`type: "agent"`, solo service role).
 *
 * Sin burbuja y a ancho completo, como la de Loki pero con el handle del bot
 * (@mi-bot). El contenido es de un tercero: solo texto seguro (SafeText, sin
 * HTML) y enlaces http/https. El progreso en vivo y las acciones viven en la
 * tarjeta bajo el mensaje que lo invocó (`AgentRunCard`).
 */
function AgentReply({
  message,
  showAuthor,
  showTime,
}: {
  message: MessageDoc;
  showAuthor: boolean;
  showTime: boolean;
}): React.JSX.Element {
  const full = message.deleted ? "" : message.text;
  return (
    <div className="w-full px-1">
      {showAuthor ? (
        <p className="flex items-center gap-1 text-meta font-semibold leading-5 text-muted-foreground">
          <span aria-hidden="true" className="text-[14px] leading-none">🤖</span>
          {message.authorName === "" ? "Bot" : message.authorName}
        </p>
      ) : null}
      <div className="mt-1 w-full text-body-sm leading-6 text-foreground">
        {message.deleted ? (
          <span className="italic text-muted-foreground">Mensaje eliminado</span>
        ) : (
          <MentionedText text={full} mentions={message.mentions} />
        )}
      </div>
      {showTime ? <MessageMeta message={message} /> : null}
    </div>
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
  voice = null,
  streaming = false,
}: MessageBubbleProps): React.JSX.Element {
  // Color determinista por autor (el mío sale del perfil).
  const avatarColor = useAuthorAvatarColor(message.authorId);
  // La transcripción de una nota de voz existe solo en mensajes de espacio (no
  // en el chat privado con Loki, que no guarda adjuntos): la pide quien la abre
  // y hereda la visibilidad del mensaje. El autor es el del mensaje (quien
  // habló), no quien está leyendo.
  const voiceCtx = React.useMemo(() => {
    if (voice === null) return null;
    return {
      ...voice,
      messageId: message.id,
      authorId: message.authorId !== "" ? message.authorId : voice.authorId,
    };
  }, [voice, message.id, message.authorId]);

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
          {message.deleted ? null : (
            <div className="mt-2">
              <MessageAttachments attachments={message.attachments} tone="flat" voice={voiceCtx} />
            </div>
          )}
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
      <AiReply
        message={message}
        showAuthor={showAuthor}
        showTime={showTime}
        streaming={streaming}
      />
    );
  }

  if (message.type === "agent") {
    return (
      <AgentReply
        message={message}
        showAuthor={showAuthor}
        showTime={showTime}
      />
    );
  }

  if (message.type === "card") {
    return pollIdOf(message) !== "" ? (
      <PollBubble message={message} showAuthor={showAuthor} showTime={showTime} />
    ) : (
      <ListShareBubble message={message} showAuthor={showAuthor} showTime={showTime} />
    );
  }

  const deleted = message.deleted;
  const body = deleted ? (
    "Mensaje eliminado"
  ) : (
    <MentionedText text={message.text} mentions={message.mentions} />
  );

  if (isMine) {
    const hasAttachments = !deleted && message.attachments.length > 0;
    return (
      <div className="flex w-fit max-w-full flex-col items-center">
        <div
          className={cn(
            "flex w-full flex-col items-end gap-1.5",
            hasAttachments && "min-w-44",
          )}
        >
          <p
            className={cn(
              "max-w-full",
              USER_BUBBLE_CLASS,
              deleted ? DELETED_BUBBLE_CLASS : "bg-bubble-mine text-white",
            )}
          >
            {body}
          </p>
          {hasAttachments ? (
            <div className="w-full">
              <MessageAttachments attachments={message.attachments} tone="mine" voice={voiceCtx} />
            </div>
          ) : null}
        </div>
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
        <div className="flex min-w-0 max-w-full flex-col gap-1.5">
          <p
            className={cn(
              "w-fit max-w-full",
              USER_BUBBLE_CLASS,
              deleted ? DELETED_BUBBLE_CLASS : "bg-bubble-other text-foreground",
            )}
          >
            {body}
          </p>
          {deleted ? null : (
            <MessageAttachments attachments={message.attachments} tone="other" voice={voiceCtx} />
          )}
        </div>
      </div>
      {showTime ? <MessageMeta message={message} /> : null}
    </div>
  );
}
