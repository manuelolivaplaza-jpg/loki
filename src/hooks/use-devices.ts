"use client";

/**
 * Hooks de dispositivos (TanStack Query + Realtime).
 *
 * Nada consulta en bucle: la lista se invalida por foco/montaje y por el canal
 * del PC; cada comando vivo tiene su propio canal que se cierra al terminar.
 */

import * as React from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  confirmDeviceCommand,
  createPairCode,
  fetchCommand,
  listDeviceAudit,
  listDeviceCommands,
  listDevices,
  listenCommand,
  listenDevice,
  revokeDevice,
  saveDeviceSettings,
} from "@/lib/data/devices";
import type {
  DeviceCommandDoc,
  DeviceCommandFilter,
  DeviceDoc,
  DeviceSettingsPatch,
} from "@/types/devices";

const DEVICES_KEY = ["devices"] as const;
const COMMAND_KEY = (id: string): readonly [string, string] => ["device-command", id];
const HISTORY_KEY = (id: string): readonly [string, string] => ["device-history", id];
const AUDIT_KEY = (id: string): readonly [string, string] => ["device-audit", id];

export function useDevices(): {
  devices: DeviceDoc[];
  isPending: boolean;
  error: Error | null;
  retry: () => void;
} {
  const query = useQuery({
    queryKey: DEVICES_KEY,
    queryFn: listDevices,
    staleTime: 30_000,
  });
  return {
    devices: query.data ?? [],
    isPending: query.isPending,
    error: query.error as Error | null,
    retry: () => void query.refetch(),
  };
}

export function usePairCode(): {
  code: string | null;
  createdAt: number | null;
  isPending: boolean;
  error: Error | null;
  generate: (name: string) => void;
  clear: () => void;
} {
  const [code, setCode] = React.useState<string | null>(null);
  const [createdAt, setCreatedAt] = React.useState<number | null>(null);
  const mutation = useMutation({
    mutationFn: (name: string) => createPairCode(name),
    onSuccess: (next) => {
      setCode(next);
      setCreatedAt(Date.now());
    },
  });
  return {
    code,
    createdAt,
    isPending: mutation.isPending,
    error: mutation.error as Error | null,
    generate: (name: string) => mutation.mutate(name),
    clear: () => {
      mutation.reset();
      setCode(null);
      setCreatedAt(null);
    },
  };
}

export function useRevokeDevice(): {
  revoke: (id: string) => void;
  isPending: boolean;
  error: Error | null;
} {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: (id: string) => revokeDevice(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: DEVICES_KEY });
    },
  });
  return {
    revoke: (id: string) => mutation.mutate(id),
    isPending: mutation.isPending,
    error: mutation.error as Error | null,
  };
}

export function useSaveDeviceSettings(): {
  save: (id: string, patch: DeviceSettingsPatch) => void;
  isPending: boolean;
  error: Error | null;
} {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: DeviceSettingsPatch }) =>
      saveDeviceSettings(id, patch),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: DEVICES_KEY });
    },
  });
  return {
    save: (id: string, patch: DeviceSettingsPatch) => mutation.mutate({ id, patch }),
    isPending: mutation.isPending,
    error: mutation.error as Error | null,
  };
}

/** Un comando con su estado en vivo (se cierra solo al terminar). */
export function useDeviceCommand(id: string | null): {
  command: DeviceCommandDoc | null;
  isPending: boolean;
  error: Error | null;
  retry: () => void;
} {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: id === null ? ["device-command", "none"] : COMMAND_KEY(id),
    queryFn: () => (id === null ? Promise.resolve(null) : fetchCommand(id)),
    enabled: id !== null,
    staleTime: 10_000,
  });
  React.useEffect(() => {
    if (id === null) return undefined;
    const stop = listenCommand(id, (next) => {
      client.setQueryData(COMMAND_KEY(id), next);
      if (next === null) return;
      if (next.status === "done" || next.status === "error" || next.status === "expired" || next.status === "rejected") {
        // Estado final: el canal ya no hace falta (nada 24/7).
        stop();
      }
      void client.invalidateQueries({ queryKey: HISTORY_KEY(next.deviceId) });
    });
    return stop;
  }, [id, client]);
  return {
    command: (query.data ?? null) as DeviceCommandDoc | null,
    isPending: query.isPending,
    error: query.error as Error | null,
    retry: () => void query.refetch(),
  };
}

/** Historial de un PC con filtros (acción + estado), en vivo. */
export function useDeviceHistory(
  deviceId: string | null,
  filter: DeviceCommandFilter,
): {
  commands: DeviceCommandDoc[];
  isPending: boolean;
  error: Error | null;
  retry: () => void;
} {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: deviceId === null ? ["device-history", "none"] : HISTORY_KEY(deviceId),
    queryFn: () =>
      deviceId === null ? Promise.resolve([]) : listDeviceCommands(deviceId, 50),
    enabled: deviceId !== null,
    staleTime: 15_000,
  });
  React.useEffect(() => {
    if (deviceId === null) return undefined;
    return listenDevice(deviceId, () => {
      void client.invalidateQueries({ queryKey: HISTORY_KEY(deviceId) });
      void client.invalidateQueries({ queryKey: DEVICES_KEY });
    });
  }, [deviceId, client]);
  const all = (query.data ?? []) as DeviceCommandDoc[];
  const commands = all.filter(
    (cmd) =>
      (filter.action === undefined || filter.action === "all" || cmd.action === filter.action) &&
      (filter.status === undefined || filter.status === "all" || cmd.status === filter.status),
  );
  return {
    commands,
    isPending: query.isPending,
    error: query.error as Error | null,
    retry: () => void query.refetch(),
  };
}

export function useDeviceAudit(deviceId: string | null): {
  entries: Awaited<ReturnType<typeof listDeviceAudit>>;
  isPending: boolean;
  error: Error | null;
  retry: () => void;
} {
  const query = useQuery({
    queryKey: deviceId === null ? ["device-audit", "none"] : AUDIT_KEY(deviceId),
    queryFn: () =>
      deviceId === null ? Promise.resolve([]) : listDeviceAudit(deviceId, 100),
    enabled: deviceId !== null,
    staleTime: 30_000,
  });
  return {
    entries: (query.data ?? []) as Awaited<ReturnType<typeof listDeviceAudit>>,
    isPending: query.isPending,
    error: query.error as Error | null,
    retry: () => void query.refetch(),
  };
}

export function useConfirmDeviceCommand(): {
  decide: (id: string, ok: boolean) => Promise<boolean>;
  isPending: boolean;
  error: Error | null;
} {
  const client = useQueryClient();
  const [error, setError] = React.useState<Error | null>(null);
  const [isPending, setIsPending] = React.useState(false);
  return {
    decide: async (id: string, ok: boolean) => {
      setIsPending(true);
      setError(null);
      try {
        const done = await confirmDeviceCommand(id, ok);
        client.setQueryData(COMMAND_KEY(id), (prev: DeviceCommandDoc | null | undefined) =>
          prev === null || prev === undefined
            ? prev
            : { ...prev, status: ok ? "queued" : "rejected" },
        );
        return done;
      } catch (err) {
        setError(err instanceof Error ? err : new Error("No se pudo registrar tu decisión."));
        return false;
      } finally {
        setIsPending(false);
      }
    },
    isPending,
    error,
  };
}
