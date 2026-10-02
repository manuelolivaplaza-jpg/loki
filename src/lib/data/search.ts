"use client";

/**
 * Búsqueda global (paleta Cmd/Ctrl+K y pantalla /buscar) sobre la RPC
 * `global_search` + paginado `search_more`.
 *
 * Una sola llamada trae 12 grupos (mensajes, notas de voz, archivos con OCR,
 * listas, ítems, encuestas, ideas, recuerdos no sensibles, tareas, proyectos,
 * eventos y personas) ya limitados en el servidor. Además:
 *   · `parseSearchQuery`: analizador determinista en español (`de: Sofi`,
 *     `en: General`, `solo míos`, `hoy`, `ayer`, `esta semana`,
 *     `la semana pasada`, `este mes`, `el mes pasado`).
 *   · `searchMore`: "ver más" paginado por grupo.
 *   · Recientes en `localStorage` y `highlight` para resaltar con `<mark>`.
 *   · Ajuste de OCR por espacio + estado del worker (sin gastar trabajos).
 */

import { getSupabaseClient } from "@/lib/supabase/client";
import { edgeHeaders } from "@/lib/edge";

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

/** Recuerdo del espacio (los sensibles nunca llegan aquí: la RPC los excluye). */
export type SearchMemoryHit = {
  id: string;
  content: string;
  category: string;
  pinned: boolean;
  authorName: string;
  createdAt: string;
};

/** Lista compartida del espacio. */
export type SearchListHit = {
  id: string;
  title: string;
  emoji: string;
  kind: string;
};

/** Ítem dentro de su lista (lleva la lista para abrirla en su lugar). */
export type SearchListItemHit = {
  id: string;
  listId: string;
  listTitle: string;
  text: string;
  checked: boolean;
};

/** Encuesta del chat (pregunta + estado; los votos no se exponen aquí). */
export type SearchPollHit = {
  id: string;
  messageId: string;
  chatId: string;
  chatName: string;
  question: string;
  kind: string;
  isOpen: boolean;
  createdAt: string;
};

/** Idea del espacio. */
export type SearchIdeaHit = {
  id: string;
  title: string;
  detail: string;
  tag: string;
};

/** Archivo adjunto (nombre + fragmento del OCR, si la imagen ya se leyó). */
export type SearchAttachmentHit = {
  id: string;
  messageId: string;
  chatId: string;
  chatName: string;
  name: string;
  mime: string;
  kind: string;
  authorName: string;
  ocrText: string;
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
  /** Recuerdos del espacio compartidos y no sensibles. */
  memories: SearchMemoryHit[];
  /** Listas compartidas (por título). */
  lists: SearchListHit[];
  /** Ítems dentro de su lista. */
  listItems: SearchListItemHit[];
  /** Encuestas del chat (por pregunta). */
  polls: SearchPollHit[];
  /** Ideas del espacio. */
  ideas: SearchIdeaHit[];
  /** Archivos e imágenes (por nombre + texto OCR). */
  attachments: SearchAttachmentHit[];
};

/** Claves de grupo: las 12 que devuelve la RPC. */
export type SearchGroupKey =
  | "messages"
  | "transcriptions"
  | "attachments"
  | "lists"
  | "list_items"
  | "polls"
  | "ideas"
  | "memories"
  | "tasks"
  | "projects"
  | "events"
  | "people";

export type SearchGroupMap = {
  messages: SearchMessageHit;
  transcriptions: SearchTranscriptionHit;
  attachments: SearchAttachmentHit;
  lists: SearchListHit;
  list_items: SearchListItemHit;
  polls: SearchPollHit;
  ideas: SearchIdeaHit;
  memories: SearchMemoryHit;
  tasks: SearchTaskHit;
  projects: SearchProjectHit;
  events: SearchEventHit;
  people: SearchPersonHit;
};

export const SEARCH_GROUP_KEYS: readonly SearchGroupKey[] = [
  "messages",
  "transcriptions",
  "attachments",
  "lists",
  "list_items",
  "polls",
  "ideas",
  "memories",
  "tasks",
  "projects",
  "events",
  "people",
];

export const EMPTY_RESULTS: SearchResults = {
  messages: [],
  tasks: [],
  projects: [],
  events: [],
  people: [],
  transcriptions: [],
  memories: [],
  lists: [],
  listItems: [],
  polls: [],
  ideas: [],
  attachments: [],
};

