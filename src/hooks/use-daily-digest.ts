"use client";

/**
 * Hooks de "Tu día" (resumen diario) sobre TanStack Query.
 *
 * - Preferencias por usuario (`daily_digest_prefs`).
 * - `useTodayDigest`: datos deterministas del día agrupados por espacio
 *   (eventos de hoy, tareas que vencen/atrasadas, listas fijadas con
 *   pendientes, encuestas abiertas sin mi voto). Una sola query por día.
 * - `useDayHighlights`: destacados con IA bajo demanda (trabajo
 *   `day_highlights`, cacheado por día). Solo se pide al abrir "Tu día".
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
  getCachedDayHighlights,
  getDailyDigestPrefs,
  listOpenPollsWithoutVote,
  listPinnedListsWithPending,
  listTodayEvents,
  listTodayShifts,
  listTodayTasks,
  listenDayHighlightsJob,
  requestDayHighlights,
  saveDailyDigestPrefs,
  type DayHighlights,
  type TodayList,
  type TodayPoll,
  type TodayShift,
} from "@/lib/data/daily-digest";
import type {
  DailyDigestPrefs,
  EventOccurrence,
  TaskItem,
} from "@/types/organizer";

export function useDailyDigestPrefs(
  uid: string | null,
): UseQueryResult<DailyDigestPrefs, Error> {
  return useQuery<DailyDigestPrefs, Error>({
    queryKey: ["daily-digest-prefs", uid],
    queryFn: () => getDailyDigestPrefs(uid ?? ""),
    enabled: uid !== null,
    staleTime: Infinity,
  });
}

export function useSaveDailyDigestPrefs(): UseMutationResult<
  void,
  Error,
  DailyDigestPrefs
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (prefs: DailyDigestPrefs) => saveDailyDigestPrefs(prefs),
    onSuccess: (_data, prefs) => {
      queryClient.setQueryData<DailyDigestPrefs>(
        ["daily-digest-prefs", prefs.userId],
        prefs,
      );
    },
  });
}

// --- Datos del día agrupados por espacio -----------------------------------------

export type TodaySpaceDigest = {
  wsId: string;
  wsName: string;
  wsEmoji: string;
  events: EventOccurrence[];
  dueToday: TaskItem[];
  overdue: TaskItem[];
  /** Turnos que me tocan hoy (ocurrencias de series). */
  shifts: TodayShift[];
  lists: TodayList[];
  polls: TodayPoll[];
};

function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${(now.getMonth() + 1).toString().padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")}`;
}

export function useTodayDigest(
  spaces: readonly { wsId: string; name: string; emoji: string }[],
  uid: string | null,
  includedIds: readonly string[] | null,
): {
  groups: TodaySpaceDigest[];
  isPending: boolean;
  error: Error | null;
  retry: () => void;
} {
  const day = todayKey();
  const scoped = React.useMemo(() => {
    if (includedIds === null || includedIds.length === 0) return [...spaces];
    const wanted = new Set(includedIds);
    const filtered = spaces.filter((space) => wanted.has(space.wsId));
    return filtered.length > 0 ? filtered : [...spaces];
  }, [spaces, includedIds]);
  const idsKey = scoped.map((space) => space.wsId).join(",");
  const query = useQuery<TodaySpaceDigest[], Error>({
    queryKey: ["today-digest", idsKey, uid, day],
    queryFn: async () => {
      if (uid === null) return [];
      const groups: TodaySpaceDigest[] = [];
      for (const space of scoped) {
        const [events, tasks, shifts, lists, polls] = await Promise.all([
          listTodayEvents(space.wsId).catch(() => []),
          listTodayTasks(space.wsId, uid).catch(() => ({ dueToday: [], overdue: [] })),
          listTodayShifts(space.wsId, uid, day).catch(() => []),
          listPinnedListsWithPending(space.wsId).catch(() => []),
          listOpenPollsWithoutVote(space.wsId, uid).catch(() => []),
        ]);
        groups.push({
          wsId: space.wsId,
          wsName: space.name,
          wsEmoji: space.emoji,
          events,
          dueToday: tasks.dueToday,
          overdue: tasks.overdue,
          shifts,
          lists,
          polls,
        });
      }
      return groups;
    },
    enabled: uid !== null && scoped.length > 0,
    staleTime: 60_000,
  });
  return {
    groups: query.data ?? [],
    isPending: query.isPending,
    error: query.error,
    retry: () => {
      void query.refetch();
    },
  };
}

// --- Destacados con IA (bajo demanda, cacheados por día) --------------------------

export function useDayHighlights(
  wsId: string | null,
  uid: string | null,
): {
  highlights: DayHighlights | null;
  isPending: boolean;
  failed: boolean;
  request: () => void;
  requesting: boolean;
} {
  const day = todayKey();
  const queryClient = useQueryClient();
  const [jobFailed, setJobFailed] = React.useState(false);
  const [requesting, setRequesting] = React.useState(false);
  const query = useQuery<DayHighlights | null, Error>({
    queryKey: ["day-highlights", uid, day],
    queryFn: () => getCachedDayHighlights(uid ?? ""),
    enabled: uid !== null,
    staleTime: 5 * 60_000,
  });

  const request = React.useCallback(() => {
    if (wsId === null || uid === null || requesting) return;
    // Con cache válido no se paga de nuevo.
    const current = queryClient.getQueryData<DayHighlights | null>(["day-highlights", uid, day]);
    if (current !== undefined && current !== null && current.status !== "unavailable") return;
    setRequesting(true);
    setJobFailed(false);
    void (async () => {
      try {
        const jobId = await requestDayHighlights(wsId, uid);
        listenDayHighlightsJob(jobId, (done, failed) => {
          if (!done) return;
          setRequesting(false);
          if (failed) {
            setJobFailed(true);
            return;
          }
          void queryClient.invalidateQueries({ queryKey: ["day-highlights", uid, day] });
        });
        // Si el worker ya lo terminó (cache), el evento no llega: reintento
        // único a los pocos segundos.
        window.setTimeout(() => {
          void queryClient.invalidateQueries({ queryKey: ["day-highlights", uid, day] });
          setRequesting(false);
        }, 20_000);
      } catch {
        setRequesting(false);
        setJobFailed(true);
      }
    })();
  }, [wsId, uid, requesting, queryClient, day]);

  return {
    highlights: query.data ?? null,
    isPending: query.isPending,
    failed: jobFailed,
    request,
    requesting,
  };
}
