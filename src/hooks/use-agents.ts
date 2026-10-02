"use client";

/**
 * Hooks de agentes personales sobre TanStack Query.
 *
 * - `useMyAgents`: mis conexiones (dueño) + Realtime.
 * - `useSpaceAgents`: agentes habilitados en un espacio.
 * - `useAgentRun`: ejecución + eventos en vivo (Probar conexión).
 * Mutaciones con `AgentError` (mensaje ya en español para la UI).
 */

import * as React from "react";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  addAgentGrant,
  AgentError,
  agentsConfigured,
  cancelAgentRun,
  continueAgentRun,
  createAgent,
  deleteAgent,
  fetchAgentRun,
  fetchDefaultChatId,
  fetchRunsForMessages,
  getAgentUsageToday,
  listGrants,
  listMyAgents,
  listRunEvents,
  listSpaceAgents,
  listenAgentRun,
  listenMyAgents,
  removeAgentGrant,
  revokeAgentInbound,
  rotateAgentInbound,
  setAgentOutbound,
  setAgentStatus,
  setGrantAdminDisabled,
  startAgentPing,
  startAgentTask,
  updateAgent,
  updateAgentGrant,
  type AgentGrantInput,
} from "@/lib/data/agents";
import type {
  AgentConnection,
  AgentProvider,
  AgentRun,
  AgentRunEvent,
  AgentSpaceGrant,
  AgentStatus,
} from "@/types/agents";

export const AGENTS_QUERY_KEY = ["agents"] as const;

function toMessage(error: unknown): string {
  if (error instanceof AgentError) return error.message;
  if (error instanceof Error && error.message !== "") return error.message;
  return "Algo salió mal. Inténtalo de nuevo.";
}

export function useAgentsConfigured(): UseQueryResult<boolean | null, Error> {
  return useQuery<boolean | null, Error>({
    queryKey: [...AGENTS_QUERY_KEY, "configured"],
    queryFn: () => agentsConfigured(),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export function useMyAgents(uid: string | null): UseQueryResult<AgentConnection[], Error> {
  const queryClient = useQueryClient();
  const query = useQuery<AgentConnection[], Error>({
    queryKey: [...AGENTS_QUERY_KEY, "mine", uid],
    queryFn: () => listMyAgents(uid ?? ""),
    enabled: uid !== null,
    staleTime: 30_000,
    retry: false,
  });
  React.useEffect(() => {
    if (uid === null) return;
    return listenMyAgents(uid, () => {
      void queryClient.invalidateQueries({ queryKey: [...AGENTS_QUERY_KEY, "mine", uid] });
    });
  }, [uid, queryClient]);
  return query;
}

export function useAgentGrants(
  connectionId: string | null,
): UseQueryResult<AgentSpaceGrant[], Error> {
  return useQuery<AgentSpaceGrant[], Error>({
    queryKey: [...AGENTS_QUERY_KEY, "grants", connectionId],
    queryFn: () => listGrants(connectionId ?? ""),
    enabled: connectionId !== null,
    staleTime: 30_000,
    retry: false,
  });
}

export function useSpaceAgents(
  workspaceId: string | null,
): UseQueryResult<
  {
    connection: Pick<AgentConnection, "id" | "name" | "handle" | "avatarEmoji" | "status" | "description">;
    ownerId: string;
    grant: AgentSpaceGrant;
  }[],
  Error
> {
  return useQuery({
    queryKey: [...AGENTS_QUERY_KEY, "space", workspaceId],
    queryFn: () => listSpaceAgents(workspaceId ?? ""),
    enabled: workspaceId !== null,
    staleTime: 30_000,
    retry: false,
  });
}

export function useAgentRun(
  runId: string | null,
): {
  run: AgentRun | null;
  events: AgentRunEvent[];
  isPending: boolean;
  error: string | null;
  retry: () => void;
} {
  const queryClient = useQueryClient();
  const key = [...AGENTS_QUERY_KEY, "run", runId] as const;
  const query = useQuery<{ run: AgentRun | null; events: AgentRunEvent[] }, Error>({
    queryKey: key,
    queryFn: async () => {
      if (runId === null) return { run: null, events: [] };
      const [run, events] = await Promise.all([
        fetchAgentRun(runId),
        listRunEvents(runId),
      ]);
      return { run, events };
    },
    enabled: runId !== null,
    staleTime: 5_000,
    retry: false,
    refetchInterval: (data) => {
      const status = data?.run?.status;
      if (status === undefined) return false;
      return status === "queued" || status === "dispatched" || status === "running" ||
          status === "needs_input"
        ? 3_000
        : false;
    },
  });
  React.useEffect(() => {
    if (runId === null) return;
    return listenAgentRun(runId, () => {
      void queryClient.invalidateQueries({ queryKey: key });
    });
  }, [runId, queryClient]);
  return {
    run: query.data?.run ?? null,
    events: query.data?.events ?? [],
    isPending: query.isPending,
    error: query.error ? toMessage(query.error) : null,
    retry: () => {
      void query.refetch();
    },
  };
}

function useInvalidateMine(uid: string | null) {
  const queryClient = useQueryClient();
  return React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: [...AGENTS_QUERY_KEY, "mine", uid] });
    void queryClient.invalidateQueries({ queryKey: [...AGENTS_QUERY_KEY, "space"] });
  }, [queryClient, uid]);
}

