"use client";

/**
 * Hooks del organizador (calendario, proyectos, notificaciones, invitaciones)
 * sobre TanStack Query. La API es la única que tocan las pantallas; cada
 * mutación invalida su clave para refrescar.
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
  createEvent,
  deleteEvent,
  listEvents,
  occurrencesIn,
  updateEvent,
  type CreateEventInput,
  type UpdateEventPatch,
} from "@/lib/data/events";
import {
  convertIdeaToTask,
  createIdea,
  createProject,
  createTask,
  deleteIdea,
  deleteProject,
  deleteTask,
  listIdeas,
  listProjects,
  listTasks,
  listWorkspaceTasks,
  updateProject,
  updateTask,
  type CreateTaskInput,
} from "@/lib/data/projects";
import {
  getNotificationPrefs,
  listNotifications,
  listenNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  saveNotificationPrefs,
  unreadNotificationsCount,
} from "@/lib/data/notifications";
import {
  acceptInvite,
  createInvite,
  deleteInvite,
  listInvites,
  removeMember,
  revokeInvite,
  setMemberRole,
  type AcceptInviteResult,
  type ExpiryOption,
} from "@/lib/data/invites";
import type {
  EventItem,
  EventOccurrence,
  IdeaItem,
  InviteItem,
  NotificationItem,
  NotificationPrefs,
  ProjectItem,
  TaskItem,
} from "@/types/organizer";

// --- Eventos -------------------------------------------------------------------

export function useEvents(
  wsId: string | null,
  fromISO: string | null,
  toISO: string | null,
): UseQueryResult<EventItem[], Error> {
  return useQuery<EventItem[], Error>({
    queryKey: ["events", wsId, fromISO, toISO],
    queryFn: () => listEvents(wsId ?? "", fromISO ?? "", toISO ?? ""),
    enabled: wsId !== null && fromISO !== null && toISO !== null,
  });
}

/** Ocurrencias (con recurrentes) ordenadas por inicio. */
export function useEventOccurrences(
  wsId: string | null,
  from: Date | null,
  to: Date | null,
): {
  occurrences: EventOccurrence[];
  isPending: boolean;
  error: Error | null;
  retry: () => void;
} {
  const fromISO = from?.toISOString() ?? null;
  const toISO = to?.toISOString() ?? null;
  const query = useEvents(wsId, fromISO, toISO);
  const occurrences = React.useMemo(() => {
    if (from === null || to === null) return [];
    return occurrencesIn(query.data ?? [], from, to);
  }, [query.data, from, to]);
  return {
    occurrences,
    isPending: query.isPending,
    error: query.error,
    retry: () => {
      void query.refetch();
    },
  };
}

function useInvalidateKeys() {
  const queryClient = useQueryClient();
  return React.useCallback(
    (keys: readonly unknown[][]) => {
      for (const key of keys) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
    [queryClient],
  );
}

export function useCreateEvent(
  wsId: string | null,
): UseMutationResult<string, Error, { uid: string; input: CreateEventInput }> {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: ({ uid, input }) => {
      if (wsId === null) throw new Error("Falta el espacio.");
      return createEvent(wsId, uid, input);
    },
    onSuccess: () => invalidate([["events"]]),
  });
}

export function useUpdateEvent(): UseMutationResult<void, Error, { id: string; patch: UpdateEventPatch }> {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: ({ id, patch }) => updateEvent(id, patch),
    onSuccess: () => invalidate([["events"]]),
  });
}

export function useDeleteEvent(): UseMutationResult<void, Error, string> {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: (id: string) => deleteEvent(id),
    onSuccess: () => invalidate([["events"]]),
  });
}

// --- Proyectos y tareas ----------------------------------------------------------

export function useProjects(wsId: string | null): UseQueryResult<ProjectItem[], Error> {
  return useQuery<ProjectItem[], Error>({
    queryKey: ["projects", wsId],
    queryFn: () => listProjects(wsId ?? ""),
    enabled: wsId !== null,
  });
}

