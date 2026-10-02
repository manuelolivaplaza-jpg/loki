"use client";

/**
 * Hooks de tareas recurrentes y turnos rotativos sobre TanStack Query.
 *
 * Las series y los intercambios se leen con una query y se refrescan por
 * Realtime mientras la pantalla está montada (nada escuchando 24/7). Las
 * ocurrencias son tareas normales: las mutaciones invalidan también `["tasks"]`
 * y `["today-digest"]` para que el kanban, Inicio y "Tu día" no queden viejos.
 */

import * as React from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  createSeries,
  deleteSeries,
  editSeries,
  getSeriesUsage,
  listSeries,
  listSeriesOccurrences,
  listSwaps,
  listMyOccurrences,
  listenSeries,
  listenSeriesTasks,
  reorderRotation,
  requestSwap,
  resolveSwap,
  setSeriesPauses,
  skipShift,
  type Unsubscribe,
} from "@/lib/data/series";
import type { Database } from "@/types/supabase";
import type {
  NewSeriesInput,
  SeriesItem,
  SeriesPatch,
  SeriesScope,
  SeriesUsage,
  ShiftSwapItem,
} from "@/types/recurring";

type TaskRow = Database["public"]["Tables"]["tasks"]["Row"];

function useInvalidateKeys() {
  const queryClient = useQueryClient();
  return React.useCallback(
    (keys: readonly (readonly unknown[])[]) => {
      for (const key of keys) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
    [queryClient],
  );
}

/** Lo que hay que refrescar cuando cambia una serie o un turno. */
const AFTER_WRITE = [
  ["series"],
  ["series-usage"],
  ["occurrences"],
  ["swaps"],
  ["tasks"],
  ["workspace-tasks"],
  ["today-digest"],
] as const;

// --- Series ------------------------------------------------------------------

export function useSeries(wsId: string | null): UseQueryResult<SeriesItem[], Error> {
  const queryClient = useQueryClient();
  const query = useQuery<SeriesItem[], Error>({
    queryKey: ["series", wsId],
    queryFn: () => listSeries(wsId ?? ""),
    enabled: wsId !== null && wsId !== "",
  });
  React.useEffect(() => {
    if (wsId === null || wsId === "") return;
    const stop: Unsubscribe = listenSeries(wsId, () => {
      void queryClient.invalidateQueries({ queryKey: ["series", wsId] });
      void queryClient.invalidateQueries({ queryKey: ["swaps", wsId] });
    });
    return stop;
  }, [wsId, queryClient]);
  return query;
}

/** Solo las series con rotación y activas (lo que pinta la vista Turnos). */
export function useShiftSeries(wsId: string | null): SeriesItem[] {
  const query = useSeries(wsId);
  return React.useMemo(
    () => (query.data ?? []).filter((series) => series.active && series.rotation.length > 0),
    [query.data],
  );
}

/** Series que se repiten sin rotación (para editarlas desde la lista). */
export function useRecurringSeries(wsId: string | null): SeriesItem[] {
  const query = useSeries(wsId);
  return React.useMemo(
    () => (query.data ?? []).filter((series) => series.active && series.rotation.length === 0),
    [query.data],
  );
}

/** Límite del espacio, visible para el usuario. */
export function useSeriesUsage(wsId: string | null): UseQueryResult<SeriesUsage | null, Error> {
  return useQuery<SeriesUsage | null, Error>({
    queryKey: ["series-usage", wsId],
    queryFn: () => getSeriesUsage(wsId ?? ""),
    enabled: wsId !== null && wsId !== "",
    staleTime: 60_000,
  });
}

export function useCreateSeries(
  wsId: string | null,
): UseMutationResult<string, Error, { uid: string; input: NewSeriesInput }> {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: ({ uid, input }) => {
      if (wsId === null) throw new Error("Falta el espacio.");
      return createSeries(wsId, uid, input);
    },
    onSuccess: () => invalidate(AFTER_WRITE),
  });
}

export function useEditSeries(): UseMutationResult<
  number,
  Error,
  { seriesId: string; patch: SeriesPatch; scope?: SeriesScope; taskId?: string | null }
> {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: ({ seriesId, patch, scope, taskId }) =>
      editSeries(seriesId, scope ?? "all", patch, taskId ?? null),
    onSuccess: () => invalidate(AFTER_WRITE),
  });
}

export function useSetSeriesPauses(): UseMutationResult<
  number,
  Error,
  { seriesId: string; pauses: SeriesItem["pauses"] }
