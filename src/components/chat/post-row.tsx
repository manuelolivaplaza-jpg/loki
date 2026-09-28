"use client";

import * as React from "react";
import { Heart, MessageCircle } from "lucide-react";
import { Icon } from "@/components/ui/icon";
import { MessageBubble } from "@/components/chat/message-bubble";
import {
  hasPostLike,
  postCommentCount,
  postLikeCount,
} from "@/lib/chat/posts";
import type { MessageDoc, MessageSendStatus } from "@/types/chat";
import { cn } from "@/lib/utils";

type PostRowProps = {
  post: MessageDoc;
  currentUid: string | null;
  /** Reloj de render para el tiempo relativo (uno para toda la lista). */
  now: Date;
  /** Estado del envío optimista (solo posts propios). */
  sendStatus?: MessageSendStatus;
  onRetry?: (post: MessageDoc) => void;
  /** Alterna SOLO mi uid en el corazón rojo. */
  onToggleLike: (post: MessageDoc, hasReacted: boolean) => void;
  onOpenComments: (post: MessageDoc) => void;
};

/**
 * Fila de publicación estilo X (T17).
 *
 * No es una burbuja: `MessageBubble` en `variant="post"` pinta la fila
 * plana (avatar + nombre + tiempo relativo + texto) y aquí viven las
 * acciones, en su propia fila: "Me gusta" (icono Heart relleno y
 * `text-danger` cuando ya le di like, con contador y `aria-pressed`) y
 * "Comentar" (icono MessageCircle + `threadCount`), que abre el
 * `ThreadPanel` como panel de comentarios.
 */
export function PostRow({
  post,
  currentUid,
  now,
  sendStatus,
  onRetry,
  onToggleLike,
  onOpenComments,
}: PostRowProps): React.JSX.Element {
  const liked = hasPostLike(post, currentUid);
  const likeCount = postLikeCount(post);
  const commentCount = postCommentCount(post);

  return (
    <li className="border-b border-divider px-4 py-3 last:border-b-0">
      <MessageBubble
        message={post}
        isMine={currentUid !== null && post.authorId === currentUid}
        showAuthor
        showTime
        variant="post"
        now={now}
      />
      {sendStatus === "error" ? (
        <p className="mt-1 pl-[52px] text-meta leading-4 text-danger">
          No se pudo publicar ·{" "}
          <button
            type="button"
            onClick={() => onRetry?.(post)}
            className="font-semibold underline outline-none"
          >
            Reintentar
          </button>
        </p>
      ) : null}
      <div className="mt-1.5 flex items-center gap-1 pl-[40px]">
        <button
          type="button"
          onClick={() => onToggleLike(post, liked)}
          aria-pressed={liked}
          aria-label={
            liked
              ? "Quitar 'Me gusta' de la publicación"
              : "Dar 'Me gusta' a la publicación"
          }
          className={cn(
            "flex h-8 min-w-8 items-center gap-1 rounded-full px-2 text-meta leading-none outline-none interactive",
            liked ? "text-danger" : "text-muted-foreground",
          )}
        >
          <Icon icon={Heart} size={20} className={liked ? "fill-current" : undefined} />
          <span className="font-medium tabular-nums">{likeCount}</span>
        </button>
        <button
          type="button"
          onClick={() => onOpenComments(post)}
          aria-label={`Comentar: ${commentCount} ${commentCount === 1 ? "comentario" : "comentarios"}`}
          className="flex h-8 min-w-8 items-center gap-1 rounded-full px-2 text-meta leading-none text-muted-foreground outline-none interactive"
        >
          <Icon icon={MessageCircle} size={20} />
          <span className="font-medium tabular-nums">{commentCount}</span>
        </button>
        {sendStatus === "sending" ? (
          <span role="status" className="pl-1 text-meta leading-4 text-muted-foreground">
            Publicando…
          </span>
        ) : null}
      </div>
    </li>
  );
}

/** Reloj de los tiempos relativos: un solo timer para toda la lista. */
export function usePostClock(intervalMs = 60_000): Date {
  const [now, setNow] = React.useState(() => new Date());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
