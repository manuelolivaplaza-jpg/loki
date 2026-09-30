"use client";

import * as React from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  ensurePostsChat,
  fetchAiMessages,
  fetchChats,
  fetchLatestMessages,
  fetchOlderMessages,
  fetchReactionsFor,
  fetchThread,
  fetchUnreadCount,
  listenAiMessages,
  listenChats,
  listenLatestMessages,
  listenMembers,
  listenMyRead,
  listenPosts,
  listenReactions,
  listenThread,
  listenTyping,
  listMembers,
  markChatRead,
  newMessageId,
  sendAiAssistantMessage,
  sendAiUserMessage,
  sendMessage,
  setTyping,
  clearTyping,
  type SendMessageInput,
} from "@/lib/data/chat";
import { useMessageStatusStore } from "@/lib/chat/message-status";
import { isPostMessage, POSTS_CHAT_ID } from "@/lib/chat/posts";
import type {
  ChatDoc,
  MessageAttachment,
  MessageDoc,
  ReadReceiptDoc,
  TypingDoc,
} from "@/types/chat";
import type { WorkspaceMember } from "@/types/models";
// `Timestamp` local (los tipos públicos lo exigen; ver `src/lib/timestamp.ts`).
import { Timestamp } from "@/lib/timestamp";
import { useSessionStore } from "@/stores/session-store";

function byCreatedAtAsc(a: MessageDoc, b: MessageDoc): number {
  const left = a.createdAt?.toMillis() ?? Number.POSITIVE_INFINITY;
  const right = b.createdAt?.toMillis() ?? Number.POSITIVE_INFINITY;
  if (left !== right) return left - right;
  return a.id.localeCompare(b.id);
}

function byCreatedAtDesc(a: MessageDoc, b: MessageDoc): number {
  const left = a.createdAt?.toMillis() ?? Number.POSITIVE_INFINITY;
  const right = b.createdAt?.toMillis() ?? Number.POSITIVE_INFINITY;
  if (left !== right) return right - left;
  return b.id.localeCompare(a.id);
}

/**
 * Fusiona mensajes nuevos sobre los que ya hay en caché sin duplicar ids.
 * `sort` decide el orden final: el timeline del chat va de más antiguo a
 * más nuevo y el feed de publicaciones (T17) al revés.
 */
function mergeUnique(
  current: MessageDoc[],
  incoming: MessageDoc[],
  sort: (a: MessageDoc, b: MessageDoc) => number = byCreatedAtAsc,
): MessageDoc[] {
  // Ids con estado local (optimistas): la versión del servidor siempre
  // los reemplaza al confirmar, aunque el reloj del cliente difiera.
  const localStatus = useMessageStatusStore.getState().status;
  const byId = new Map<string, MessageDoc>();
  for (const item of current) {
    byId.set(item.id, item);
  }
  // La versión que llega después (snapshot en vivo) reemplaza a la
  // cacheada: un mensaje con createdAt null pendiente es sustituido
  // por el confirmado sin duplicar ids.
  for (const item of incoming) {
    const prev = byId.get(item.id);
    if (prev === undefined) {
      byId.set(item.id, item);
      continue;
    }
    // Optimista local vs confirmado del servidor: gana el servidor.
    if (prev.id in localStatus) {
      byId.set(item.id, item);
      continue;
    }
    const prevPending = prev.createdAt == null;
    const nextPending = item.createdAt == null;
    // La versión confirmada siempre gana a la pendiente.
    if (prevPending && !nextPending) {
      byId.set(item.id, item);
      continue;
    }
    if (!prevPending && nextPending) {
      continue;
    }
    const prevMs = prev.createdAt?.toMillis() ?? Number.POSITIVE_INFINITY;
    const nextMs = item.createdAt?.toMillis() ?? Number.POSITIVE_INFINITY;
    // Gana la versión confirmada más nueva; a igualdad, la última vista.
    if (nextMs >= prevMs) {
      byId.set(item.id, item);
    }
  }
  return [...byId.values()].sort(sort);
}

export function useChats(wsId: string | null): UseQueryResult<ChatDoc[], Error> {
  const queryClient = useQueryClient();
  const uid = useSessionStore((state) => state.user?.uid ?? null);
  const query = useQuery<ChatDoc[], Error>({
    queryKey: ["chats", wsId, uid],
    queryFn: () => fetchChats(wsId ?? "", uid ?? ""),
    enabled: wsId !== null && wsId !== "" && uid !== null && uid !== "",
  });

  React.useEffect(() => {
    if (wsId === null || wsId === "") return;
    if (uid === null || uid === "") return;
    const activeWsId: string = wsId;
    const activeUid: string = uid;
    const unsubscribe = listenChats(activeWsId, activeUid, (chats) => {
      queryClient.setQueryData<ChatDoc[]>(["chats", activeWsId, activeUid], chats);
    });
    return () => {
      unsubscribe();
    };
  }, [wsId, uid, queryClient]);

  return query;
}