> {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: ({ seriesId, pauses }) => setSeriesPauses(seriesId, pauses),
    onSuccess: () => invalidate(AFTER_WRITE),
  });
}

export function useDeleteSeries(): UseMutationResult<
  void,
  Error,
  { seriesId: string; scope?: SeriesScope; taskId?: string | null }
> {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: ({ seriesId, scope, taskId }) =>
      deleteSeries(seriesId, scope ?? "all", taskId ?? null),
    onSuccess: () => invalidate(AFTER_WRITE),
  });
}

// --- Ocurrencias (tareas de una serie) -----------------------------------------

/** Ocurrencias ya materializadas en una ventana (marcas del calendario). */
export function useSeriesOccurrences(
  wsId: string | null,
  from: Date | null,
  to: Date | null,
): UseQueryResult<TaskRow[], Error> {
  const queryClient = useQueryClient();
  const fromISO = from?.toISOString() ?? null;
  const toISO = to?.toISOString() ?? null;
  const query = useQuery<TaskRow[], Error>({
    queryKey: ["occurrences", wsId, fromISO, toISO],
    queryFn: () => listSeriesOccurrences(wsId ?? "", fromISO ?? "", toISO ?? ""),
    enabled: wsId !== null && wsId !== "" && fromISO !== null && toISO !== null,
  });
  React.useEffect(() => {
    if (wsId === null || wsId === "") return;
    const stop: Unsubscribe = listenSeriesTasks(wsId, () => {
      void queryClient.invalidateQueries({ queryKey: ["occurrences"] });
    });
    return stop;
  }, [wsId, queryClient]);
  return query;
}

/** Mis turnos de hoy (bloque "Te toca hoy" de Inicio y de "Tu día"). */
export function useMyOccurrences(
  wsId: string | null,
  uid: string | null,
  dayKey: string,
): UseQueryResult<TaskRow[], Error> {
  const queryClient = useQueryClient();
  const query = useQuery<TaskRow[], Error>({
    queryKey: ["occurrences-today", wsId, uid, dayKey],
    queryFn: () => listMyOccurrences(wsId ?? "", uid ?? "", dayKey),
    enabled: wsId !== null && wsId !== "" && uid !== null,
    staleTime: 60_000,
  });
  React.useEffect(() => {
    if (wsId === null || wsId === "") return;
    const stop: Unsubscribe = listenSeriesTasks(wsId, () => {
      void queryClient.invalidateQueries({ queryKey: ["occurrences-today"] });
    });
    return stop;
  }, [wsId, queryClient]);
  return query;
}

// --- Turnos --------------------------------------------------------------------

export function useShiftSwaps(
  wsId: string | null,
  uid: string | null,
): UseQueryResult<ShiftSwapItem[], Error> {
  const queryClient = useQueryClient();
  const query = useQuery<ShiftSwapItem[], Error>({
    queryKey: ["swaps", wsId, uid],
    queryFn: () => listSwaps(wsId ?? "", uid ?? ""),
    enabled: wsId !== null && wsId !== "" && uid !== null && uid !== "",
  });
  React.useEffect(() => {
    if (wsId === null || wsId === "") return;
    const stop: Unsubscribe = listenSeries(wsId, () => {
      void queryClient.invalidateQueries({ queryKey: ["swaps"] });
    });
    return stop;
  }, [wsId, queryClient]);
  return query;
}

export function useRequestSwap(): UseMutationResult<
  string,
  Error,
  { taskId: string; toUserId: string; note?: string }
> {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: ({ taskId, toUserId, note }) => requestSwap(taskId, toUserId, note ?? ""),
    onSuccess: () => invalidate(AFTER_WRITE),
  });
}

export function useResolveSwap(): UseMutationResult<
  void,
  Error,
  { swapId: string; accept: boolean }
> {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: ({ swapId, accept }) => resolveSwap(swapId, accept),
    onSuccess: () => invalidate(AFTER_WRITE),
  });
}

/** Falta de un miembro en la rotación (vacaciones) en un rango de fechas. */
export function useSkipShift(): UseMutationResult<
  number,
  Error,
  { seriesId: string; userId: string; from: string; to: string; reason?: string }
> {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: ({ seriesId, userId, from, to, reason }) =>
      skipShift(seriesId, userId, from, to, reason ?? ""),
    onSuccess: () => invalidate(AFTER_WRITE),
  });
}

export function useReorderRotation(): UseMutationResult<
  void,
  Error,
  { seriesId: string; order: string[] }
> {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: ({ seriesId, order }) => reorderRotation(seriesId, order),
    onSuccess: () => invalidate(AFTER_WRITE),
  });
}