export function useCreateProject(
  wsId: string | null,
): UseMutationResult<string, Error, { uid: string; name: string; emoji: string; color: string; description: string }> {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: (input) => {
      if (wsId === null) throw new Error("Falta el espacio.");
      return createProject(wsId, input.uid, input);
    },
    onSuccess: () => invalidate([["projects"]]),
  });
}

export function useUpdateProject(): UseMutationResult<
  void,
  Error,
  { id: string; patch: { name?: string; description?: string; emoji?: string; color?: string; status?: ProjectItem["status"]; dueDate?: string | null } }
> {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: ({ id, patch }) => updateProject(id, patch),
    onSuccess: () => invalidate([["projects"]]),
  });
}

export function useDeleteProject(): UseMutationResult<void, Error, string> {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: (id: string) => deleteProject(id),
    onSuccess: () => invalidate([["projects"], ["tasks"]]),
  });
}

export function useTasks(projectId: string | null): UseQueryResult<TaskItem[], Error> {
  return useQuery<TaskItem[], Error>({
    queryKey: ["tasks", projectId],
    queryFn: () => listTasks(projectId ?? ""),
    enabled: projectId !== null,
  });
}

/** Todas las tareas del espacio (para Inicio). */
export function useWorkspaceTasks(wsId: string | null): UseQueryResult<TaskItem[], Error> {
  return useQuery<TaskItem[], Error>({
    queryKey: ["workspace-tasks", wsId],
    queryFn: () => listWorkspaceTasks(wsId ?? ""),
    enabled: wsId !== null,
  });
}

export function useCreateTask(
  projectId: string | null,
  wsId: string | null,
): UseMutationResult<string, Error, { uid: string; input: CreateTaskInput }> {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: ({ uid, input }) => {
      if (projectId === null || wsId === null) throw new Error("Falta el proyecto.");
      return createTask(projectId, wsId, uid, input);
    },
    onSuccess: () => invalidate([["tasks"], ["projects"], ["workspace-tasks"]]),
  });
}

export function useUpdateTask(): UseMutationResult<
  void,
  Error,
  {
    id: string;
    patch: {
      title?: string;
      notes?: string;
      status?: TaskItem["status"];
      priority?: TaskItem["priority"];
      assigneeIds?: string[];
      dueAt?: Date | null;
      reminderAt?: Date | null;
      position?: number;
    };
  }
> {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: ({ id, patch }) => updateTask(id, patch),
    onSuccess: () => invalidate([["tasks"], ["projects"], ["workspace-tasks"]]),
  });
}

export function useDeleteTask(): UseMutationResult<void, Error, string> {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: (id: string) => deleteTask(id),
    onSuccess: () => invalidate([["tasks"], ["projects"], ["workspace-tasks"]]),
  });
}

// --- Ideas -----------------------------------------------------------------------

export function useIdeas(wsId: string | null): UseQueryResult<IdeaItem[], Error> {
  return useQuery<IdeaItem[], Error>({
    queryKey: ["ideas", wsId],
    queryFn: () => listIdeas(wsId ?? ""),
    enabled: wsId !== null,
  });
}

export function useCreateIdea(
  wsId: string | null,
): UseMutationResult<string, Error, { uid: string; title: string; detail: string; tag: string }> {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: (input) => {
      if (wsId === null) throw new Error("Falta el espacio.");
      return createIdea(wsId, input.uid, input);
    },
    onSuccess: () => invalidate([["ideas"]]),
  });
}

export function useDeleteIdea(): UseMutationResult<void, Error, string> {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: (id: string) => deleteIdea(id),
    onSuccess: () => invalidate([["ideas"]]),
  });
}

export function useConvertIdea(): UseMutationResult<
  string,
  Error,
  { idea: IdeaItem; projectId: string; uid: string }
> {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: ({ idea, projectId, uid }) => convertIdeaToTask(idea, projectId, uid),
    onSuccess: () => invalidate([["ideas"], ["tasks"], ["projects"]]),
  });
}

// --- Notificaciones -----------------------------------------------------------------

