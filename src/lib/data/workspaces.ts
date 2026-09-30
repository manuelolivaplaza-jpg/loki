"use client";

/**
 * Espacios de trabajo sobre Supabase (T20).
 *
 * Sustituye a `workspaces/{wsId}` + el índice espejo `users/{uid}/memberships`
 * de Firestore. El listado sale de `workspace_members` con el espacio
 * embebido, y el alta pasa por la RPC `create_workspace`, que en una sola
 * transacción crea el espacio, la fila de owner, los chats `general` y
 * `posts`, y deja el espacio como actual del perfil.
 *
 * La API pública no cambia: `createWorkspace`, `listMyWorkspaces`,
 * `toLocalMembership`, `CreateWorkspaceInput` y `WorkspaceActor`. Así el
 * onboarding, el diálogo de crear espacio y el store siguen sin tocarse.
 */

import { Timestamp } from "@/lib/timestamp";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { WorkspaceMembershipRow } from "@/types/supabase";
import type { WorkspaceKind, WorkspaceMembership } from "@/types/models";

export type CreateWorkspaceInput = {
  name: string;
  emoji: string;
  kind: WorkspaceKind;
};

export type WorkspaceActor = {
  uid: string;
  displayName: string;
  avatarColor: string;
};

/** Columnas del join `workspace_members` + `workspaces`. */
const MEMBERSHIP_SELECT =
  "workspace_id, role, display_name, joined_at, workspaces(id, name, emoji)";

/**
 * `kind` (familia/equipo) no es una columna de `workspaces` en el esquema de
 * T19: es solo la etiqueta que sale bajo el nombre del espacio. Como la RPC no
 * lo persiste, se guarda en localStorage indexado por id de espacio, que es
 * donde el picker de T8 lo dejaba antes de que Postgres sustituyera a
 * Firestore. Si en T21 la columna entra en el esquema, esto desaparece.
 */
const KIND_STORAGE_KEY = "loki.workspace-kinds";

function readKinds(): Record<string, WorkspaceKind> {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(KIND_STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, WorkspaceKind> = {};
    for (const [wsId, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === "family" || value === "team") out[wsId] = value;
    }
    return out;
  } catch {
    // localStorage puede estar bloqueado o corrupto. El tipo solo pinta una
    // etiqueta, así que se sigue con el valor por defecto.
    return {};
  }
}

function rememberKind(wsId: string, kind: WorkspaceKind): void {
  if (typeof window === "undefined") return;
  try {
    const kinds = readKinds();
    if (kinds[wsId] === kind) return;
    kinds[wsId] = kind;
    window.localStorage.setItem(KIND_STORAGE_KEY, JSON.stringify(kinds));
  } catch {
    // Sin persistencia no hay etiqueta, pero el espacio se creó igual.
  }
}

function toMembership(row: WorkspaceMembershipRow): WorkspaceMembership | null {
  const workspace = row.workspaces;
  if (workspace === null) return null;
  return {
    wsId: row.workspace_id,
    name: workspace.name,
    emoji: workspace.emoji,
    kind: readKinds()[row.workspace_id] ?? "family",
    role: row.role as WorkspaceMembership["role"],
    joinedAt: Timestamp.fromDate(new Date(row.joined_at)),
  };
}

function workspaceErrorMessage(error: unknown): string {
  const message =
    typeof error === "object" && error !== null
      ? String((error as { message?: unknown }).message ?? "")
      : "";
  const lower = message.toLowerCase();
  if (lower.includes("nombre del espacio debe tener")) {
    return "El nombre del espacio debe tener entre 1 y 40 caracteres.";
  }
  if (lower.includes("iniciar sesión")) {
    return "Tu sesión expiró. Vuelve a iniciar sesión.";
  }
  if (lower.includes("duplicate key")) {
    return "Ya existe un espacio con ese nombre.";
  }
  return "No se pudo crear tu espacio. Inténtalo de nuevo.";
}

/**
 * Crea el espacio con la RPC `create_workspace` y devuelve su id.
 *
 * El INSERT directo en `workspaces` está denegado por RLS a propósito, así que
 * el alta va entera por la función `security definer`. `actor` se conserva en
 * la firma porque las pantallas ya lo pasan: la RPC toma el `display_name` del
 * perfil, que el onboarding guarda justo antes de llamar.
 */
export async function createWorkspace(
  input: CreateWorkspaceInput,
  actor: WorkspaceActor,
): Promise<string> {
  const name = input.name.trim();
  if (name === "") {
    throw new Error("Ponle un nombre a tu espacio.");
  }
  // La RPC usa `auth.uid()` de la sesión, no el `actor`; se comprueba para
  // avisar antes de gastar el viaje si la sesión ya no está.
  if (actor.uid.trim() === "") {
    throw new Error("Tu sesión expiró. Vuelve a iniciar sesión.");
  }
  const { data, error } = await getSupabaseClient().rpc("create_workspace", {
    p_name: name,
    p_emoji: input.emoji,
  });
  if (error !== null) {
    throw new Error(workspaceErrorMessage(error));
  }
  if (typeof data !== "string" || data === "") {
    throw new Error("No se pudo crear tu espacio. Inténtalo de nuevo.");
  }
  rememberKind(data, input.kind);
  return data;
}

/**
 * Lista los espacios del usuario: sus filas de `workspace_members` con el
 * espacio embebido. La RLS deja ver esas filas porque el propio usuario es
 * miembro de cada una.
 */
export async function listMyWorkspaces(
  uid: string,
): Promise<WorkspaceMembership[]> {
  const { data, error } = await getSupabaseClient()
    .from("workspace_members")
    .select(MEMBERSHIP_SELECT)
    .eq("user_id", uid)
    .order("joined_at", { ascending: true });
  if (error !== null) {
    throw new Error("No se pudieron cargar tus espacios. Inténtalo de nuevo.");
  }
  const rows = (data ?? []) as WorkspaceMembershipRow[];
  return rows
    .map(toMembership)
    .filter((item): item is WorkspaceMembership => item !== null);
}

/**
 * Entrada optimista para la caché local tras crear un espacio.
 * La RPC ya terminó (`await`): úsala con
 * `queryClient.setQueryData(["workspaces", uid], ...)` antes de navegar
 * para que los selectores muestren el espacio nuevo sin esperar al refetch.
 */
export function toLocalMembership(
  wsId: string,
  input: CreateWorkspaceInput,
): WorkspaceMembership {
  return {
    wsId,
    name: input.name.trim(),
    emoji: input.emoji,
    kind: input.kind,
    role: "owner",
    joinedAt: Timestamp.now(),
  };
}
