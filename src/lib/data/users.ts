"use client";

/**
 * Perfil del usuario sobre Supabase (T20).
 *
 * Sustituye a `users/{uid}` de Firestore. La fila la crea el trigger
 * `on_auth_user_created` de la migración de T19, así que `ensureUserProfile`
 * ya no escribe: lee, y si el trigger aún no ha aterrizado reintenta un par
 * de veces antes de rendirse.
 *
 * La API pública no cambia (`getUserProfile`, `ensureUserProfile`,
 * `updateUserProfile`, `UpdateUserProfilePatch`) para que `AuthGuard`, el
 * onboarding y el store de workspaces sigan igual.
 *
 * Dos campos de `UserProfile` no existen como columnas en Postgres y se
 * derivan aquí, igual que antes los derivaba el documento:
 *   · `avatarInitial` sale de `display_name` (o del correo).
 *   · `onboardingCompleted` es "tengo al menos un espacio": el alta de espacio
 *     es lo que cierra el onboarding, y la RPC ya deja el espacio como actual.
 */

import { Timestamp } from "@/lib/timestamp";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { ProfileTableRow } from "@/types/supabase";
import type { SessionUser } from "@/stores/session-store";
import { getAvatarInitial, type UserProfile } from "@/types/models";

export type UpdateUserProfilePatch = {
  displayName?: string;
  avatarColor?: string;
  avatarInitial?: string;
  onboardingCompleted?: boolean;
  currentWorkspaceId?: string | null;
};

/**
 * `createdAt` / `updatedAt` llegan como ISO de Postgres. Los tipos del modelo
 * (`UserProfile`, `WorkspaceMembership`) siguen declarando el `Timestamp`
 * local (`src/lib/timestamp.ts`, misma superficie que el de Firestore) y los
 * formateadores de la UI llaman a `toDate()`/`toMillis()`. Se envuelve la
 * fecha en ese mismo objeto para no cambiar ni un tipo público.
 */
function toTimestamp(iso: string): UserProfile["createdAt"] {
  const date = new Date(iso);
  return Timestamp.fromDate(Number.isNaN(date.getTime()) ? new Date() : date);
}

function toUserProfile(row: ProfileTableRow): UserProfile {
  const displayName = row.display_name;
  return {
    uid: row.id,
    email: row.email,
    displayName,
    avatarColor: row.avatar_color,
    avatarInitial: getAvatarInitial(displayName, row.email),
    // El onboarding se cierra al crear el primer espacio: la RPC
    // `create_workspace` deja el espacio como actual del perfil en la misma
    // transacción, así que basta con mirar `current_workspace_id`.
    onboardingCompleted: row.current_workspace_id !== null,
    currentWorkspaceId: row.current_workspace_id,
    createdAt: toTimestamp(row.created_at),
    updatedAt: toTimestamp(row.updated_at),
  };
}

/** Reintentos de lectura del perfil recién creado por el trigger. */
const PROFILE_RETRIES = 3;
const PROFILE_RETRY_MS = 250;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getUserProfile(
  uid: string,
): Promise<UserProfile | null> {
  const { data, error } = await getSupabaseClient()
    .from("profiles")
    .select("id, email, display_name, avatar_color, current_workspace_id, theme, created_at, updated_at")
    .eq("id", uid)
    .maybeSingle();
  if (error !== null) {
    throw new Error("No se pudo leer tu perfil. Inténtalo de nuevo.");
  }
  if (data === null) return null;
  return toUserProfile(data);
}

/**
 * Devuelve el perfil del usuario, esperando al trigger si acaba de registrarse.
 * La fila la crea Postgres; el cliente solo la lee.
 */
export async function ensureUserProfile(
  user: SessionUser,
): Promise<UserProfile> {
  for (let attempt = 0; attempt < PROFILE_RETRIES; attempt += 1) {
    const profile = await getUserProfile(user.uid);
    if (profile !== null) return profile;
    if (attempt < PROFILE_RETRIES - 1) {
      await wait(PROFILE_RETRY_MS);
    }
  }
  throw new Error("No se pudo crear tu perfil. Inténtalo de nuevo.");
}

/**
 * Actualiza el perfil. Solo se escriben columnas reales de `profiles`:
 * `avatarInitial` se deriva y `onboardingCompleted` se deduce del espacio
 * actual, así que se aceptan en el parche por compatibilidad y se ignoran.
 */
export async function updateUserProfile(
  uid: string,
  patch: UpdateUserProfilePatch,
): Promise<void> {
  const data: Partial<ProfileTableRow> = {};
  if (patch.displayName !== undefined) {
    data.display_name = patch.displayName;
  }
  if (patch.avatarColor !== undefined) {
    data.avatar_color = patch.avatarColor;
  }
  if (patch.currentWorkspaceId !== undefined) {
    data.current_workspace_id = patch.currentWorkspaceId;
  }
  // Un parche que solo trae campos derivados no necesita ir a la base.
  if (Object.keys(data).length === 0) return;

  const { error } = await getSupabaseClient()
    .from("profiles")
    .update(data)
    .eq("id", uid);
  if (error !== null) {
    throw new Error("No se pudo guardar tu perfil. Inténtalo de nuevo.");
  }
}