export type UseMessagesResult = {
  messages: MessageDoc[];
  loadOlder: () => Promise<void>;
  hasMore: boolean;
  isLoadingOlder: boolean;
  isPending: boolean;
  error: Error | null;
  /** Reintenta la carga inicial (patrón T34 `QueryRetry`). */
  retry: () => void;
};

/**
 * Miembros del espacio en vivo (T15: candidatos del menú @).
 * Query inicial + suscripción que refresca la caché de TanStack Query.
 */
export function useMembers(
  wsId: string | null,
): UseQueryResult<WorkspaceMember[], Error> {
  const queryClient = useQueryClient();
  const query = useQuery<WorkspaceMember[], Error>({
    queryKey: ["members", wsId],
    queryFn: () => listMembers(wsId ?? ""),
    enabled: wsId !== null && wsId !== "",
  });

  React.useEffect(() => {
    if (wsId === null || wsId === "") return;
    const activeWsId: string = wsId;
    const unsubscribe = listenMembers(activeWsId, (members) => {
      queryClient.setQueryData<WorkspaceMember[]>(
        ["members", activeWsId],
        members,
      );
    });
    return () => {
      unsubscribe();
    };
  }, [wsId, queryClient]);

  return query;
}

export function useMessages(
  wsId: string | null,
  chatId: string | null,
): UseMessagesResult {
  const queryClient = useQueryClient();
  const enabled = wsId !== null && wsId !== "" && chatId !== null && chatId !== "";

  const query = useQuery<MessageDoc[], Error>({
    queryKey: ["messages", wsId, chatId],
    queryFn: () => fetchLatestMessages(wsId ?? "", chatId ?? ""),
    enabled,
    staleTime: Infinity,
  });

  const [hasMore, setHasMore] = React.useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = React.useState(false);
  const primedRef = React.useRef(false);

  React.useEffect(() => {
    if (!enabled || wsId === null || chatId === null) return;
    const activeWsId: string = wsId;
    const activeChatId: string = chatId;
    primedRef.current = false;
    setHasMore(true);
    const unsubscribe = listenLatestMessages(activeWsId, activeChatId, (latest) => {
      if (!primedRef.current) {
        primedRef.current = true;
        queryClient.setQueryData<MessageDoc[]>(
          ["messages", activeWsId, activeChatId],
          [...latest].sort(byCreatedAtAsc),
        );
        // Lo que el servidor ya trae queda confirmado (limpia 'sending').
        useMessageStatusStore
          .getState()
          .clearConfirmed(latest.map((item) => item.id));
        return;
      }
      queryClient.setQueryData<MessageDoc[]>(
        ["messages", activeWsId, activeChatId],
        (old) => mergeUnique(old ?? [], latest),
      );
      useMessageStatusStore
        .getState()
        .clearConfirmed(latest.map((item) => item.id));
    });
    return () => {
      unsubscribe();
    };
  }, [enabled, wsId, chatId, queryClient]);

  // Reacciones en vivo: viven en `message_reactions`, así que un evento suyo
  // no dispara la suscripción de mensajes; se refrescan solo sus mapas.
  React.useEffect(() => {
    if (!enabled || wsId === null || chatId === null) return;
    const activeWsId: string = wsId;
    const activeChatId: string = chatId;
    const key = ["messages", activeWsId, activeChatId];
    const unsubscribe = listenReactions(() => {
      const cached = queryClient.getQueryData<MessageDoc[]>(key) ?? [];
      if (cached.length === 0) return;
      void fetchReactionsFor(cached.map((item) => item.id)).then((maps) => {
        if (maps.size === 0) return;
        queryClient.setQueryData<MessageDoc[]>(key, (old) =>
          (old ?? []).map((item) => {
            const entry = maps.get(item.id);
            if (entry === undefined) return item;
            return {
              ...item,
              reactions: { ...entry.map },
              lastReaction: entry.last,
            };
          }),
        );
      });
    });
    return () => {
      unsubscribe();
    };
  }, [enabled, wsId, chatId, queryClient]);

  // Red de seguridad: al volver a la pestaña se refresca por si el
  // realtime se cortó (red caída, suspensión del equipo).
  React.useEffect(() => {
    if (!enabled || wsId === null || chatId === null) return;
    const activeWsId: string = wsId;
    const activeChatId: string = chatId;
    function handleFocus(): void {
      void queryClient.invalidateQueries({
        queryKey: ["messages", activeWsId, activeChatId],
      });
    }
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) handleFocus();
    });
    return () => {
      window.removeEventListener("focus", handleFocus);
    };
  }, [enabled, wsId, chatId, queryClient]);

  const loadOlder = React.useCallback(async () => {
    if (!enabled || wsId === null || chatId === null) return;
    if (isLoadingOlder || !hasMore) return;
    const activeWsId: string = wsId;
    const activeChatId: string = chatId;
    // El cursor es el mensaje más antiguo en caché (clave created_at + id).
    const cached: MessageDoc[] =
      queryClient.getQueryData<MessageDoc[]>(["messages", activeWsId, activeChatId]) ??
      [];
    const oldest: MessageDoc | undefined = cached[0];
    if (oldest === undefined) return;
    setIsLoadingOlder(true);
    try {
      const page = await fetchOlderMessages(
        activeWsId,
        activeChatId,
        { createdAt: oldest.createdAt.toDate().toISOString(), id: oldest.id },
        30,
      );
      queryClient.setQueryData<MessageDoc[]>(
        ["messages", activeWsId, activeChatId],
        (old) => mergeUnique(page.messages, old ?? []),
      );
      setHasMore(page.hasMore);
    } finally {
      setIsLoadingOlder(false);
    }
  }, [enabled, wsId, chatId, isLoadingOlder, hasMore, queryClient]);

  return {
    messages: query.data ?? [],
    loadOlder,
    hasMore,
    isLoadingOlder,
    isPending: query.isPending,
    error: query.error,
    retry: () => {
      void query.refetch();
    },
  };
}