// --- Parseo del jsonb (defensivo: si algo cambia de forma no se rompe la UI).

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

function parseMemory(item: Record<string, unknown>): SearchMemoryHit | null {
  const id = asString(item["id"]);
  if (id === null) return null;
  return {
    id,
    content: asString(item["content"]) ?? "",
    category: asString(item["category"]) ?? "otros",
    pinned: item["pinned"] === true,
    authorName: asString(item["author_name"]) ?? "Alguien",
    createdAt: asString(item["created_at"]) ?? "",
  };
}

function parseList(item: Record<string, unknown>): SearchListHit | null {
  const id = asString(item["id"]);
  if (id === null) return null;
  return {
    id,
    title: asString(item["title"]) ?? "",
    emoji: asString(item["emoji"]) ?? "🛒",
    kind: asString(item["kind"]) ?? "checklist",
  };
}

function parseListItem(item: Record<string, unknown>): SearchListItemHit | null {
  const id = asString(item["id"]);
  const listId = asString(item["list_id"]);
  if (id === null || listId === null) return null;
  return {
    id,
    listId,
    listTitle: asString(item["list_title"]) ?? "Lista",
    text: asString(item["text"]) ?? "",
    checked: item["checked"] === true,
  };
}

function parsePoll(item: Record<string, unknown>): SearchPollHit | null {
  const id = asString(item["id"]);
  const messageId = asString(item["message_id"]);
  const chatId = asString(item["chat_id"]);
  if (id === null || messageId === null || chatId === null) return null;
  return {
    id,
    messageId,
    chatId,
    chatName: asString(item["chat_name"]) ?? "Chat",
    question: asString(item["question"]) ?? "",
    kind: asString(item["kind"]) ?? "single",
    isOpen: item["is_open"] !== false,
    createdAt: asString(item["created_at"]) ?? "",
  };
}

function parseIdea(item: Record<string, unknown>): SearchIdeaHit | null {
  const id = asString(item["id"]);
  if (id === null) return null;
  return {
    id,
    title: asString(item["title"]) ?? "",
    detail: asString(item["detail"]) ?? "",
    tag: asString(item["tag"]) ?? "",
  };
}

function parseAttachment(item: Record<string, unknown>): SearchAttachmentHit | null {
  const id = asString(item["id"]);
  const messageId = asString(item["message_id"]);
  const chatId = asString(item["chat_id"]);
  if (id === null || messageId === null || chatId === null) return null;
  return {
    id,
    messageId,
    chatId,
    chatName: asString(item["chat_name"]) ?? "Chat",
    name: asString(item["name"]) ?? "archivo",
    mime: asString(item["mime"]) ?? "",
    kind: asString(item["kind"]) ?? "file",
    authorName: asString(item["author_name"]) ?? "",
    ocrText: asString(item["ocr_text"]) ?? "",
    createdAt: asString(item["created_at"]) ?? "",
  };
}

const GROUP_PARSERS: {
  [K in SearchGroupKey]: (item: Record<string, unknown>) => SearchGroupMap[K] | null;
} = {
  messages: parseMessage,
  transcriptions: parseTranscription,
  attachments: parseAttachment,
  lists: parseList,
  list_items: parseListItem,
  polls: parsePoll,
  ideas: parseIdea,
  memories: parseMemory,
  tasks: parseTask,
  projects: parseProject,
  events: parseEvent,
  people: parsePerson,
};

function parseResults(data: unknown): SearchResults {
  if (!isRecord(data)) return EMPTY_RESULTS;
  return {
    messages: parseGroup(data["messages"], parseMessage),
    tasks: parseGroup(data["tasks"], parseTask),
    projects: parseGroup(data["projects"], parseProject),
    events: parseGroup(data["events"], parseEvent),
    people: parseGroup(data["people"], parsePerson),
    transcriptions: parseGroup(data["transcriptions"], parseTranscription),
    memories: parseGroup(data["memories"], parseMemory),
    lists: parseGroup(data["lists"], parseList),
    listItems: parseGroup(data["list_items"], parseListItem),
    polls: parseGroup(data["polls"], parsePoll),
    ideas: parseGroup(data["ideas"], parseIdea),
    attachments: parseGroup(data["attachments"], parseAttachment),
  };
}

// --- Analizador determinista (español, sin IA) --------------------------------