export function useCreateAgent(uid: string | null): {
  create: (input: {
    provider: AgentProvider;
    name: string;
    handle: string;
    description?: string;
    avatarEmoji?: string;
    workspaceId?: string;
    grant?: Omit<AgentGrantInput, "workspaceId">;
  }) => Promise<AgentConnection>;
  creating: boolean;
  error: string | null;
} {
  const invalidate = useInvalidateMine(uid);
  const [error, setError] = React.useState<string | null>(null);
  const mutation = useMutation<AgentConnection, Error, Parameters<typeof createAgent>[0]>({
    mutationFn: (input) => createAgent(input),
    onSuccess: () => {
      setError(null);
      invalidate();
    },
    onError: (err) => setError(toMessage(err)),
  });
  return {
    create: (input) => mutation.mutateAsync(input),
    creating: mutation.isPending,
    error,
  };
}

export function useAgentMutations(uid: string | null): {
  saving: boolean;
  error: string | null;
  update: (connectionId: string, patch: { name?: string; handle?: string; description?: string; avatarEmoji?: string }) => Promise<AgentConnection>;
  setOutbound: (connectionId: string, input: { dispatchUrl?: string; outboundSecret?: string }) => Promise<void>;
  rotateInbound: (connectionId: string) => Promise<string>;
  revokeInbound: (connectionId: string) => Promise<void>;
  setStatus: (connectionId: string, status: AgentStatus) => Promise<void>;
  remove: (connectionId: string) => Promise<void>;
  addGrant: (input: AgentGrantInput & { connectionId: string }) => Promise<void>;
  updateGrant: (grantId: string, patch: Partial<Omit<AgentSpaceGrant, "id" | "connectionId" | "workspaceId" | "adminDisabled">>) => Promise<void>;
  removeGrant: (grantId: string) => Promise<void>;
  setAdminDisabled: (grantId: string, disabled: boolean) => Promise<void>;
  ping: (input: { connectionId: string; workspaceId: string }) => Promise<AgentRun>;
  cancelRun: (runId: string) => Promise<boolean>;
  clearError: () => void;
} {
  const invalidate = useInvalidateMine(uid);
  const queryClient = useQueryClient();
  const [error, setError] = React.useState<string | null>(null);

  async function wrap<T>(work: () => Promise<T>): Promise<T> {
    setError(null);
    try {
      const out = await work();
      invalidate();
      return out;
    } catch (err) {
      setError(toMessage(err));
      throw err;
    }
  }

  const [saving, setSaving] = React.useState(false);
  async function guarded<T>(work: () => Promise<T>): Promise<T> {
    setSaving(true);
    try {
      return await wrap(work);
    } finally {
      setSaving(false);
    }
  }

  return {
    saving,
    error,
    update: (connectionId, patch) => guarded(() => updateAgent(connectionId, patch)),
    setOutbound: (connectionId, input) => guarded(() => setAgentOutbound(connectionId, input)),
    rotateInbound: (connectionId) => guarded(() => rotateAgentInbound(connectionId)),
    revokeInbound: (connectionId) => guarded(() => revokeAgentInbound(connectionId)),
    setStatus: (connectionId, status) => guarded(() => setAgentStatus(connectionId, status)),
    remove: (connectionId) => guarded(() => deleteAgent(connectionId)),
    addGrant: (input) =>
      guarded(() =>
        addAgentGrant(input).then(() => {
          void queryClient.invalidateQueries({ queryKey: [...AGENTS_QUERY_KEY, "grants"] });
        })
      ),
    updateGrant: (grantId, patch) =>
      guarded(() =>
        updateAgentGrant(grantId, patch).then(() => {
          void queryClient.invalidateQueries({ queryKey: [...AGENTS_QUERY_KEY, "grants"] });
        })
      ),
    removeGrant: (grantId) =>
      guarded(() =>
        removeAgentGrant(grantId).then(() => {
          void queryClient.invalidateQueries({ queryKey: [...AGENTS_QUERY_KEY, "grants"] });
        })
      ),
    setAdminDisabled: (grantId, disabled) =>
      guarded(() => setGrantAdminDisabled(grantId, disabled)),
    ping: (input) =>
      guarded(async () => {
        const chatId = await fetchDefaultChatId(input.workspaceId);
        return startAgentPing({ ...input, chatId, uid: uid ?? "" });
      }),
    cancelRun: (runId) => guarded(() => cancelAgentRun(runId)),
    clearError: () => setError(null),
  };
}