export type UsePostsResult = {
  /** Publicaciones del chat `posts`, más reciente primero. */
  posts: MessageDoc[];
  isPending: boolean;
  error: Error | null;
  /** Reintenta la suscripción al feed (patrón T34 `QueryRetry`). */
  retry: () => void;
};

/** Espera antes de reintentar la suscripción al feed que falló. */
const POSTS_RETRY_MS = 4000;
/** Reintentos como máximo: evita un bucle si el acceso está negado de verdad. */
const POSTS_RETRY_MAX = 3;

/** Un fallo de permisos suele ser el chat `posts` que aún no existe. */
function isPermissionDenied(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "permission-denied"
  );
}

/**
 * Feed de publicaciones (T17): mensajes `type: "post"` del chat `posts` del
 * espacio, en vivo y ordenados por `createdAt` descendente. Los comentarios
 * son respuestas de hilo y no entran aquí (`isPostMessage` los excluye).
 *
 * Primero asegura el chat con `ensurePostsChat` (RPC idempotente para los
 * espacios anteriores a T17) y **después** se suscribe. Sin acceso al espacio
 * la RLS devuelve lista vacía, no error; si el canal falla (red), se muestra
 * el estado vacío sin error y se reintenta volviendo a asegurar el chat.
 */
export function usePosts(wsId: string | null): UsePostsResult {
  const queryClient = useQueryClient();
  const uid = useSessionStore((state) => state.user?.uid ?? null);
  const enabled = wsId !== null && wsId !== "";
  const queryKey = React.useMemo(
    () => ["posts", wsId, uid] as const,
    [wsId, uid],
  );
  const [error, setError] = React.useState<Error | null>(null);
  // `ready` = el listener ya entregó su primer snapshot (o se rindió): hasta
  // entonces la vista muestra el esqueleto, no el estado vacío.
  const [ready, setReady] = React.useState(false);
  // `nonce` = reintentos manuales (botón "Reintentar"): re-ejecuta el boot.
  const [nonce, setNonce] = React.useState(0);

  // La caché la rellena el listener; la query solo existe para no perder
  // los ids al re-renderizar (mismo patrón que `useMessages`).
  const query = useQuery<MessageDoc[], Error>({
    queryKey,
    queryFn: async () => [],
    enabled,
    staleTime: Infinity,
  });

  React.useEffect(() => {
    if (!enabled || wsId === null) return;
    const activeWsId: string = wsId;
    const activeUid: string = uid ?? "";
    const activeKey = queryKey;
    let cancelled = false;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe: (() => void) | null = null;

    const stop = (): void => {
      // Desmontado o cambio de espacio: nada de suscribirse después.
      cancelled = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      if (unsubscribe !== null) {
        unsubscribe();
        unsubscribe = null;
      }
    };

    const subscribe = (): void => {
      if (cancelled) return;
      unsubscribe = listenPosts(
        activeWsId,
        (posts) => {
          setReady(true);
          setError(null);
          // Fusión en vez de reemplazo: con el feed en vivo un snapshot
          // puede llegar mientras hay un post optimista (o con estado
          // 'error' y su botón de reintento) en la caché. El servidor gana
          // para los ids que confirma, como en el timeline del chat.
          queryClient.setQueryData<MessageDoc[]>(activeKey, (old) =>
            mergeUnique(old ?? [], posts, byCreatedAtDesc),
          );
          // Lo que confirma el servidor deja de estar 'sending'.
          useMessageStatusStore
            .getState()
            .clearConfirmed(posts.map((item) => item.id));
        },
        (failure: Error) => {
          if (cancelled) return;
          unsubscribe = null;
          // Un fallo del canal es casi siempre red: no es un error que haya
          // que mostrar, el feed pasa a su estado vacío y la suscripción se
          // reintenta por debajo; si vuelve a entrar un post, aparece en vivo.
          const denied = isPermissionDenied(failure);
          setError(denied ? null : failure);
          setReady(true);
          if (attempts >= POSTS_RETRY_MAX) return;
          attempts += 1;
          retryTimer = setTimeout(() => {
            retryTimer = null;
            if (cancelled) return;
            // Reintento = volver a asegurar el chat y suscribirse de nuevo.
            void boot();
          }, POSTS_RETRY_MS);
        },
      );
    };

    const boot = async (): Promise<void> => {
      if (activeUid !== "") {
        try {
          await ensurePostsChat(activeWsId, activeUid);
        } catch {
          // Sin permisos para crearlo (o sin sesión): se intenta igual la
          // suscripción, que puede funcionar si el doc ya existía.
        }
      }
      if (cancelled) return;
      subscribe();
    };

    setReady(false);
    setError(null);
    void boot();
    return stop;
  }, [enabled, wsId, uid, queryKey, queryClient, nonce]);

  // Reacciones ("Me gusta") en vivo sobre el feed: viven en
  // `message_reactions`, fuera de la suscripción de mensajes.
  React.useEffect(() => {
    if (!enabled) return;
    const activeKey = queryKey;
    const unsubscribe = listenReactions(() => {
      const cached = queryClient.getQueryData<MessageDoc[]>(activeKey) ?? [];
      if (cached.length === 0) return;
      void fetchReactionsFor(cached.map((item) => item.id)).then((maps) => {
        if (maps.size === 0) return;
        queryClient.setQueryData<MessageDoc[]>(activeKey, (old) =>
          (old ?? []).map((item) => {
            const entry = maps.get(item.id);
            if (entry === undefined) return item;
            return {
              ...item,
              reactions: { ...entry.map },
              lastReaction: entry.last,
            };
          }),
        );
      });
    });
    return () => {
      unsubscribe();
    };
  }, [enabled, queryKey, queryClient]);

  const posts = React.useMemo(
    () => (query.data ?? []).filter(isPostMessage),
    [query.data],
  );
  // Esqueleto solo mientras no llega nada: si ya hay un post optimista en
  // caché se muestra la fila en vez de parpadear el esqueleto.
  const isPending = !ready && error === null && posts.length === 0;

  const retry = React.useCallback(() => {
    setError(null);
    setReady(false);
    setNonce((n) => n + 1);
  }, []);

  return { posts, isPending, error, retry };
}