export type ParsedSearchQuery = {
  /** Texto limpio para el full-text (sin los filtros). */
  text: string;
  /** `de: Sofi` (fragmento del autor). */
  author: string | null;
  /** `en: General` (fragmento del nombre del chat). */
  chat: string | null;
  /** `solo míos`. */
  mine: boolean;
  /** Rango de fechas en ISO (null = sin cota). */
  from: string | null;
  to: string | null;
  /** Etiquetas para mostrar como pastillas activas. */
  labels: string[];
};

function startOfDay(date: Date): Date {
  const out = new Date(date);
  out.setHours(0, 0, 0, 0);
  return out;
}

function endOfDay(date: Date): Date {
  const out = new Date(date);
  out.setHours(23, 59, 59, 999);
  return out;
}

/** Lunes de la semana de `date` (las semanas empiezan el lunes). */
function mondayOf(date: Date): Date {
  const out = startOfDay(date);
  const shift = (out.getDay() + 6) % 7;
  out.setDate(out.getDate() - shift);
  return out;
}

/**
 * Saca `de:`, `en:`, `solo míos` y fechas del texto. Todo insensible a
 * mayúsculas y tildes en las palabras clave (`solo mios` también vale).
 * Lo que queda es lo que se busca.
 */
export function parseSearchQuery(raw: string, now: Date = new Date()): ParsedSearchQuery {
  let rest = ` ${raw} `.replace(/\s+/g, " ");
  let author: string | null = null;
  let chat: string | null = null;

  const takeQuoted = (key: string): string | null => {
    const match = new RegExp(`\\b${key}:\\s*"([^"]{1,60})"`, "i").exec(rest);
    if (match === null) return null;
    rest = rest.replace(match[0], " ");
    return match[1]?.trim() === "" ? null : (match[1]?.trim() ?? null);
  };
  const takeBare = (key: string): string | null => {
    const match = new RegExp(`\\b${key}:\\s*([^\\s"]{1,60})`, "i").exec(rest);
    if (match === null) return null;
    rest = rest.replace(match[0], " ");
    return match[1]?.trim() === "" ? null : (match[1]?.trim() ?? null);
  };

  author = takeQuoted("de") ?? takeBare("de");
  chat = takeQuoted("en") ?? takeBare("en");

  // `solo míos` (con o sin tilde). Un "míos" suelto no filtra: suele ser
  // parte del texto ("los míos").
  let mine = false;
  if (/solo\s+m[ií]os?/i.test(rest)) {
    mine = true;
    rest = rest.replace(/solo\s+m[ií]os?/i, " ");
  }

  let from: string | null = null;
  let to: string | null = null;
  let dateLabel: string | null = null;
  const eat = (needle: string): boolean => {
    const pattern = new RegExp(
      `(?<![a-záéíóúüñ])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-záéíóúüñ])`,
      "i",
    );
    if (!pattern.test(rest)) return false;
    rest = rest.replace(pattern, " ");
    return true;
  };
  if (eat("la semana pasada")) {
    const monday = mondayOf(now);
    monday.setDate(monday.getDate() - 7);
    const sunday = new Date(monday);
    sunday.setDate(sunday.getDate() + 6);
    from = monday.toISOString();
    to = endOfDay(sunday).toISOString();
    dateLabel = "La semana pasada";
  } else if (eat("el mes pasado")) {
    const first = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const last = new Date(now.getFullYear(), now.getMonth(), 0);
    from = startOfDay(first).toISOString();
    to = endOfDay(last).toISOString();
    dateLabel = "El mes pasado";
  } else if (eat("esta semana")) {
    from = mondayOf(now).toISOString();
    dateLabel = "Esta semana";
  } else if (eat("este mes")) {
    from = startOfDay(new Date(now.getFullYear(), now.getMonth(), 1)).toISOString();
    dateLabel = "Este mes";
  } else if (eat("ayer")) {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    from = startOfDay(yesterday).toISOString();
    to = endOfDay(yesterday).toISOString();
    dateLabel = "Ayer";
  } else if (eat("hoy")) {
    from = startOfDay(now).toISOString();
    to = endOfDay(now).toISOString();
    dateLabel = "Hoy";
  }

  const text = rest.replace(/\s+/g, " ").trim();
  const labels: string[] = [];
  if (author !== null) labels.push(`De: ${author}`);
  if (chat !== null) labels.push(`En: ${chat}`);
  if (mine) labels.push("Solo míos");
  if (dateLabel !== null) labels.push(dateLabel);
  return { text, author, chat, mine, from, to, labels };
}

