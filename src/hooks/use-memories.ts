"use client";

/**
 * Hooks de la memoria del espacio (TanStack Query + Realtime).
 *
 * `useMemories` es el único que escucha: se suscribe mientras la pantalla está
 * montada y se desuscribe al salir (nada queda consultando). Las mutaciones
 * invalidan la clave, así que un recuerdo guardado desde el chat o desde el
 * menú del mensaje aparece en la lista sin recargar.
 */

import * as React from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import {
  createMemory,
  deleteMemory,
  listMemories,
  listenMemories,
  searchMemories,
  setMemoryPinned,
  shareMemory,
  updateMemory,
  type Unsubscribe,
} from "@/lib/data/memories";
import { useSessionStore } from "@/stores/session-store";
import type {
  MemoryItem,
  MemorySearchHit,
  NewMemoryInput,
  UpdateMemoryPatch,
} from "@/types/organizer";

const MEMORIES_KEY = (wsId: string | null): readonly unknown[] => ["memories", wsId];
const SEARCH_KEY = (wsId: string | null, query: string): readonly unknown[] => [
  "memories-search",
  wsId,
  query,
];

export type MemoriesState = {
  /** Lista normal (fijados y más recientes primero, sin caducados). */
  memories: MemoryItem[];
  /** Resultado de la búsqueda por texto (vacío si no se está buscando). */
  hits: MemorySearchHit[];
  /** `true` mientras se busca: la lista sigue en memoria, no parpadea. */
  isSearching: boolean;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  /** Vuelve a pedir lo que toque (lista o búsqueda). */
  retry: () => void;
};

/**
 * Recuerdos del espacio. Con `query` de 2+ letras busca por full-text (la RPC
 * que también usa Loki); sin ella, trae la lista completa.
 */
export function useMemories(wsId: string | null, query = ""): MemoriesState {
  const queryClient = useQueryClient();
  const trimmed = query.trim();
  const searching = trimmed.length >= 2;

  // La lista se pide siempre: además de pintar, sirve para abrir un
  // resultado de la búsqueda (y para que al salir de la búsqueda no haya un
  // salto de contenido). La búsqueda solo se suma cuando hay 2+ letras.
  const list = useQuery<MemoryItem[], Error>({
    queryKey: MEMORIES_KEY(wsId),
    queryFn: () => listMemories(wsId ?? ""),
    enabled: wsId !== null,
    staleTime: 30_000,
  });

  const search = useQuery<MemorySearchHit[], Error>({
    queryKey: SEARCH_KEY(wsId, trimmed),
    queryFn: () => searchMemories(wsId ?? "", trimmed),
    enabled: wsId !== null && searching,
    staleTime: 30_000,
  });

  React.useEffect(() => {
    if (wsId === null) return;
    const stop: Unsubscribe = listenMemories(wsId, (memories) => {
      queryClient.setQueryData<MemoryItem[]>(MEMORIES_KEY(wsId), memories);
      // Una búsqueda en curso se recalcula: el recuerdo recién guardado puede
      // ser justo lo que se está buscando.
      void queryClient.invalidateQueries({ queryKey: ["memories-search"] });
    });
    return stop;
  }, [wsId, queryClient]);

  const active = searching ? search : list;
  return {
    memories: list.data ?? [],
    hits: search.data ?? [],
    isSearching: searching,
    isPending: active.isPending,
    isError: active.isError,
    error: active.error,
    retry: () => {
      void active.refetch();
    },
  };
}

function myUid(): string {
  return useSessionStore.getState().user?.uid ?? "";
}

function useInvalidate(wsId: string | null): () => void {
  const queryClient = useQueryClient();
  return React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: MEMORIES_KEY(wsId) });
    void queryClient.invalidateQueries({ queryKey: ["memories-search"] });
  }, [wsId, queryClient]);
}

/** Guarda un recuerdo (menú del mensaje, pantalla Memoria o Loki). */
export function useCreateMemory(
  wsId: string | null,
): UseMutationResult<string, Error, NewMemoryInput> {
  const invalidate = useInvalidate(wsId);
  return useMutation({
    mutationFn: (input) => {
      if (wsId === null) throw new Error("Falta el espacio.");
      const uid = myUid();
      if (uid === "") throw new Error("Inicia sesión para guardar un recuerdo.");
      return createMemory(wsId, uid, input);
    },
    onSuccess: invalidate,
  });
}

/** Edita un recuerdo (quien lo guardó o un admin). */
export function useUpdateMemory(
  wsId: string | null,
): UseMutationResult<void, Error, { id: string; patch: UpdateMemoryPatch }> {
  const invalidate = useInvalidate(wsId);
  return useMutation({
    mutationFn: ({ id, patch }) => updateMemory(id, patch),
    onSuccess: invalidate,
  });
}

/** Borra un recuerdo (quien lo guardó o un admin). */
export function useDeleteMemory(
  wsId: string | null,
): UseMutationResult<void, Error, string> {
  const invalidate = useInvalidate(wsId);
  return useMutation({
    mutationFn: (id) => deleteMemory(id),
    onSuccess: invalidate,
  });
}

/** Fija o desfija (aparece arriba en la lista). */
export function usePinMemory(
  wsId: string | null,
): UseMutationResult<void, Error, { id: string; pinned: boolean }> {
  const invalidate = useInvalidate(wsId);
  return useMutation({
    mutationFn: ({ id, pinned }) => setMemoryPinned(id, pinned),
    onSuccess: invalidate,
  });
}

/** Comparte con el espacio un recuerdo privado (confirmación explícita). */
export function useShareMemory(
  wsId: string | null,
): UseMutationResult<void, Error, string> {
  const invalidate = useInvalidate(wsId);
  return useMutation({
    mutationFn: (id) => shareMemory(id),
    onSuccess: invalidate,
  });
}