export type PublishPostInput = {
  authorId: string;
  authorName: string;
  text: string;
  mentions?: string[];
  attachments?: MessageAttachment[];
  /** Id de cliente para el envío optimista y el reintento. */
  messageId?: string;
};

type PublishPostContext = { clientId: string };

/**
 * Publica un post (T17) como mensaje `type: "post"` con `threadParentId`
 * null, reutilizando `sendMessage` (que ya actualiza `lastMessage` del chat
 * `posts` al publicar, no al comentar). Antes asegura el chat con
 * `ensurePostsChat`: los espacios creados antes de T17 no lo tienen.
 * Optimista como el envío del chat: id de cliente en caché y estados
 * `sending` / `error` para reintentar.
 */
export function usePublishPost(
  wsId: string | null,
): UseMutationResult<
  string,
  Error,
  PublishPostInput,
  PublishPostContext | undefined
> {
  const queryClient = useQueryClient();
  const uid = useSessionStore((state) => state.user?.uid ?? null);
  const queryKey = React.useMemo(
    () => ["posts", wsId, uid] as const,
    [wsId, uid],
  );
  return useMutation({
    mutationFn: async (input) => {
      if (wsId === null || wsId === "") {
        throw new Error("Falta el espacio.");
      }
      if (input.authorId === "") {
        throw new Error("Inicia sesión para publicar.");
      }
      await ensurePostsChat(wsId, input.authorId);
      return sendMessage(wsId, POSTS_CHAT_ID, {
        authorId: input.authorId,
        authorName: input.authorName,
        text: input.text,
        mentions: input.mentions ?? [],
        attachments: input.attachments ?? [],
        threadParentId: null,
        type: "post",
        messageId: input.messageId,
      });
    },
    onMutate: (input) => {
      if (wsId === null || wsId === "") return undefined;
      if (input.messageId === undefined || input.messageId === "") {
        input.messageId = newMessageId(wsId, POSTS_CHAT_ID);
      }
      const clientId: string = input.messageId;
      const optimistic: MessageDoc = {
        id: clientId,
        authorId: input.authorId,
        authorName: input.authorName,
        text: input.text.trim(),
        mentions: input.mentions ?? [],
        replyTo: null,
        threadParentId: null,
        threadCount: 0,
        lastReplyAt: null,
        attachments: input.attachments ?? [],
        reactions: {},
        lastReaction: null,
        createdAt: Timestamp.now(),
        editedAt: null,
        deleted: false,
        type: "post",
      };
      queryClient.setQueryData<MessageDoc[]>(queryKey, (old) =>
        mergeUnique(old ?? [], [optimistic], byCreatedAtDesc),
      );
      useMessageStatusStore.getState().setStatus(clientId, "sending");
      return { clientId };
    },
    onError: (_error, _variables, context) => {
      if (context !== undefined) {
        useMessageStatusStore.getState().setStatus(context.clientId, "error");
      }
    },
    onSuccess: (_messageId, _variables, context) => {
      if (context !== undefined) {
        useMessageStatusStore.getState().clearStatus(context.clientId);
      }
    },
  });
}

