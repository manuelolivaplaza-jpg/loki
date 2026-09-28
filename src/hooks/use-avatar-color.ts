"use client";

import * as React from "react";
import { avatarColorFor } from "@/lib/avatar-color";
import { useProfileStore } from "@/stores/profile-store";
import { useSessionStore } from "@/stores/session-store";

/**
 * Color del avatar de un autor (T16).
 *
 * Los demás salen del hash de su uid (`avatarColorFor`); yo conservo el
 * `avatarColor` elegido en el onboarding si el perfil ya está cargado.
 * Ambos selectores son primitivos, así que las burbujas no se re-renderizan
 * cuando cambia otra parte del perfil o de la sesión.
 */
export function useAuthorAvatarColor(uid: string): string {
  const myUid = useSessionStore((state) => state.user?.uid ?? null);
  const myColor = useProfileStore((state) => state.profile?.avatarColor ?? null);
  return React.useMemo(() => {
    if (myUid !== null && uid === myUid && myColor !== null) return myColor;
    return avatarColorFor(uid);
  }, [uid, myUid, myColor]);
}
