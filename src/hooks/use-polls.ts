"use client";

/**
 * Hooks de encuestas (TanStack Query + Realtime).
 *
 * `poll_results` es la única fuente de verdad de la tarjeta, así que cualquier
 * cambio (voto, opción, cierre) invalida su clave y la tarjeta se repinta sola.
 * La disponibilidad de las opciones con fecha es una consulta aparte: solo se
 * pide para kind 'date' y nunca en bucle (nada escuchando 24/7).
 */

import * as React from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import {
  addPollOption,
  castPollVote,
  closePoll,
  createPoll,
  deletePoll,
  deletePollOption,
  fetchPoll,
  fetchPollBusy,
  listenPoll,
  updatePoll,
  updatePollOption,
  type CreatedPoll,
  type NewPollOption,
  type UpdatePollPatch,
} from "@/lib/data/polls";
import { useSessionStore } from "@/stores/session-store";
import type {
  NewPollInput,
  PollSettings,
  PollView,
} from "@/types/organizer";

const POLL_KEY = (pollId: string): readonly [string, string] => ["poll", pollId];
const POLL_BUSY_KEY = (pollId: string): readonly [string, string] => ["poll-busy", pollId];

export type PollState = {
  poll: PollView | null;
  /** Opciones con el número de ocupados ya cruzado (kind 'date'). */
  busy: Map<string, number> | null;
  isPending: boolean;
  isBusyPending: boolean;
  error: Error | null;
  busyError: Error | null;
  /** La encuesta ya no existe (o el chat se cerró para este usuario). */
  isGone: boolean;
  retry: () => void;
};

function applyBusy(poll: PollView, busy: Map<string, number> | null): PollView {
  if (busy === null) return poll;
  return {
    ...poll,
    options: poll.options.map((option) => ({
      ...option,
      busy: busy.get(option.id) ?? 0,
    })),
  };
}

/**
 * Estado de una encuesta. Se suscribe solo mientras el componente está montado
 * (al desmontar, la tarjeta deja de escuchar; nada queda consultando).
 */
export function usePoll(pollId: string | null): PollState {
  const queryClient = useQueryClient();
  const enabled = pollId !== null && pollId !== "";

  const query = useQuery<PollView | null, Error>({
    queryKey: enabled ? POLL_KEY(pollId) : ["poll", null],
    queryFn: () => fetchPoll(pollId ?? ""),
    enabled,
    staleTime: 10_000,
  });

  // Disponibilidad: solo en encuestas de fecha (SQL barato, una vez por estado).
  const wantsBusy = enabled && (query.data?.kind ?? "") === "date";
  const busyQuery = useQuery<Map<string, number> | null, Error>({
    queryKey: enabled ? POLL_BUSY_KEY(pollId) : ["poll-busy", null],
    queryFn: () => fetchPollBusy(pollId ?? ""),
    enabled: enabled && wantsBusy,
    staleTime: 60_000,
  });

  React.useEffect(() => {
    if (!enabled || pollId === null || pollId === "") return;
    const activePollId = pollId;
    const stop = listenPoll(activePollId, () => {
      void queryClient.invalidateQueries({ queryKey: POLL_KEY(activePollId) });
    });
    return stop;
  }, [enabled, pollId, queryClient]);

  const poll = query.data ?? null;
  const busy = wantsBusy ? (busyQuery.data ?? null) : null;

  return {
    poll: poll === null ? null : applyBusy(poll, busy),
    busy,
    isPending: enabled && query.isPending,
    isBusyPending: wantsBusy && busyQuery.isPending,
    error: query.error,
    busyError: busyQuery.error,
    isGone: query.isSuccess && query.data === null,
    retry: () => {
      void query.refetch();
      if (wantsBusy) void busyQuery.refetch();
    },
  };
}

function useInvalidatePoll(pollId: string | null): () => void {
  const queryClient = useQueryClient();
  return React.useCallback(() => {
    if (pollId === null || pollId === "") return;
    void queryClient.invalidateQueries({ queryKey: POLL_KEY(pollId) });
  }, [pollId, queryClient]);
}

