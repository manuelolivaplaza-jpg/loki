"use client";

import * as React from "react";
import { Newspaper } from "lucide-react";
import { Composer } from "@/components/chat/composer";
import { PostRow, usePostClock } from "@/components/chat/post-row";
import { ThreadPanel } from "@/components/chat/thread-panel";
import { EmptyState } from "@/components/ui/empty-state";
import { membersToCandidates, toggleReaction } from "@/lib/data/chat";
import { useMembers, usePosts, usePublishPost } from "@/hooks/use-chat";
import {
  POSTS_CHAT_ID,
  POSTS_COMMENTS_PARENT_LABEL,
  POSTS_COMMENTS_TITLE,
  POSTS_EMPTY_DESCRIPTION,
  POSTS_EMPTY_TITLE,
  POST_LIKE_EMOJI,
} from "@/lib/chat/posts";
import { LOKI_CANDIDATE } from "@/lib/chat/mentions";
import { useMessageStatusStore } from "@/lib/chat/message-status";
import { useProfileStore } from "@/stores/profile-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaces } from "@/stores/workspace-store";
import type { MessageDoc } from "@/types/chat";

/**
 * Vista de Publicaciones (T17).
 *
 * Feed estilo X unido al chat: los posts son mensajes `type: "post"` del
 * chat `posts` del espacio, ordenados por `createdAt` descendente. El
 * composer va arriba (bajo el header en móvil, centrado en la columna de
 * 760px como el chat en escritorio) y cada fila ofrece "Me gusta" y
 * "Comentar", que abre el `ThreadPanel` de T16 como panel de comentarios.
 */
export function PostsView(): React.JSX.Element {
  const { currentWorkspaceId } = useWorkspaces();
  const user = useSessionStore((state) => state.user);
  const profile = useProfileStore((state) => state.profile);
  const wsId = currentWorkspaceId;
  const currentUid = user?.uid ?? null;
  const profileName = profile?.displayName?.trim() ?? "";
  const sessionName = user?.displayName?.trim() ?? "";
  const authorName =
    profileName !== "" ? profileName : sessionName !== "" ? sessionName : "Miembro";

  const { posts, isPending, error } = usePosts(wsId);
  const publish = usePublishPost(wsId);
  const membersQuery = useMembers(wsId);
  const sendStatus = useMessageStatusStore((state) => state.status);
  const [publishError, setPublishError] = React.useState<string | null>(null);
  const [threadParent, setThreadParent] = React.useState<MessageDoc | null>(null);
  const now = usePostClock();

  // El panel de comentarios conserva el menú @ de los miembros del espacio.
  const mentionMembers = React.useMemo(
    () => membersToCandidates(membersQuery.data ?? []),
    [membersQuery.data],
  );

  const handlePublish = React.useCallback(
    (text: string, mentions: string[]) => {
      if (currentUid === null) {
        setPublishError("Inicia sesión para publicar.");
        return;
      }
      if (wsId === null || wsId === "") {
        setPublishError("Elige un espacio para publicar.");
        return;
      }
      setPublishError(null);
      publish.mutate(
        { authorId: currentUid, authorName, text, mentions },
        { onError: (err) => setPublishError(err.message) },
      );
    },
    [currentUid, wsId, authorName, publish],
  );

  // El toggle solo escribe mi uid en el corazón rojo (lo que permiten
  // las reglas): nada de reacciones de otros ni emoji distintos.
  const handleToggleLike = React.useCallback(
    (post: MessageDoc, hasReacted: boolean) => {
      if (wsId === null || currentUid === null) return;
      setPublishError(null);
      void toggleReaction(
        wsId,
        POSTS_CHAT_ID,
        post.id,
        POST_LIKE_EMOJI,
        currentUid,
        hasReacted,
      ).catch((err: unknown) => {
        setPublishError(
          err instanceof Error ? err.message : "No se pudo reaccionar.",
        );
      });
    },
    [wsId, currentUid],
  );

  // Reintenta un post fallido con el mismo id de cliente.
  const handleRetry = React.useCallback(
    (post: MessageDoc) => {
      if (wsId === null) return;
      setPublishError(null);
      publish.mutate(
        {
          authorId: post.authorId,
          authorName: post.authorName,
          text: post.text,
          mentions: post.mentions,
          messageId: post.id,
        },
        { onError: (err) => setPublishError(err.message) },
      );
    },
    [wsId, publish],
  );

  // El padre se resuelve contra la lista viva: si le llegan reacciones o
  // comentarios mientras el panel está abierto, no queda viejo.
  const threadParentLive = React.useMemo(() => {
    if (threadParent === null) return null;
    return posts.find((item) => item.id === threadParent.id) ?? threadParent;
  }, [threadParent, posts]);

  return (
    <div>
      <span className="sr-only">Publicaciones del espacio</span>
      {/* El composer va arriba y se queda pegado bajo el header del shell
          (68px en móvil, la barra de 48px en escritorio) mientras se
          recorre el feed. No usa altura fija como la conversación: aquí la
          página hace scroll y el composer se ancla con `sticky`. */}
      <div className="sticky top-[68px] z-30 bg-background md:top-12">
        <Composer
          mode="post"
          isLoki={false}
          chatName="Publicaciones"
          sending={publish.isPending}
          members={[]}
          onSend={handlePublish}
        />
        {publishError !== null ? (
          <p role="alert" className="px-4 pb-2 text-center text-body-sm text-danger">
            {publishError}
          </p>
        ) : null}
      </div>

      <div>
        {isPending ? (
          <ul aria-label="Cargando publicaciones" className="flex flex-col">
            {[0, 1, 2].map((index) => (
              <li
                key={index}
                aria-hidden="true"
                className="flex gap-3 border-b border-divider px-4 py-3"
              >
                <span className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-surface-soft" />
                <span className="min-w-0 flex-1">
                  <span className="block h-4 w-1/3 animate-pulse rounded-full bg-surface-soft" />
                  <span className="mt-2 block h-4 w-4/5 animate-pulse rounded-full bg-surface-soft" />
                </span>
              </li>
            ))}
          </ul>
        ) : error !== null ? (
          <p role="alert" className="px-4 py-8 text-center text-body-sm text-danger">
            No se pudieron cargar las publicaciones.
          </p>
        ) : posts.length === 0 ? (
          <EmptyState
            icon={Newspaper}
            title={POSTS_EMPTY_TITLE}
            description={POSTS_EMPTY_DESCRIPTION}
          />
        ) : (
          <div className="mx-auto w-full max-w-[760px]">
            <ul aria-label="Publicaciones del espacio">
              {posts.map((post) => (
                <PostRow
                  key={post.id}
                  post={post}
                  currentUid={currentUid}
                  now={now}
                  sendStatus={
                    currentUid !== null && post.authorId === currentUid
                      ? sendStatus[post.id]
                      : undefined
                  }
                  onRetry={handleRetry}
                  onToggleLike={handleToggleLike}
                  onOpenComments={setThreadParent}
                />
              ))}
            </ul>
          </div>
        )}
      </div>

      {threadParentLive !== null && wsId !== null ? (
        <ThreadPanel
          wsId={wsId}
          chatId={POSTS_CHAT_ID}
          parent={threadParentLive}
          currentUid={currentUid}
          authorName={authorName}
          members={[LOKI_CANDIDATE, ...mentionMembers]}
          onClose={() => setThreadParent(null)}
          title={POSTS_COMMENTS_TITLE}
          parentLabel={POSTS_COMMENTS_PARENT_LABEL}
          composerPlaceholder="Escribe un comentario"
        />
      ) : null}
    </div>
  );
}