// --- Llamadas -----------------------------------------------------------------

export type SearchOptions = {
  /** Chips de tipo (null = todos los grupos). */
  types?: SearchGroupKey[] | null;
  /** Resultados por grupo (1-20, default 8). */
  limit?: number;
};

/**
 * Busca en todo el espacio con la RPC `global_search`. Con menos de 2
 * letras (tras quitar los filtros) devuelve vacío sin llamar al servidor,
 * igual que la función.
 */
export async function searchAll(
  wsId: string,
  rawQuery: string,
  options: SearchOptions = {},
): Promise<{ results: SearchResults; parsed: ParsedSearchQuery }> {
  const parsed = parseSearchQuery(rawQuery);
  if (wsId === "" || parsed.text.length < 2) {
    return { results: EMPTY_RESULTS, parsed };
  }
  const { data, error } = await getSupabaseClient().rpc("global_search", {
    p_ws: wsId,
    p_q: parsed.text,
    p_types: options.types ?? null,
    p_chat: parsed.chat,
    p_author: parsed.author,
    p_mine: parsed.mine,
    p_from: parsed.from,
    p_to: parsed.to,
    p_limit: options.limit ?? 8,
  });
  if (error !== null) {
    throw new Error("No se pudo buscar. Inténtalo de nuevo.");
  }
  return { results: parseResults(data), parsed };
}

/**
 * "Ver más" de un grupo (`search_more`, con offset). Devuelve solo ese grupo
 * ya parseado.
 */
export async function searchMore<K extends SearchGroupKey>(
  wsId: string,
  group: K,
  rawQuery: string,
  options: SearchOptions & { offset?: number } = {},
): Promise<SearchGroupMap[K][]> {
  const parsed = parseSearchQuery(rawQuery);
  if (wsId === "" || parsed.text.length < 2) return [];
  const { data, error } = await getSupabaseClient().rpc("search_more", {
    p_ws: wsId,
    p_q: parsed.text,
    p_group: group,
    p_limit: options.limit ?? 8,
    p_offset: options.offset ?? 0,
    p_chat: parsed.chat,
    p_author: parsed.author,
    p_mine: parsed.mine,
    p_from: parsed.from,
    p_to: parsed.to,
  });
  if (error !== null) {
    throw new Error("No se pudo cargar más. Inténtalo de nuevo.");
  }
  if (!Array.isArray(data)) return [];
  const parse = GROUP_PARSERS[group] as (
    item: Record<string, unknown>,
  ) => SearchGroupMap[K] | null;
  return parseGroup(data, parse);
}

// --- Preguntar a Loki (bajo demanda, nunca automático) -------------------------

const ASK_MAX_CHARS = 1800;

function clip(value: string, max: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

/**
 * Convierte la búsqueda en una pregunta para Loki con los mejores resultados
 * como contexto (3 por grupo, recortados). Loki responde por su camino normal
 * (cuota del espacio visible en Configuración).
 */
export function buildLokiQuestion(query: string, results: SearchResults): string {
  const lines: string[] = [];
  const push = (label: string, items: string[]): void => {
    for (const item of items.slice(0, 3)) {
      if (lines.join("\n").length + item.length > ASK_MAX_CHARS) return;
      lines.push(`- ${label}: ${item}`);
    }
  };
  push(
    "mensaje",
    results.messages.map((hit) =>
      clip(`${hit.authorName} en ${hit.chatName}: «${hit.text}»`, 140),
    ),
  );
  push(
    "nota de voz",
    results.transcriptions.map((hit) => clip(`${hit.authorName}: «${hit.text}»`, 140)),
  );
  push(
    "archivo",
    results.attachments.map((hit) =>
      clip(`${hit.name}${hit.ocrText === "" ? "" : ` (dice: «${hit.ocrText}»)`} en ${hit.chatName}`, 140),
    ),
  );
  push(
    "lista",
    results.lists.map((hit) => clip(`«${hit.title}»`, 80)),
  );
  push(
    "ítem",
    results.listItems.map((hit) => clip(`«${hit.text}» en ${hit.listTitle}`, 100)),
  );
  push(
    "encuesta",
    results.polls.map((hit) => clip(`«${hit.question}» en ${hit.chatName}`, 100)),
  );
  push(
    "idea",
    results.ideas.map((hit) => clip(`«${hit.title}»`, 100)),
  );
  push(
    "recuerdo",
    results.memories.map((hit) => clip(`«${hit.content}»`, 120)),
  );
  push(
    "tarea",
    results.tasks.map((hit) => clip(`«${hit.title}» en ${hit.projectName}`, 100)),
  );
  push(
    "evento",
    results.events.map((hit) => clip(`«${hit.title}»`, 100)),
  );
  const context = lines.length === 0
    ? "Sin resultados en el espacio."
    : lines.join("\n").slice(0, ASK_MAX_CHARS);
  return (
    `Sobre mi búsqueda «${clip(query.trim(), 120)}» en este espacio encontré esto:\n` +
    `${context}\n` +
    `Respóndeme en español usando SOLO estos resultados como contexto, ` +
    `diciendo dónde está cada cosa. Si algo no está, dilo.`
  );
}

// --- Recientes (últimos 8 destinos abiertos desde la búsqueda) ----------------

export type RecentKind =
  | "message"
  | "task"
  | "project"
  | "event"
  | "action"
  | "list"
  | "poll"
  | "idea"
  | "attachment"
  | "memory";

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
      // Sin almacenamiento (modo privado): la búsqueda sigue funcionando.
    }
  }
  return next;
}

