"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { create } from "zustand";
import { listMyWorkspaces } from "@/lib/data/workspaces";
import { updateUserProfile } from "@/lib/data/users";
import { useProfileStore } from "@/stores/profile-store";
import { useSessionStore } from "@/stores/session-store";
import type { WorkspaceMembership } from "@/types/models";

type WorkspaceStoreState = {
  workspaces: WorkspaceMembership[];
  currentWorkspaceId: string | null;
  setWorkspaces: (workspaces: WorkspaceMembership[]) => void;
  setCurrentWorkspaceId: (wsId: string | null) => void;
  setCurrent: (uid: string, wsId: string) => Promise<void>;
  clearWorkspaces: () => void;
};

export const useWorkspaceStore = create<WorkspaceStoreState>()((set) => ({
  workspaces: [],
  currentWorkspaceId: null,
  setWorkspaces: (workspaces) => set({ workspaces }),
  setCurrentWorkspaceId: (currentWorkspaceId) => set({ currentWorkspaceId }),
  setCurrent: async (uid, wsId) => {
    await updateUserProfile(uid, { currentWorkspaceId: wsId });
    set({ currentWorkspaceId: wsId });
    const profile = useProfileStore.getState().profile;
    if (profile !== null && profile.uid === uid) {
      useProfileStore.getState().setProfile({ ...profile, currentWorkspaceId: wsId });
    }
  },
  clearWorkspaces: () => set({ workspaces: [], currentWorkspaceId: null }),
}));

export type UseWorkspacesResult = {
  workspaces: WorkspaceMembership[];
  currentWorkspaceId: string | null;
  currentWorkspace: WorkspaceMembership | null;
  isLoading: boolean;
  isError: boolean;
};

/** Carga los espacios del usuario desde users/{uid}/memberships con TanStack Query. */
export function useWorkspaces(): UseWorkspacesResult {
  const user = useSessionStore((state) => state.user);
  const profile = useProfileStore((state) => state.profile);
  const uid = user?.uid ?? null;
  const stored = useWorkspaceStore((state) => state.workspaces);
  const currentWorkspaceId = useWorkspaceStore((state) => state.currentWorkspaceId);
  const setWorkspaces = useWorkspaceStore((state) => state.setWorkspaces);
  const setCurrentWorkspaceId = useWorkspaceStore((state) => state.setCurrentWorkspaceId);

  const query = useQuery({
    queryKey: ["workspaces", uid],
    queryFn: () => listMyWorkspaces(uid as string),
    enabled: uid !== null,
    // Una sola carga por sesión: el WorkspaceBootstrap del shell mantiene la
    // suscripción viva y las mutaciones invalidan explícitamente la clave.
    staleTime: Infinity,
  });

  const data = query.data ?? stored;

  React.useEffect(() => {
    if (query.data !== undefined) {
      setWorkspaces(query.data);
    }
  }, [query.data, setWorkspaces]);

  // Si la consulta resolvió vacía (p. ej. corrió antes de que terminara el
  // batch de createWorkspace) pero el perfil ya apunta a un espacio, la
  // lista cacheada está obsoleta: se reintenta una vez en vez de
  // conservar el vacío para siempre con staleTime Infinity.
  const profileWorkspaceId = profile?.currentWorkspaceId ?? null;
  const retriedKey = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (
      query.data !== undefined &&
      query.data.length === 0 &&
      profileWorkspaceId !== null &&
      uid !== null &&
      !query.isFetching
    ) {
      const key = `${uid}:${profileWorkspaceId}`;
      if (retriedKey.current !== key) {
        retriedKey.current = key;
        void query.refetch();
      }
    }
  }, [query, uid, profileWorkspaceId]);

  React.useEffect(() => {
    if (currentWorkspaceId !== null || data.length === 0) {
      return;
    }
    const fromProfile = profile?.currentWorkspaceId ?? null;
    if (fromProfile !== null && data.some((item) => item.wsId === fromProfile)) {
      setCurrentWorkspaceId(fromProfile);
      return;
    }
    const first = data[0];
    if (first !== undefined) {
      setCurrentWorkspaceId(first.wsId);
    }
  }, [currentWorkspaceId, data, profile?.currentWorkspaceId, setCurrentWorkspaceId]);

  const currentWorkspace =
    data.find((item) => item.wsId === currentWorkspaceId) ?? null;

  return {
    workspaces: data,
    currentWorkspaceId,
    currentWorkspace,
    isLoading: query.isLoading,
    isError: query.isError,
  };
}