/**
 * Candidatos @ de agentes invocables por este usuario en el espacio.
 * (La vista del chat combina miembros + estos con `spaceAgentsToCandidates`.)
 */
export function useSpaceAgentCandidates(
  workspaceId: string | null,
  uid: string | null,
  memberNames: Map<string, string>,
): { candidates: import("@/lib/chat/mentions").MentionCandidate[]; isPending: boolean } {
  const spaceAgents = useSpaceAgents(workspaceId);
  const candidates = React.useMemo(() => {
    if (workspaceId === null || uid === null) return [];
    const out: import("@/lib/chat/mentions").MentionCandidate[] = [];
    for (const entry of spaceAgents.data ?? []) {
      const grant = entry.grant;
      const allowed = entry.ownerId === uid ||
        (grant.enabled && !grant.adminDisabled &&
          (grant.allowedCallers === "space_members" ||
            (grant.allowedCallers === "listed" && grant.allowedUserIds.includes(uid)) ||
            (grant.allowedCallers === "owner_only" && entry.ownerId === uid)));
      if (!allowed) continue;
      if (entry.connection.status !== "active") continue;
      const ownerName = memberNames.get(entry.ownerId)?.trim() ?? "";
      out.push({
        id: `agent:${entry.connection.id}`,
        displayName: entry.connection.handle,
        kind: "agent",
        handle: entry.connection.handle,
        ownerName,
        avatarEmoji: entry.connection.avatarEmoji,
      });
    }
    out.sort((a, b) => a.displayName.localeCompare(b.displayName, "es"));
    return out;
  }, [spaceAgents.data, workspaceId, uid, memberNames]);
  return { candidates, isPending: spaceAgents.isPending };
}

