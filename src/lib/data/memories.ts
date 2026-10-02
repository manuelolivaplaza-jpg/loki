"use client";

/**
 * Memoria del espacio sobre Supabase (`space_memories`), capa de datos.
 *
 * Por eventos, nada escuchando 24/7: la lista se pinta con una query y se
 * refresca por Realtime solo mientras la pantalla está montada (hook
 * `useMemories`, que desuscribe al salir). La búsqueda va por la RPC
 * `search_space_memories` (full-text en español, SQL barato, sin IA) y es la
 * misma que usa la Edge `loki-chat` para el recall.
 *
 * Nunca hay escritura con la `service_role`: todo va con el JWT del usuario y
 * lo decide la RLS (miembros leen, cada uno crea lo suyo, edita/borrarlo quien
 * lo guardó o un admin). Un recuerdo tomado de un DM nace `privado`: la base
 * lo fuerza con el trigger `space_memories_guard_source` salvo que quien lo
 * guarda marque `shareConfirmed`.
 */

import { Timestamp } from "@/lib/timestamp";
import { getSupabaseClient } from "@/lib/supabase/client";
import { cleanMemoryContent, normalizeMemoryCategory, normalizeMemoryVisibility } from "@/lib/memory/memory";
import type { Database } from "@/types/supabase";
import type {
  MemoryItem,
  MemorySearchHit,
  MemoryVisibility,
  NewMemoryInput,
  UpdateMemoryPatch,
} from "@/types/organizer";

type Row = Database["public"]["Tables"]["space_memories"]["Row"];

export type Unsubscribe = () => void;

// Literal (no concatenado) para que `select()` siga inferiendo `SpaceMemoryRow`.
const COLUMNS =
  "id, workspace_id, content, category, sensitive, pinned, visibility, source_message_id, share_confirmed, created_by, expires_at, created_at, updated_at";

function toTimestamp(iso: string): Timestamp {
  const date = new Date(iso);
  return Timestamp.fromDate(Number.isNaN(date.getTime()) ? new Date() : date);
}

function toTimestampOrNull(iso: string | null): Timestamp | null {
  if (iso === null) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : Timestamp.fromDate(date);
}

function toMemory(row: Row): MemoryItem {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    content: row.content,
    category: normalizeMemoryCategory(row.category),
    sensitive: row.sensitive,
    pinned: row.pinned,
    visibility: normalizeMemoryVisibility(row.visibility),
    sourceMessageId: row.source_message_id,
    shareConfirmed: row.share_confirmed,
    createdBy: row.created_by,
    expiresAt: toTimestampOrNull(row.expires_at),
    createdAt: toTimestamp(row.created_at),
    updatedAt: toTimestamp(row.updated_at),
  };
}

// --- Errores -------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Traduce el error de Postgres a español. La RLS denegada es `42501` y el
 * CHECK de la tabla `P0001`: en ambos casos el mensaje propio es más claro.
 */
function memoryError(error: unknown, fallback: string): Error {
  if (isRecord(error) && typeof error["code"] === "string") {
    if (error["code"] === "42501") {
      return new Error("No tienes permiso para eso en este espacio.");
    }
    if (error["code"] === "P0002") {
      return new Error("Ese recuerdo ya no existe.");
    }
  }
  return new Error(fallback);
}

// --- Lectura -------------------------------------------------------------------

/**
 * Recuerdos del espacio: los fijados y los más recientes primero, sin los que
 * ya caducaron. Los privados de otra persona no llegan (la RLS los esconde).
 */
