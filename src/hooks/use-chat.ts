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
  fetchChats,
  fetchOlderMessages,
  listenAiMessages,
  listenChats,
  listenLatestMessages,
  listenThread,
  MESSAGES_PAGE_SIZE,
  sendAiUserMessage,
  sendMessage,
  type SendMessageInput,
} from "@/lib/data/chat";
import type { ChatDoc, MessageDoc } from "@/types/chat";
import type { DocumentData, QueryDocumentSnapshot } from "firebase/firestore";
import { useSessionStore } from "@/stores/session-store";

function byCreatedAtAsc(a: MessageDoc, b: MessageDoc): number {
  const left = a.createdAt?.toMillis() ?? Number.POSITIVE_INFINITY;
  const right = b.createdAt?.toMillis() ?? Number.POSITIVE_INFINITY;
  if (left !== right) return left - right;
  return a.id.localeCompare(b.id);
}

function mergeUnique(current: MessageDoc[], incoming: MessageDoc[]): MessageDoc[] {
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
  return [...byId.values()].sort(byCreatedAtAsc);
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
};

export function useMessages(
  wsId: string | null,
  chatId: string | null,
): UseMessagesResult {
  const queryClient = useQueryClient();
  const enabled = wsId !== null && wsId !== "" && chatId !== null && chatId !== "";

  const query = useQuery<MessageDoc[], Error>({
    queryKey: ["messages", wsId, chatId],
    queryFn: async () => [],
    enabled,
    staleTime: Infinity,
  });

  const [cursor, setCursor] =
    React.useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [hasMore, setHasMore] = React.useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = React.useState(false);
  const primedRef = React.useRef(false);

  React.useEffect(() => {
    if (!enabled || wsId === null || chatId === null) return;
    const activeWsId: string = wsId;
    const activeChatId: string = chatId;
    primedRef.current = false;
    setCursor(null);
    setHasMore(true);
    const unsubscribe = listenLatestMessages(activeWsId, activeChatId, (latest, snapshots) => {
      if (!primedRef.current) {
        primedRef.current = true;
        queryClient.setQueryData<MessageDoc[]>(
          ["messages", activeWsId, activeChatId],
          [...latest].sort(byCreatedAtAsc),
        );
        const oldest = snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;
        setCursor(oldest ?? null);
        setHasMore(snapshots.length === MESSAGES_PAGE_SIZE);
        return;
      }
      queryClient.setQueryData<MessageDoc[]>(
        ["messages", activeWsId, activeChatId],
        (old) => mergeUnique(old ?? [], latest),
      );
    });
    return () => {
      unsubscribe();
    };
  }, [enabled, wsId, chatId, queryClient]);

  const loadOlder = React.useCallback(async () => {
    if (!enabled || wsId === null || chatId === null) return;
    if (cursor === null || isLoadingOlder || !hasMore) return;
    const activeWsId: string = wsId;
    const activeChatId: string = chatId;
    const activeCursor = cursor;
    setIsLoadingOlder(true);
    try {
      const page = await fetchOlderMessages(activeWsId, activeChatId, activeCursor, 30);
      queryClient.setQueryData<MessageDoc[]>(
        ["messages", activeWsId, activeChatId],
        (old) => mergeUnique(page.messages, old ?? []),
      );
      const oldest =
        page.snapshots.length > 0
          ? page.snapshots[page.snapshots.length - 1]
          : null;
      if (oldest) setCursor(oldest);
      setHasMore(page.hasMore);
    } finally {
      setIsLoadingOlder(false);
    }
  }, [enabled, wsId, chatId, cursor, isLoadingOlder, hasMore, queryClient]);

  return {
    messages: query.data ?? [],
    loadOlder,
    hasMore,
    isLoadingOlder,
    isPending: query.isPending,
    error: query.error,
  };
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
    queryFn: async () => [],
    enabled,
    staleTime: Infinity,
  });

  React.useEffect(() => {
    if (!enabled || wsId === null || chatId === null || parentId === null) return;
    const activeWsId: string = wsId;
    const activeChatId: string = chatId;
    const activeParentId: string = parentId;
    const unsubscribe = listenThread(activeWsId, activeChatId, activeParentId, (replies) => {
      queryClient.setQueryData<MessageDoc[]>(
        ["thread", activeWsId, activeChatId, activeParentId],
        replies,
      );
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

export function useSendMessage(
  wsId: string | null,
  chatId: string | null,
): UseMutationResult<string, Error, Omit<SendMessageVariables, "wsId" | "chatId">, unknown> {
  return useMutation({
    mutationFn: (input) => {
      if (wsId === null || wsId === "" || chatId === null || chatId === "") {
        throw new Error("Falta el espacio o el chat.");
      }
      return sendMessage(wsId, chatId, input);
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
    queryFn: async () => [],
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