export function useThread(
  wsId: string | null,
  chatId: string | null,
  parentId: string | null,
): UseQueryResult<MessageDoc[], Error> {
  const queryClient = useQueryClient();
  const enabled =
    wsId !== null &&
    wsId !== "" &&
    chatId !== null &&
    chatId !== "" &&
    parentId !== null &&
    parentId !== "";
  const query = useQuery<MessageDoc[], Error>({
    queryKey: ["thread", wsId, chatId, parentId],
    queryFn: () => fetchThread(wsId ?? "", chatId ?? "", parentId ?? ""),
    enabled,
    staleTime: Infinity,
  });

  React.useEffect(() => {
    if (!enabled || wsId === null || chatId === null || parentId === null) return;
    const activeWsId: string = wsId;
    const activeChatId: string = chatId;
    const activeParentId: string = parentId;
    const key = ["thread", activeWsId, activeChatId, activeParentId];
    const unsubscribe = listenThread(activeWsId, activeChatId, activeParentId, (replies) => {
      queryClient.setQueryData<MessageDoc[]>(key, replies);
    });
    return () => {
      unsubscribe();
    };
  }, [enabled, wsId, chatId, parentId, queryClient]);

  // Reacciones en vivo también dentro del hilo.
  React.useEffect(() => {
    if (!enabled || wsId === null || chatId === null || parentId === null) return;
    const key = ["thread", wsId, chatId, parentId];
    const unsubscribe = listenReactions(() => {
      const cached = queryClient.getQueryData<MessageDoc[]>(key) ?? [];
      if (cached.length === 0) return;
      void fetchReactionsFor(cached.map((item) => item.id)).then((maps) => {
        if (maps.size === 0) return;
        queryClient.setQueryData<MessageDoc[]>(key, (old) =>
          (old ?? []).map((item) => {
            const entry = maps.get(item.id);
            if (entry === undefined) return item;
            return {
              ...item,
              reactions: { ...entry.map },
              lastReaction: entry.last,
            };
          }),
        );
      });
    });
    return () => {
      unsubscribe();
    };
  }, [enabled, wsId, chatId, parentId, queryClient]);

  return query;
}

export type SendMessageVariables = SendMessageInput & {
  wsId: string;
  chatId: string;
};

type SendMessageContext = {
  clientId: string;
};