export async function listMemories(wsId: string): Promise<MemoryItem[]> {
  if (wsId === "") return [];
  const { data, error } = await getSupabaseClient()
    .from("space_memories")
    .select(COLUMNS)
    .eq("workspace_id", wsId)
    .order("pinned", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(300);
  if (error !== null) {
    throw memoryError(error, "No se pudieron cargar los recuerdos.");
  }
  // Lo caducado deja de ofrecerse. El filtro va aquí (y no como `or()` de
  // PostgREST) porque así el tipado de la fila sigue siendo `SpaceMemoryRow`.
  const now = Date.now();
  return ((data ?? []) as Row[])
    .filter((row) => row.expires_at === null || new Date(row.expires_at).getTime() > now)
    .map(toMemory);
}

/**
 * Búsqueda de recuerdos en el espacio (RPC `search_space_memories`): la misma
 * que usa Loki, sin coste de IA. Menos de 2 letras no llama al servidor.
 */
export async function searchMemories(
  wsId: string,
  query: string,
  limit = 20,
): Promise<MemorySearchHit[]> {
  const q = query.trim();
  if (wsId === "" || q.length < 2) return [];
  const { data, error } = await getSupabaseClient().rpc("search_space_memories", {
    p_ws: wsId,
    p_query: q,
    p_limit: limit,
  });
  if (error !== null) {
    throw memoryError(error, "No se pudo buscar en la memoria.");
  }
  return parseMemoryHits(data);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Traduce el jsonb de `search_space_memories` al tipo de la UI. */
export function parseMemoryHits(raw: unknown): MemorySearchHit[] {
  if (!Array.isArray(raw)) return [];
  const out: MemorySearchHit[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = text(entry["id"]);
    if (id === "") continue;
    out.push({
      id,
      content: text(entry["content"]),
      category: normalizeMemoryCategory(text(entry["category"])),
      sensitive: entry["sensitive"] === true,
      pinned: entry["pinned"] === true,
      visibility: normalizeMemoryVisibility(text(entry["visibility"])),
      expiresAt: textOrNull(entry["expires_at"]),
      createdAt: text(entry["created_at"]),
      authorName: text(entry["author_name"]) === "" ? "Alguien" : text(entry["author_name"]),
    });
  }
  return out;
}

// --- Escritura -----------------------------------------------------------------

/**
 * Guarda un recuerdo a nombre propio (RLS). `sourceMessageId` ata el recuerdo al
 * mensaje del que salió: si ese mensaje era de un DM, la base lo deja en
 * `privado` salvo que venga `shareConfirmed`.
 */
export async function createMemory(
  wsId: string,
  uid: string,
  input: NewMemoryInput,
): Promise<string> {
  if (wsId === "") throw new Error("Falta el espacio.");
  if (uid === "") throw new Error("Inicia sesión para guardar un recuerdo.");
  const content = cleanMemoryContent(input.content);
  if (content === null) throw new Error("Escribe el recuerdo primero.");
  const { data, error } = await getSupabaseClient()
    .from("space_memories")
    .insert({
      workspace_id: wsId,
      content,
      category: input.category ?? "otros",
      sensitive: input.sensitive ?? false,
      pinned: input.pinned ?? false,
      visibility: input.visibility ?? "espacio",
      source_message_id: input.sourceMessageId ?? null,
      share_confirmed: input.shareConfirmed ?? false,
      expires_at: input.expiresAt?.toISOString() ?? null,
      created_by: uid,
    })
    .select("id")
    .single();
  if (error !== null || data === null) {
    throw memoryError(error, "No se pudo guardar el recuerdo.");
  }
  return (data as { id: string }).id;
}

/**
 * Edita un recuerdo (solo quien lo guardó o un admin). Pasar
 * `shareConfirmed: true` es la confirmación explícita para compartir con el
 * espacio lo que salió de un DM.
 */
export async function updateMemory(
  id: string,
  patch: UpdateMemoryPatch,
): Promise<void> {
  const data: Database["public"]["Tables"]["space_memories"]["Update"] = {};
  if (patch.content !== undefined) {
    const content = cleanMemoryContent(patch.content);
    if (content === null) throw new Error("El recuerdo no puede quedar vacío.");
    data["content"] = content;
  }
  if (patch.category !== undefined) data["category"] = patch.category;
  if (patch.sensitive !== undefined) data["sensitive"] = patch.sensitive;
  if (patch.pinned !== undefined) data["pinned"] = patch.pinned;
  if (patch.visibility !== undefined) data["visibility"] = patch.visibility;
  if (patch.shareConfirmed !== undefined) data["share_confirmed"] = patch.shareConfirmed;
  if (patch.expiresAt !== undefined) data["expires_at"] = patch.expiresAt?.toISOString() ?? null;
  if (Object.keys(data).length === 0) return;
  const { error } = await getSupabaseClient().from("space_memories").update(data).eq("id", id);
  if (error !== null) {
    throw memoryError(error, "No se pudo guardar el recuerdo.");
  }
}

/** Borra un recuerdo (quien lo guardó o un admin). */
export async function deleteMemory(id: string): Promise<void> {
  const { error } = await getSupabaseClient().from("space_memories").delete().eq("id", id);
  if (error !== null) {
    throw memoryError(error, "No se pudo borrar el recuerdo.");
  }
}

/** Fija o desfija un recuerdo (el mismo permiso que editarlo). */
export async function setMemoryPinned(id: string, pinned: boolean): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("space_memories")
    .update({ pinned })
    .eq("id", id);
  if (error !== null) {
    throw memoryError(error, "No se pudo fijar el recuerdo.");
  }
}

/**
 * Comparte con el espacio un recuerdo que estaba en privado: además de poner
 * `visibility`, manda `share_confirmed` (es la confirmación explícita que la
 * base exige cuando el recuerdo viene de un DM).
 */
export async function shareMemory(id: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("space_memories")
    .update({ visibility: "espacio", share_confirmed: true })
    .eq("id", id);
  if (error !== null) {
    throw memoryError(error, "No se pudo compartir el recuerdo.");
  }
}

// --- Realtime ------------------------------------------------------------------

/**
 * Recuerdos del espacio en vivo: una query inicial y un repintado por cada
 * cambio de la tabla. Se desuscribe al desmontar (nada queda consultando).
 */
export function listenMemories(
  wsId: string,
  cb: (memories: MemoryItem[]) => void,
): Unsubscribe {
  if (wsId === "") return () => undefined;
  const supabase = getSupabaseClient();
  const reload = (): void => {
    void listMemories(wsId).then(cb).catch(() => undefined);
  };
  const channel = supabase.channel(`loki:memories:${wsId}`);
  channel.on(
    "postgres_changes",
    { event: "*", schema: "public", table: "space_memories", filter: `workspace_id=eq.${wsId}` },
    reload,
  );
  channel.subscribe();
  reload();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    void supabase.removeChannel(channel);
  };
}

// --- Utilidades para la UI ------------------------------------------------------

/** Categoría válida o "otros" (lo usan las capas que no dependen de la UI). */
export { normalizeMemoryCategory, normalizeMemoryVisibility };

/** Etiqueta corta de visibilidad, para el subtítulo de la fila. */
export function memoryVisibilityLabel(visibility: MemoryVisibility): string {
  return visibility === "privado" ? "Solo yo" : "Todo el espacio";
}