/** Vota, cambia el voto o lo retira. Refleja al instante (optimista). */
export function useCastPollVote(
  pollId: string | null,
): UseMutationResult<void, Error, string[]> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (optionIds: string[]) => {
      if (pollId === null || pollId === "") throw new Error("Falta la encuesta.");
      return castPollVote(pollId, optionIds);
    },
    onMutate: (optionIds) => {
      if (pollId === null || pollId === "") return;
      // La barra se mueve ya (en móvil se nota la latencia); la RLS y el
      // Realtime la confirman después, y si algo falla se vuelve a pedir el
      // estado real en `onSettled`.
      const uid = myUid();
      void queryClient.setQueryData<PollView | null>(POLL_KEY(pollId), (old) => {
        if (old === null || old === undefined) return old;
        const mine = new Set(optionIds);
        const options = old.options.map((option) => {
          const isMine = mine.has(option.id);
          if (option.mine === isMine) return option;
          return {
            ...option,
            mine: isMine,
            votes: Math.max(0, option.votes + (isMine ? 1 : -1)),
            voters:
              uid === "" || option.voters.includes(uid)
                ? option.voters
                : option.mine
                  ? option.voters.filter((entry) => entry !== uid)
                  : [...option.voters, uid],
          };
        });
        const maxVotes = Math.max(0, ...options.map((option) => option.votes));
        const hadMine = old.options.some((option) => option.mine);
        const nowMine = optionIds.length > 0;
        const totalVotes = Math.max(0, old.totalVotes + (nowMine ? 1 : 0) - (hadMine ? 1 : 0));
        const top = maxVotes <= 0 ? [] : options.filter((option) => option.votes === maxVotes);
        // Mientras está abierta el resultado no importa; al cerrar queda fijo.
        const winners = !old.isOpen && top.length === 1 ? [top[0]?.id ?? ""] : old.winners;
        const tied = !old.isOpen && maxVotes > 0 && top.length > 1;
        return { ...old, options, maxVotes, totalVotes, winners, tied };
      });
    },
    onSettled: () => {
      if (pollId !== null) void queryClient.invalidateQueries({ queryKey: POLL_KEY(pollId) });
    },
  });
}

/** Uid del usuario en sesión (para el voto optimista). */
function myUid(): string {
  return useSessionStore.getState().user?.uid ?? "";
}

export function useClosePoll(
  pollId: string | null,
): UseMutationResult<void, Error, void> {
  const invalidate = useInvalidatePoll(pollId);
  return useMutation({
    mutationFn: () => {
      if (pollId === null || pollId === "") throw new Error("Falta la encuesta.");
      return closePoll(pollId);
    },
    onSuccess: invalidate,
  });
}

export function useDeletePoll(
  pollId: string | null,
): UseMutationResult<void, Error, void> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => {
      if (pollId === null || pollId === "") throw new Error("Falta la encuesta.");
      return deletePoll(pollId);
    },
    onSuccess: () => {
      if (pollId !== null) void queryClient.invalidateQueries({ queryKey: POLL_KEY(pollId) });
    },
  });
}

export function useUpdatePoll(
  pollId: string | null,
): UseMutationResult<void, Error, UpdatePollPatch> {
  const invalidate = useInvalidatePoll(pollId);
  return useMutation({
    mutationFn: (patch) => {
      if (pollId === null || pollId === "") throw new Error("Falta la encuesta.");
      return updatePoll(pollId, patch);
    },
    onSuccess: invalidate,
  });
}

/**
 * Crear la encuesta: escribe el mensaje tarjeta, la encuesta y sus opciones.
 * El chat va en las variables (no en el hook) porque la hoja de creación a
 * veces lo elige el usuario (acción rápida) y a veces ya viene del composer.
 */
export function useCreatePoll(
  wsId: string | null,
): UseMutationResult<
  CreatedPoll,
  Error,
  { input: NewPollInput; authorName: string; chatId: string }
> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ input, authorName, chatId }) => {
      const uid = myUid();
      if (wsId === null || wsId === "" || chatId === null || chatId === "") {
        throw new Error("Falta el espacio o el chat.");
      }
      if (uid === "") throw new Error("Inicia sesión para crear una encuesta.");
      return createPoll(wsId, chatId, uid, authorName, input);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["messages"] });
    },
  });
}

export function useAddPollOption(
  pollId: string | null,
  wsId: string | null,
): UseMutationResult<void, Error, NewPollOption> {
  const invalidate = useInvalidatePoll(pollId);
  return useMutation({
    mutationFn: (option) => {
      const uid = myUid();
      if (pollId === null || pollId === "" || wsId === null || wsId === "") {
        throw new Error("Falta la encuesta.");
      }
      if (uid === "") throw new Error("Inicia sesión para agregar opciones.");
      return addPollOption(pollId, wsId, uid, option);
    },
    onSuccess: invalidate,
  });
}

export function useUpdatePollOption(
  pollId: string | null,
): UseMutationResult<void, Error, { optionId: string; patch: { text?: string; startsAt?: Date | null; endsAt?: Date | null } }> {
  const invalidate = useInvalidatePoll(pollId);
  return useMutation({
    mutationFn: ({ optionId, patch }) => updatePollOption(optionId, patch),
    onSuccess: invalidate,
  });
}

export function useDeletePollOption(
  pollId: string | null,
): UseMutationResult<void, Error, string> {
  const invalidate = useInvalidatePoll(pollId);
  return useMutation({
    mutationFn: (optionId: string) => deletePollOption(optionId),
    onSuccess: invalidate,
  });
}

export type { PollSettings };
