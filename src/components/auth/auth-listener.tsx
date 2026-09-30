"use client";

/**
 * Puente entre Supabase Auth y los stores (T20).
 *
 * `onAuthStateChange` es el equivalente del antiguo `onAuthStateChanged` de
 * Firebase: dispara al montar (INITIAL_SESSION) con la sesión recuperada de
 * localStorage, en cada login/logout y en cada refresco de token. Al no haber
 * sesión también limpia perfil y espacios, que son datos del usuario que se
 * quedaron de la sesión anterior.
 */

import * as React from "react";
import { toSessionUser } from "@/lib/auth/actions";
import { getSupabaseClient } from "@/lib/supabase/client";
import { useProfileStore } from "@/stores/profile-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

export function AuthListener(): React.JSX.Element | null {
  const setUser = useSessionStore((state) => state.setUser);
  const clear = useSessionStore((state) => state.clear);
  const clearProfile = useProfileStore((state) => state.clearProfile);
  const clearWorkspaces = useWorkspaceStore((state) => state.clearWorkspaces);

  React.useEffect(() => {
    let client: ReturnType<typeof getSupabaseClient>;
    try {
      client = getSupabaseClient();
    } catch (error: unknown) {
      // Falta la configuración: se deja la sesión en "unauthenticated" para que
      // el guard mande a /login, donde el error se muestra al intentar entrar.
      console.error(
        error instanceof Error ? error.message : "Supabase no está configurado.",
      );
      clear();
      return;
    }

    const { data } = client.auth.onAuthStateChange((_event, session) => {
      if (session === null) {
        clear();
        clearProfile();
        clearWorkspaces();
        return;
      }
      setUser(toSessionUser(session.user));
    });
    return () => {
      data.subscription.unsubscribe();
    };
  }, [setUser, clear, clearProfile, clearWorkspaces]);

  return null;
}
