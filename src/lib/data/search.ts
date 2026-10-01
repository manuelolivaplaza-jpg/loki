"use client";

/**
 * Búsqueda global (paleta Cmd/Ctrl+K) sobre la RPC `global_search`.
 *
 * Una sola llamada trae 5 grupos (mensajes, tareas, proyectos, eventos y
 * personas) ya limitados a 8 por grupo en el servidor. Además guarda los
 * últimos destinos abiertos en `localStorage` (recientes) y ofrece
 * `highlight` para resaltar coincidencias con `<mark>`.
 */

import { getSupabaseClient } from "@/lib/supabase/client";

export type SearchMessageHit = {
  id: string;
  chatId: string;
  chatName: string;
  authorName: string;
  text: string;
  createdAt: string;
};

export type SearchTaskHit = {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  status: string;
};

export type SearchProjectHit = {
  id: string;
  name: string;
  emoji: string;
};

export type SearchEventHit = {
  id: string;
  title: string;
  startsAt: string;
};

export type SearchPersonHit = {
  userId: string;
  displayName: string;
  role: string;
};

export type SearchTranscriptionHit = {
  id: string;
  /** Mensaje con la nota de voz (null si fue un dictado suelto). */
  messageId: string | null;
  chatId: string | null;
  authorName: string;
  text: string;
  createdAt: string;
};

export type SearchResults = {
  messages: SearchMessageHit[];
  tasks: SearchTaskHit[];
  projects: SearchProjectHit[];
  events: SearchEventHit[];
  people: SearchPersonHit[];
  /** Texto dictado de las notas de voz (bajo demanda, indexado). */
  transcriptions: SearchTranscriptionHit[];
};

export const EMPTY_RESULTS: SearchResults = {
  messages: [],
  tasks: [],
  projects: [],
  events: [],
  people: [],
  transcriptions: [],
};

// --- Parseo del jsonb (defensivo: la RPC siempre devuelve el objeto con
// --- los 5 grupos, pero si algo cambia de forma no se rompe la paleta).

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseGroup<T>(
  value: unknown,
  map: (item: Record<string, unknown>) => T | null,
): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const hit = map(entry);
    if (hit !== null) out.push(hit);
  }
  return out;
}

function parseMessage(item: Record<string, unknown>): SearchMessageHit | null {
  const id = asString(item["id"]);
  const chatId = asString(item["chat_id"]);
  if (id === null || chatId === null) return null;
  return {
    id,
    chatId,
    chatName: asString(item["chat_name"]) ?? "Chat",
    authorName: asString(item["author_name"]) ?? "",
    text: asString(item["text"]) ?? "",
    createdAt: asString(item["created_at"]) ?? "",
  };
}

function parseTask(item: Record<string, unknown>): SearchTaskHit | null {
  const id = asString(item["id"]);
  const projectId = asString(item["project_id"]);
  if (id === null || projectId === null) return null;
  return {
    id,
    projectId,
    projectName: asString(item["project_name"]) ?? "",
    title: asString(item["title"]) ?? "",
    status: asString(item["status"]) ?? "",
  };
}

function parseProject(item: Record<string, unknown>): SearchProjectHit | null {
  const id = asString(item["id"]);
  if (id === null) return null;
  return {
    id,
    name: asString(item["name"]) ?? "",
    emoji: asString(item["emoji"]) ?? "📁",
  };
}

function parseEvent(item: Record<string, unknown>): SearchEventHit | null {
  const id = asString(item["id"]);
  if (id === null) return null;
  return {
    id,
    title: asString(item["title"]) ?? "",
    startsAt: asString(item["starts_at"]) ?? "",
  };
}

function parsePerson(item: Record<string, unknown>): SearchPersonHit | null {
  const userId = asString(item["user_id"]);
  if (userId === null) return null;
  return {
    userId,
    displayName: asString(item["display_name"]) ?? "Miembro",
    role: asString(item["role"]) ?? "member",
  };
}

function parseTranscription(item: Record<string, unknown>): SearchTranscriptionHit | null {
  const id = asString(item["id"]);
  if (id === null) return null;
  return {
    id,
    messageId: asString(item["message_id"]),
    chatId: asString(item["chat_id"]),
    authorName: asString(item["author_name"]) ?? "",
    text: asString(item["text"]) ?? "",
    createdAt: asString(item["created_at"]) ?? "",
  };
}

/**
 * Busca en todo el espacio con la RPC `global_search`. Con menos de 2
 * letras devuelve vacío sin llamar al servidor (igual que la función).
 */