/**
 * Envío optimista (T14): inserta el mensaje en la caché de TanStack Query
 * de inmediato con un id de cliente y `createdAt` provisional; el
 * snapshot en vivo lo reemplaza al confirmar. Si falla, el id queda en
 * estado 'error' para mostrar "No se pudo enviar · Reintentar".
 * Para reintentar, muta de nuevo con el mismo `messageId`.
 */
export function useSendMessage(
  wsId: string | null,
  chatId: string | null,
): UseMutationResult<
  string,
  Error,
  Omit<SendMessageVariables, "wsId" | "chatId">,
  SendMessageContext | undefined
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) => {
      if (wsId === null || wsId === "" || chatId === null || chatId === "") {
        throw new Error("Falta el espacio o el chat.");
      }
      return sendMessage(wsId, chatId, input);
    },
    onMutate: (input) => {
      if (wsId === null || wsId === "" || chatId === null || chatId === "") {
        return undefined;
      }
      const activeWsId: string = wsId;
      const activeChatId: string = chatId;
      // El mismo objeto llega a mutationFn: fijar aquí el id garantiza
      // que el optimista y el envío real compartan id (y el reintento).
      if (input.messageId === undefined || input.messageId === "") {
        input.messageId = newMessageId(activeWsId, activeChatId);
      }
      const clientId: string = input.messageId;
      void queryClient.cancelQueries({
        queryKey: ["messages", activeWsId, activeChatId],
      });
      const text = input.text.trim();
      const optimistic: MessageDoc = {
        id: clientId,
        authorId: input.authorId,
        authorName: input.authorName,
        text,
        mentions: input.mentions ?? [],
        replyTo: input.replyTo ?? null,
        threadParentId: input.threadParentId ?? null,
        threadCount: 0,
        lastReplyAt: null,
        attachments: input.attachments ?? [],
        reactions: {},
        lastReaction: null,
        createdAt: Timestamp.now(),
        editedAt: null,
        deleted: false,
        type: input.type ?? "user",
      };
      queryClient.setQueryData<MessageDoc[]>(
        ["messages", activeWsId, activeChatId],
        (old) => mergeUnique(old ?? [], [optimistic]),
      );
      useMessageStatusStore.getState().setStatus(clientId, "sending");
      return { clientId };
    },
    onError: (_error, _variables, context) => {
      if (context !== undefined) {
        useMessageStatusStore.getState().setStatus(context.clientId, "error");
      }
    },
    onSuccess: (_messageId, _variables, context) => {
      if (context !== undefined) {
        useMessageStatusStore.getState().clearStatus(context.clientId);
      }
    },
    // Red de seguridad: aunque el realtime falle, el envío refresca la
    // lista (el optimista ya la pintó al instante).
    onSettled: () => {
      if (wsId === null || wsId === "" || chatId === null || chatId === "") return;
      void queryClient.invalidateQueries({
        queryKey: ["messages", wsId, chatId],
      });
    },
  });
}

export function useAiMessages(
  uid: string | null,
  chatId: string | null,
): UseQueryResult<MessageDoc[], Error> {
  const queryClient = useQueryClient();
  const enabled = uid !== null && uid !== "" && chatId !== null && chatId !== "";
  const query = useQuery<MessageDoc[], Error>({
    queryKey: ["aiMessages", uid, chatId],
    queryFn: () => fetchAiMessages(uid ?? "", chatId ?? ""),
    enabled,
    staleTime: Infinity,
  });

  React.useEffect(() => {
    if (!enabled || uid === null || chatId === null) return;
    const activeUid: string = uid;
    const activeChatId: string = chatId;
    const unsubscribe = listenAiMessages(activeUid, activeChatId, (messages) => {
      queryClient.setQueryData<MessageDoc[]>(
        ["aiMessages", activeUid, activeChatId],
        messages,
      );
    });
    return () => {
      unsubscribe();
    };
  }, [enabled, uid, chatId, queryClient]);

  return query;
}

/** Mi mensaje (`type: "user"`) en el chat privado con Loki. */
export function useSendAiMessage(
  uid: string | null,
  chatId: string | null,
): UseMutationResult<string, Error, { authorName: string; text: string }, unknown> {
  return useMutation({
    mutationFn: (input) => {
      if (uid === null || uid === "" || chatId === null || chatId === "") {
        throw new Error("Falta el usuario o el chat de IA.");
      }
      return sendAiUserMessage(uid, chatId, {
        authorId: uid,
        authorName: input.authorName,
        text: input.text,
      });
    },
  });
}