export function useNotifications(uid: string | null): {
  items: NotificationItem[];
  unread: number;
  isPending: boolean;
  error: Error | null;
  retry: () => void;
} {
  const queryClient = useQueryClient();
  const query = useQuery<NotificationItem[], Error>({
    queryKey: ["notifications", uid],
    queryFn: () => listNotifications(uid ?? ""),
    enabled: uid !== null,
  });
  const [unread, setUnread] = React.useState(0);

  React.useEffect(() => {
    if (uid === null) return;
    let cancelled = false;
    void unreadNotificationsCount(uid).then((count) => {
      if (!cancelled) setUnread(count);
    });
    return () => {
      cancelled = true;
    };
  }, [uid, query.dataUpdatedAt]);

  React.useEffect(() => {
    if (uid === null) return;
    const unsubscribe = listenNotifications(uid, (items) => {
      queryClient.setQueryData<NotificationItem[]>(["notifications", uid], items);
      setUnread(items.filter((item) => item.readAt === null).length);
    });
    return () => {
      unsubscribe();
    };
  }, [uid, queryClient]);

  return {
    items: query.data ?? [],
    unread,
    isPending: query.isPending,
    error: query.error,
    retry: () => {
      void query.refetch();
    },
  };
}

export function useMarkNotificationRead(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}

export function useMarkAllNotificationsRead(): UseMutationResult<void, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (uid: string) => markAllNotificationsRead(uid),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}

export function useNotificationPrefs(uid: string | null): UseQueryResult<NotificationPrefs, Error> {
  return useQuery<NotificationPrefs, Error>({
    queryKey: ["notification-prefs", uid],
    queryFn: () => getNotificationPrefs(uid ?? ""),
    enabled: uid !== null,
    staleTime: Infinity,
  });
}

export function useSaveNotificationPrefs(): UseMutationResult<void, Error, { uid: string; prefs: NotificationPrefs }> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ uid, prefs }) => saveNotificationPrefs(uid, prefs),
    onSuccess: (_data, variables) => {
      queryClient.setQueryData<NotificationPrefs>(
        ["notification-prefs", variables.uid],
        variables.prefs,
      );
    },
  });
}

// --- Invitaciones y miembros ----------------------------------------------------------

export function useInvites(wsId: string | null): UseQueryResult<InviteItem[], Error> {
  return useQuery<InviteItem[], Error>({
    queryKey: ["invites", wsId],
    queryFn: () => listInvites(wsId ?? ""),
    enabled: wsId !== null,
  });
}

export function useCreateInvite(
  wsId: string | null,
): UseMutationResult<InviteItem, Error, { uid: string; role: InviteItem["role"]; expiry: ExpiryOption; maxUses: number | null }> {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: (input) => {
      if (wsId === null) throw new Error("Falta el espacio.");
      return createInvite(wsId, input.uid, input);
    },
    onSuccess: () => invalidate([["invites"]]),
  });
}

export function useRevokeInvite(): UseMutationResult<void, Error, string> {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: (id: string) => revokeInvite(id),
    onSuccess: () => invalidate([["invites"]]),
  });
}

export function useDeleteInvite(): UseMutationResult<void, Error, string> {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: (id: string) => deleteInvite(id),
    onSuccess: () => invalidate([["invites"]]),
  });
}

export function useAcceptInvite(): UseMutationResult<AcceptInviteResult, Error, string> {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => acceptInvite(code),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    },
  });
}

export function useSetMemberRole(): UseMutationResult<void, Error, { wsId: string; uid: string; role: "member" | "admin" }> {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: ({ wsId, uid, role }) => setMemberRole(wsId, uid, role),
    onSuccess: () => invalidate([["members"], ["workspaces"]]),
  });
}

export function useRemoveMember(): UseMutationResult<void, Error, { wsId: string; uid: string }> {
  const invalidate = useInvalidateKeys();
  return useMutation({
    mutationFn: ({ wsId, uid }) => removeMember(wsId, uid),
    onSuccess: () => invalidate([["members"], ["workspaces"]]),
  });
}