export async function searchAll(wsId: string, q: string): Promise<SearchResults> {
  const query = q.trim();
  if (wsId === "" || query.length < 2) return EMPTY_RESULTS;
  const { data, error } = await getSupabaseClient().rpc("global_search", {
    p_ws: wsId,
    p_q: query,
  });
  if (error !== null) {
    throw new Error("No se pudo buscar. Inténtalo de nuevo.");
  }
  if (!isRecord(data)) return EMPTY_RESULTS;
  return {
    messages: parseGroup(data["messages"], parseMessage),
    tasks: parseGroup(data["tasks"], parseTask),
    projects: parseGroup(data["projects"], parseProject),
    events: parseGroup(data["events"], parseEvent),
    people: parseGroup(data["people"], parsePerson),
    transcriptions: parseGroup(data["transcriptions"], parseTranscription),
  };
}

// --- Recientes (últimos 8 destinos abiertos desde la paleta) ------------------

export type RecentKind = "message" | "task" | "project" | "event" | "action";

export type RecentItem = {
  kind: RecentKind;
  title: string;
  subtitle: string;
  href: string;
};

const MAX_RECENTS = 8;

function recentsKey(wsId: string): string {
  return `loki:search:recents:${wsId}`;
}

function isRecentItem(value: unknown): value is RecentItem {
  if (!isRecord(value)) return false;
  return (
    typeof value["kind"] === "string" &&
    typeof value["title"] === "string" &&
    typeof value["subtitle"] === "string" &&
    typeof value["href"] === "string"
  );
}

/** Últimos destinos abiertos en este espacio (vacío si no hay). */
export function getRecents(wsId: string): RecentItem[] {
  if (wsId === "" || typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(recentsKey(wsId));
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentItem).slice(0, MAX_RECENTS);
  } catch {
    return [];
  }
}

/**
 * Guarda un destino al frente de los recientes (sin duplicar `href`,
 * tope 8) y devuelve la lista actualizada para repintar.
 */
export function pushRecent(wsId: string, item: RecentItem): RecentItem[] {
  const next = [
    item,
    ...getRecents(wsId).filter((recent) => recent.href !== item.href),
  ].slice(0, MAX_RECENTS);
  if (wsId !== "" && typeof window !== "undefined") {
    try {
      window.localStorage.setItem(recentsKey(wsId), JSON.stringify(next));
    } catch {
      // Sin almacenamiento (modo privado): la paleta sigue funcionando.
    }
  }
  return next;
}

// --- Resaltado (partes para `<mark>`, sin tildes ni mayúsculas) ---------------

export type HighlightPart = {
  text: string;
  hit: boolean;
};

/** Normaliza una letra para comparar (minúsculas y sin diacríticos). */
function normalizeChar(char: string): string {
  return char
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

/**
 * Divide `text` en partes marcando las coincidencias de `query`
 * (insensible a mayúsculas y tildes, ocurrencias no solapadas).
 */
export function highlight(query: string, text: string): HighlightPart[] {
  const none: HighlightPart[] = [{ text, hit: false }];
  if (text === "") return none;
  const needle = [...query.trim()].map(normalizeChar).join("");
  if (needle === "") return none;

  // Texto normalizado + mapa de cada unidad UTF-16 normalizada a su
  // desplazamiento en el original (para recortar sin romper emojis y
  // coincidir con los offsets de `indexOf`).
  const normUnits: string[] = [];
  const indexMap: number[] = [];
  let offset = 0;
  for (const char of Array.from(text)) {
    const norm = normalizeChar(char);
    for (let k = 0; k < norm.length; k += 1) {
      normUnits.push(norm[k] as string);
      indexMap.push(offset);
    }
    offset += char.length;
  }
  const norm = normUnits.join("");
  if (norm === "" || needle.length === 0) return none;

  const ranges: { start: number; end: number }[] = [];
  let from = 0;
  while (from <= normUnits.length - needle.length) {
    const found = norm.indexOf(needle, from);
    if (found === -1) break;
    const start = indexMap[found] ?? 0;
    const end = indexMap[found + needle.length] ?? text.length;
    ranges.push({ start, end });
    from = found + needle.length;
  }
  if (ranges.length === 0) return none;

  const parts: HighlightPart[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      parts.push({ text: text.slice(cursor, range.start), hit: false });
    }
    parts.push({ text: text.slice(range.start, range.end), hit: true });
    cursor = range.end;
  }
  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), hit: false });
  }
  return parts;
}