/** Ejecuciones disparadas por un mensaje (tarjeta bajo él), en vivo. */
export function useMessageAgentRuns(messageId: string | null): {
  runs: AgentRun[];
  isPending: boolean;
} {
  const queryClient = useQueryClient();
  const query = useQuery<AgentRun[], Error>({
    queryKey: [...AGENTS_QUERY_KEY, "by-message", messageId],
    queryFn: () => fetchRunsForMessages(messageId === null ? [] : [messageId]),
    enabled: messageId !== null && messageId !== "",
    staleTime: 5_000,
    retry: false,
    // La fila queued la crea el cliente justo después del mensaje: mientras no
    // haya filas se reintenta corto (el trigger despierta al despacho en
    // segundos); con filas, manda el Realtime por ejecución.
    refetchInterval: (data) =>
      data !== undefined && data.length === 0 ? 5_000 : false,
  });
  React.useEffect(() => {
    if (messageId === null || messageId === "") return;
    // Realtime por ejecución conocida + refresco de la lista (el insert
    // inicial llega como evento de agent_runs del espacio).
    const cleanups: (() => void)[] = [];
    for (const run of query.data ?? []) {
      cleanups.push(
        listenAgentRun(run.id, () => {
          void queryClient.invalidateQueries({
            queryKey: [...AGENTS_QUERY_KEY, "by-message", messageId],
          });
          void queryClient.invalidateQueries({
            queryKey: [...AGENTS_QUERY_KEY, "run", run.id],
          });
        }),
      );
    }
    // La primera ejecución aún no se conoce al suscribirse: reintento corto
    // mientras no haya filas (el trigger despierta al despacho en segundos).
    if ((query.data ?? []).length === 0) {
      const timer = setTimeout(() => {
        void queryClient.invalidateQueries({
          queryKey: [...AGENTS_QUERY_KEY, "by-message", messageId],
        });
      }, 4000);
      return () => {
        clearTimeout(timer);
        for (const cleanup of cleanups) cleanup();
      };
    }
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [messageId, query.data, queryClient]);
  return { runs: query.data ?? [], isPending: query.isPending };
}

/** Invoca agentes desde un mensaje ya enviado (una fila queued por agente). */
export function useInvokeAgents(): {
  invoke: (input: {
    agents: { connectionId: string; handle: string }[];
    workspaceId: string;
    chatId: string;
    messageId: string;
    uid: string;
    text: string;
  }) => Promise<AgentRun[]>;
  invoking: boolean;
  error: string | null;
} {
  const queryClient = useQueryClient();
  const [error, setError] = React.useState<string | null>(null);
  const mutation = useMutation<AgentRun[], Error, Parameters<typeof invokeMany>[0]>({
    mutationFn: invokeMany,
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: [...AGENTS_QUERY_KEY, "by-message"] });
    },
    onError: (err) => setError(toMessage(err)),
  });
  return {
    invoke: (input) => mutation.mutateAsync(input),
    invoking: mutation.isPending,
    error,
  };
}

async function invokeMany(input: {
  agents: { connectionId: string; handle: string }[];
  workspaceId: string;
  chatId: string;
  messageId: string;
  uid: string;
  text: string;
}): Promise<AgentRun[]> {
  const out: AgentRun[] = [];
  for (const agent of input.agents) {
    // Instrucción sin la mención; si queda vacía se manda el texto tal cual
    // (el despacho valida) para no perder la intención.
    const token = `@${agent.handle}`;
    const at = input.text.indexOf(token);
    const instruction = at === -1
      ? input.text.trim()
      : `${input.text.slice(0, at)}${input.text.slice(at + token.length)}`.replace(/\s+/g, " ").trim();
    const run = await startAgentTask({
      connectionId: agent.connectionId,
      workspaceId: input.workspaceId,
      chatId: input.chatId,
      messageId: input.messageId,
      uid: input.uid,
      instruction: instruction === "" ? input.text.trim() : instruction,
    });
    out.push(run);
  }
  return out;
}

/** Uso de hoy por agente/espacio/usuario (límites visibles en Uso de IA). */
export function useAgentUsageToday(
  workspaceId: string | null,
): UseQueryResult<{ connectionId: string; requestedBy: string | null }[], Error> {
  return useQuery({
    queryKey: [...AGENTS_QUERY_KEY, "usage-today", workspaceId],
    queryFn: () => getAgentUsageToday(workspaceId ?? ""),
    enabled: workspaceId !== null && workspaceId !== "",
    staleTime: 30_000,
    retry: false,
  });
}

/** Continúa un needs_input con la respuesta del hilo. */
export function useContinueAgentRun(): {
  cont: (runId: string, text: string) => Promise<boolean>;
  continuing: boolean;
} {
  const [continuing, setContinuing] = React.useState(false);
  return {
    continuing,
    cont: async (runId, text) => {
      setContinuing(true);
      try {
        return await continueAgentRun(runId, text);
      } finally {
        setContinuing(false);
      }
    },
  };
}