/**
 * Respuesta de Loki (`type: "ai"`) en el chat privado.
 *
 * Se conserva por API de hooks, pero la vista ya no lo llama: la RLS solo
 * deja `type: "user"` al cliente y el camino real es la Edge Function
 * `loki-chat` (escribe con la service role y la respuesta llega por
 * realtime). Si se llamara, el insert falla con mensaje en español.
 */
export function useSendAiAssistantMessage(
  uid: string | null,
  chatId: string | null,
): UseMutationResult<string, Error, { text: string; mentions?: string[] }, unknown> {
  return useMutation({
    mutationFn: (input) => {
      if (uid === null || uid === "" || chatId === null || chatId === "") {
        throw new Error("Falta el usuario o el chat de IA.");
      }
      return sendAiAssistantMessage(uid, chatId, input);
    },
  });
}

// --- Tiempo real T14: typing y leídos ---------------------------------------

/** Un typing se considera vigente si updatedAt tiene menos de 4s. */
export const TYPING_FRESH_MS = 4000;

/** Escrituras de typing con throttle de 800ms. */
export const TYPING_THROTTLE_MS = 800;

type ActiveIds = {
  wsId: string;
  chatId: string;
  uid: string;
};

function activeIds(
  wsId: string | null,
  chatId: string | null,
  uid: string | null,
): ActiveIds | null {
  if (wsId === null || wsId === "") return null;
  if (chatId === null || chatId === "") return null;
  if (uid === null || uid === "") return null;
  return { wsId, chatId, uid };
}

/**
 * Nombres de quién está escribiendo (sin mí), con updatedAt < 4s.
 * Revalida cada segundo para que el aviso expire solo.
 */
export function useTyping(
  wsId: string | null,
  chatId: string | null,
  myUid: string | null,
): string[] {
  const [all, setAll] = React.useState<TypingDoc[]>([]);
  const [now, setNow] = React.useState(() => Date.now());
  const enabled = wsId !== null && wsId !== "" && chatId !== null && chatId !== "";

  React.useEffect(() => {
    if (!enabled || wsId === null || chatId === null) return;
    const activeWsId: string = wsId;
    const activeChatId: string = chatId;
    setAll([]);
    const unsubscribe = listenTyping(activeWsId, activeChatId, setAll);
    return () => {
      unsubscribe();
    };
  }, [enabled, wsId, chatId]);

  React.useEffect(() => {
    if (!enabled || all.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled, all.length]);

  return React.useMemo(() => {
    const fresh = all
      .filter((item) => item.uid !== myUid)
      .filter((item) => {
        const ms = item.updatedAt?.toMillis() ?? now;
        return now - ms < TYPING_FRESH_MS;
      })
      .map((item) => item.displayName.trim())
      .filter((name) => name !== "");
    return [...new Set(fresh)].sort((a, b) => a.localeCompare(b, "es"));
  }, [all, myUid, now]);
}

export type NotifyTyping = {
  /** Notifica escritura (throttle 800ms); con texto vacío borra la marca. */
  notify: (text: string) => void;
  /** Borra la marca de inmediato. */
  clear: () => void;
};

/**
 * Publica mi typing con throttle de 800ms; borra al vaciar el input,
 * al enviar o al desmontar/cambiar de chat.
 */
export function useNotifyTyping(
  wsId: string | null,
  chatId: string | null,
  uid: string | null,
  displayName: string,
): NotifyTyping {
  const paramsRef = React.useRef({ wsId, chatId, uid, displayName });
  paramsRef.current = { wsId, chatId, uid, displayName };
  const lastSentRef = React.useRef(0);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = React.useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const params = paramsRef.current;
    const ids = activeIds(params.wsId, params.chatId, params.uid);
    if (ids === null) return;
    void clearTyping(ids.wsId, ids.chatId, ids.uid);
  }, []);

  const notify = React.useCallback(
    (text: string) => {
      const params = paramsRef.current;
      const ids = activeIds(params.wsId, params.chatId, params.uid);
      if (ids === null) return;
      const activeName = params.displayName;
      if (text.trim() === "") {
        clear();
        return;
      }
      const now = Date.now();
      const elapsed = now - lastSentRef.current;
      if (elapsed >= TYPING_THROTTLE_MS && timerRef.current === null) {
        lastSentRef.current = now;
        void setTyping(ids.wsId, ids.chatId, ids.uid, activeName);
        return;
      }
      if (timerRef.current === null) {
        timerRef.current = setTimeout(
          () => {
            timerRef.current = null;
            const latest = paramsRef.current;
            const latestIds = activeIds(latest.wsId, latest.chatId, latest.uid);
            if (latestIds === null) return;
            lastSentRef.current = Date.now();
            void setTyping(latestIds.wsId, latestIds.chatId, latestIds.uid, latest.displayName);
          },
          Math.max(0, TYPING_THROTTLE_MS - elapsed),
        );
      }
    },
    [clear],
  );

  // Al desmontar o cambiar de conversación se borra la marca anterior.
  React.useEffect(() => {
    const ids = activeIds(wsId, chatId, uid);
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      if (ids === null) return;
      void clearTyping(ids.wsId, ids.chatId, ids.uid);
    };
  }, [wsId, chatId, uid]);

  return React.useMemo(() => ({ notify, clear }), [notify, clear]);
}

