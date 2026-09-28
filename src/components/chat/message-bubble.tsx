"use client";

import { Sparkles } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Icon } from "@/components/ui/icon";
import { formatHour } from "@/lib/chat/format";
import { AVATAR_FALLBACK_COLOR } from "@/types/models";
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
};

/**
 * Burbuja de mensaje estilo Grok.
 * - Propios: bg-bubble-mine (#0F0F0F / #2A2A2A). Otros: bg-bubble-other (#F0F0F0 / #16181C).
 * - IA (type "ai"): texto sobre fondo, ancho completo, con "Loki" + Sparkles.
 * - System: centrado muted. Eliminado: itálica muted.
 * - Avatar solo en el último del grupo (showTime), nombre solo en el primero (showAuthor).
 * - Hora de 13px muted centrada bajo la burbuja del grupo, nunca al lado del avatar.
 */
export function MessageBubble({
  message,
  isMine,
  showAuthor,
  showTime,
  sendStatus,
  onRetry,
}: MessageBubbleProps): React.JSX.Element {
  if (message.type === "system") {
    return (
      <div className="flex justify-center px-4">
        <p className="text-center text-meta leading-5 text-muted-foreground">
          {message.deleted ? "Mensaje eliminado" : message.text}
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
            message.text
          )}
        </div>
        {showTime ? (
          <p className="mt-1 text-meta leading-4 text-muted-foreground">
            {formatHour(message.createdAt)}
          </p>
        ) : null}
      </div>
    );
  }

  const deleted = message.deleted;
  const body = deleted ? (
    <span className="italic text-muted-foreground">Mensaje eliminado</span>
  ) : (
    message.text
  );

  if (isMine) {
    return (
      <div className="flex flex-col items-end">
        <div className="flex max-w-[78%] flex-col items-center">
          <p
            className={cn(
              "rounded-[22px] px-[14px] py-[10px] text-[15px] leading-[1.45] break-words",
              "bg-bubble-mine text-white",
            )}
          >
            {body}
          </p>
          {showTime ? (
            <p className="mt-1 text-center text-meta leading-4 text-muted-foreground">
              {formatHour(message.createdAt)}
            </p>
          ) : null}
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
      </div>
    );
  }

  return (
    <div className="max-w-[78%]">
      {showAuthor ? (
        <p className="mb-1 ml-9 text-meta font-semibold leading-4 text-muted-foreground">
          {message.authorName}
        </p>
      ) : null}
      <div className="flex items-end gap-2">
        <span aria-hidden="true" className="flex w-7 shrink-0 justify-center">
          {showTime ? (
            <Avatar
              initial={(message.authorName || "?").charAt(0).toUpperCase()}
              color={AVATAR_FALLBACK_COLOR}
              size={28}
            />
          ) : (
            <span className="block h-7 w-7" />
          )}
        </span>
        <p
          className={cn(
            "min-w-0 rounded-[22px] px-[14px] py-[10px] text-[15px] leading-[1.45] break-words",
            "bg-bubble-other text-foreground",
          )}
        >
          {body}
        </p>
      </div>
      {showTime ? (
        <p className="ml-9 mt-1 text-center text-meta leading-4 text-muted-foreground">
          {formatHour(message.createdAt)}
        </p>
      ) : null}
    </div>
  );
}
