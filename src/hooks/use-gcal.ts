"use client";

/**
 * Hook de Google Calendar sobre TanStack Query (clave ["gcal"]).
 *
 * - `status`: estado de la conexión (conectado, email, último sync).
 * - `connect()`: pide la URL OAuth a la Edge y redirige a Google.
 * - `disconnect()`: borra la conexión (previa confirmación en la UI).
 * - `pull()`: importa de Google y refresca ["gcal"] + ["events"].
 * - `pushing`: true mientras hay un push/pull en vuelo.
 * Sin conexión todo es no-op: el calendario funciona solo con Loki.
 */

import * as React from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  authUrlGcal,
  disconnectGcal,
  pullGcal,
  statusGcal,
  type GcalPullResult,
  type GcalStatus,
} from "@/lib/data/gcal";

export const GCAL_QUERY_KEY = ["gcal"] as const;

const GCAL_OFFLINE: GcalStatus = {
  connected: false,
  email: "",
  lastPullAt: null,
  syncEnabled: false,
  calendarId: "primary",
};

export function useGcalStatus(): UseQueryResult<GcalStatus, Error> {
  return useQuery<GcalStatus, Error>({
    queryKey: [...GCAL_QUERY_KEY],
    queryFn: () => statusGcal(),
    staleTime: 60_000,
    retry: false,
  });
}

export function useGcal(): {
  status: GcalStatus;
  isPending: boolean;
  error: Error | null;
  connect: () => Promise<void>;
  connecting: boolean;
  connectError: string | null;
  disconnect: () => Promise<void>;
  disconnecting: boolean;
  pull: () => Promise<GcalPullResult | null>;
  pulling: boolean;
  pushing: boolean;
  lastError: string | null;
  retry: () => void;
} {
  const queryClient = useQueryClient();
  const query = useGcalStatus();
  const [connectError, setConnectError] = React.useState<string | null>(null);
  const [lastError, setLastError] = React.useState<string | null>(null);

  const connectMutation = useMutation<string, Error>({
    mutationFn: () => authUrlGcal(),
    onSuccess: (url) => {
      setConnectError(null);
      window.location.href = url;
    },
    onError: (err) => setConnectError(err.message),
  });

  const disconnectMutation = useMutation<void, Error>({
    mutationFn: () => disconnectGcal(),
    onSuccess: () => {
      setLastError(null);
      queryClient.setQueryData<GcalStatus>([...GCAL_QUERY_KEY], GCAL_OFFLINE);
      void queryClient.invalidateQueries({ queryKey: [...GCAL_QUERY_KEY] });
    },
    onError: (err) => setLastError(err.message),
  });

  const pullMutation = useMutation<GcalPullResult, Error>({
    mutationFn: () => pullGcal(),
    onSuccess: () => {
      setLastError(null);
      void queryClient.invalidateQueries({ queryKey: [...GCAL_QUERY_KEY] });
      void queryClient.invalidateQueries({ queryKey: ["events"] });
    },
    onError: (err) => setLastError(err.message),
  });

  async function pull(): Promise<GcalPullResult | null> {
    setLastError(null);
    if (query.data?.connected !== true) return null;
    try {
      return await pullMutation.mutateAsync();
    } catch {
      // pullMutation ya dejó el mensaje en lastError; no-op discreto.
      return null;
    }
  }

  return {
    status: query.data ?? GCAL_OFFLINE,
    isPending: query.isPending,
    error: query.error,
    connect: () => connectMutation.mutateAsync().then(() => undefined),
    connecting: connectMutation.isPending,
    connectError,
    disconnect: () => disconnectMutation.mutateAsync(),
    disconnecting: disconnectMutation.isPending,
    pull,
    pulling: pullMutation.isPending,
    pushing: connectMutation.isPending || pullMutation.isPending,
    lastError,
    retry: () => {
      void query.refetch();
    },
  };
}