export type MyReadState = {
  read: ReadReceiptDoc | null;
  /** True cuando el listener ya resolvió (null = nunca abrió el chat). */
  ready: boolean;
};

/** Mi marca de lectura de un chat en vivo. */
export function useMyRead(
  wsId: string | null,
  chatId: string | null,
  uid: string | null,
): MyReadState {
  const [read, setRead] = React.useState<ReadReceiptDoc | null>(null);
  const [ready, setReady] = React.useState(false);
  const ids = activeIds(wsId, chatId, uid);

  React.useEffect(() => {
    if (ids === null) {
      setRead(null);
      setReady(false);
      return;
    }
    setRead(null);
    setReady(false);
    const unsubscribe = listenMyRead(ids.wsId, ids.chatId, ids.uid, (next) => {
      setRead(next);
      setReady(true);
    });
    return () => {
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids?.wsId, ids?.chatId, ids?.uid]);

  return React.useMemo(() => ({ read, ready }), [read, ready]);
}

export type UnreadInfo = {
  unread: boolean;
  /** Mensajes no leídos (tope 50 por la ventana de lectura). */
  count: number;
};

/**
 * No leídos de un chat para la lista: punto azul + contador cuando
 * lastMessage es más nuevo que mi lastReadAt y el autor no soy yo.
 */
export function useUnread(
  wsId: string | null,
  chat: ChatDoc | null,
  uid: string | null,
): UnreadInfo {
  const chatId = chat?.id ?? null;
  const { read, ready } = useMyRead(wsId, chatId, uid);
  const [count, setCount] = React.useState(0);

  const last = chat?.lastMessage ?? null;
  const lastId = last === null ? null : `${last.authorId}:${last.text}:${last.createdAt?.toMillis() ?? 0}`;
  const lastMs = last?.createdAt?.toMillis() ?? null;

  const unread = React.useMemo(() => {
    if (chat === null || uid === null || !ready) return false;
    if (last === null) return false;
    if (last.authorId === uid) return false;
    if (read === null) return true;
    const readMs = read.lastReadAt?.toMillis() ?? 0;
    return (lastMs ?? 0) > readMs;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat, uid, ready, read, lastId]);

  React.useEffect(() => {
    if (!unread || wsId === null || wsId === "" || chatId === null || uid === null) {
      setCount(0);
      return;
    }
    const activeWsId: string = wsId;
    const activeChatId: string = chatId;
    const activeUid: string = uid;
    const sinceMs = read?.lastReadAt?.toMillis() ?? null;
    let cancelled = false;
    void fetchUnreadCount(activeWsId, activeChatId, activeUid, sinceMs)
      .then((next) => {
        if (!cancelled) setCount(next);
      })
      .catch(() => {
        if (!cancelled) setCount(0);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unread, wsId, chatId, uid, lastId]);

  return React.useMemo(() => ({ unread, count }), [unread, count]);
}

/**
 * Escribe mi marca de lectura (lastReadAt + lastReadMessageId).
 * Solo escribe cuando cambia el id (evita escrituras por cada render).
 */
export function useMarkChatRead(
  wsId: string | null,
  chatId: string | null,
  uid: string | null,
): (messageId: string | null) => void {
  const lastMarkedRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    lastMarkedRef.current = null;
  }, [wsId, chatId, uid]);

  return React.useCallback(
    (messageId: string | null) => {
      const ids = activeIds(wsId, chatId, uid);
      if (ids === null) return;
      const key = `${ids.wsId}/${ids.chatId}/${messageId ?? "-"}`;
      if (lastMarkedRef.current === key) return;
      lastMarkedRef.current = key;
      void markChatRead(ids.wsId, ids.chatId, ids.uid, messageId).catch(() => {
        lastMarkedRef.current = null;
      });
    },
    [wsId, chatId, uid],
  );
}