// --- Sugerencias (atajos de sintaxis + recientes como punto de partida) --------

export const SEARCH_SUGGESTIONS: readonly string[] = [
  "de: ",
  "en: ",
  "solo míos ",
  "la semana pasada ",
  "este mes ",
];

// --- Ajuste de OCR por espacio + estado del worker ------------------------------

export type SearchSettings = {
  ocrEnabled: boolean;
};

/** Lee el ajuste de OCR del espacio (apagado si no hay fila o falla). */
export async function getSearchSettings(wsId: string): Promise<SearchSettings> {
  if (wsId === "") return { ocrEnabled: false };
  const { data } = await getSupabaseClient()
    .from("workspace_search_settings")
    .select("ocr_enabled")
    .eq("workspace_id", wsId)
    .maybeSingle();
  if (data === null || typeof data !== "object") return { ocrEnabled: false };
  return { ocrEnabled: (data as { ocr_enabled: unknown }).ocr_enabled === true };
}

/**
 * Enciende o apaga el OCR del espacio (solo admins: lo exige la RLS).
 * Lanza en español si no hay permiso.
 */
export async function setOcrEnabled(
  wsId: string,
  uid: string,
  enabled: boolean,
): Promise<void> {
  if (wsId === "" || uid === "") throw new Error("Falta el espacio o el usuario.");
  const { error } = await getSupabaseClient()
    .from("workspace_search_settings")
    .upsert(
      { workspace_id: wsId, ocr_enabled: enabled, updated_by: uid },
      { onConflict: "workspace_id" },
    );
  if (error !== null) {
    throw new Error("Solo un administrador puede cambiar este ajuste.");
  }
}

export type OcrHealth = {
  configured: boolean;
  provider: string;
  model: string;
};

const OCR_OFFLINE: OcrHealth = { configured: false, provider: "none", model: "" };

let ocrPromise: Promise<OcrHealth> | null = null;

/**
 * Estado de la visión (GET /health de `loki-worker`). Nunca lanza: sin
 * función servida o sin clave, `configured` es false y la UI muestra
 * "OCR sin configurar" (las imágenes se encuentran por nombre).
 */
export async function getOcrHealth(): Promise<OcrHealth> {
  if (ocrPromise !== null) return ocrPromise;
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  if (base === "") return OCR_OFFLINE;
  ocrPromise = (async () => {
    try {
      const { data } = await getSupabaseClient().auth.getSession();
      const token = data.session?.access_token ?? "";
      const res = await fetch(
        `${base.replace(/\/+$/, "")}/functions/v1/loki-worker`,
        { method: "GET", headers: edgeHeaders(token) },
      );
      if (!res.ok) return OCR_OFFLINE;
      const body: unknown = await res.json();
      if (!isRecord(body)) return OCR_OFFLINE;
      const ocr = body["ocr"];
      if (!isRecord(ocr)) return OCR_OFFLINE;
      return {
        configured: ocr["configured"] === true,
        provider: typeof ocr["provider"] === "string" ? ocr["provider"] : "none",
        model: typeof ocr["model"] === "string" ? ocr["model"] : "",
      };
    } catch {
      return OCR_OFFLINE;
    }
  })();
  return ocrPromise;
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
