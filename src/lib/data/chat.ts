"use client";

/**
 * Chats y mensajes sobre Supabase (T21).
 *
 * Sustituye a Firestore manteniendo la API que consumen `use-chat.ts` y los
 * componentes (`fetchChats`, `listenChats`, `sendMessage`, `toggleReaction`,
 * `markChatRead`, typing, leídos, hilos, posts, chat de IA…). Las filas de
 * Postgres van en snake_case y aquí se adaptan a los tipos camelCase de
 * `src/types` (ChatDoc, MessageDoc…), que no cambian.
 *
 * Tiempo real:
 *   · `postgres_changes` para messages, message_reactions, chats y chat_reads
 *     (las tablas que la migración de T19 mete en `supabase_realtime`).
 *   · Typing por Realtime **Broadcast** en el canal `chat:{wsId}:{chatId}`.
 *   · `workspace_members` y `ai_messages` NO están en la publicación, así que
 *     sus listeners entregan la carga inicial y la suscripción queda como
 *     no-op hasta que la publicación los incluya.
 *
 * `firebase/firestore` ya no se importa en ningún módulo de `src/` (T24):
 * las fechas ISO de PostgREST se envuelven en el `Timestamp` local de
 * `src/lib/timestamp.ts` (mismo nombre y superficie que el de Firestore, sin
 * backend de Firestore detrás).
 */

import { Timestamp } from "@/lib/timestamp";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSupabaseClient } from "@/lib/supabase/client";
import { avatarColorFor } from "@/lib/avatar-color";
import { AI_AUTHOR_ID } from "@/lib/ai/constants";
import {
  LOKI_CANDIDATE,
  LOKI_DISPLAY_NAME,
  type MentionCandidate,
} from "@/lib/chat/mentions";
import {
  isPostMessage,
  POSTS_CHAT_ID,
  POSTS_PAGE_SIZE,
} from "@/lib/chat/posts";
import type {
  ChatDoc,
  MessageAttachment,
  MessageDoc,
  MessageReplyRef,
  ReadReceiptDoc,
  TypingDoc,
} from "@/types/chat";
import type { WorkspaceMember } from "@/types/models";
import type { Database, Json } from "@/types/supabase";

export const MESSAGES_PAGE_SIZE = 30;

/** Suscripción: llamar para dejar de escuchar. */
export type Unsubscribe = () => void;

type ChatRow = Database["public"]["Tables"]["chats"]["Row"];
type MessageRow = Database["public"]["Tables"]["messages"]["Row"];
type ReactionRow = Database["public"]["Tables"]["message_reactions"]["Row"];
type ReadRow = Database["public"]["Tables"]["chat_reads"]["Row"];
type MemberRow = Database["public"]["Tables"]["workspace_members"]["Row"];
type AiChatRow = Database["public"]["Tables"]["ai_chats"]["Row"];
type AiMessageRow = Database["public"]["Tables"]["ai_messages"]["Row"];

/** Cursor opaco para paginar hacia atrás (clave: created_at + id). */
export type PageCursor = { createdAt: string; id: string } | null;

export type OlderMessagesPage = {
  messages: MessageDoc[];
  /** Cursor para la siguiente página (null = no hay más). */
  before: PageCursor;
  hasMore: boolean;
};

// --- Adaptadores snake_case -> camelCase ------------------------------------

/** `createdAt`/`updatedAt` llegan como ISO. Se envuelven en `Timestamp` porque
 *  los tipos públicos y los formateadores de la UI lo exigen (mismo criterio
 *  que T20 en users/workspaces). */
function toTimestamp(iso: string | null | undefined): Timestamp {
  if (typeof iso === "string" && iso !== "") {
    const date = new Date(iso);
    if (!Number.isNaN(date.getTime())) return Timestamp.fromDate(date);
  }
  return Timestamp.now();
}

function toTimestampOrNull(iso: string | null | undefined): Timestamp | null {
  if (typeof iso !== "string" || iso === "") return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return Timestamp.fromDate(date);
}

function toChatDoc(row: ChatRow): ChatDoc {
  const last = toChatLastMessage(row.last_message);
  return {
    id: row.id,
    type: row.type as ChatDoc["type"],
    name: row.name,
    ...(row.emoji === null ? {} : { emoji: row.emoji }),
    memberIds: [...row.member_ids],
    createdBy: row.created_by ?? "",
    createdAt: toTimestamp(row.created_at),
    updatedAt: toTimestamp(row.updated_at),
    lastMessage: last,
  };
}

function toChatLastMessage(value: Json | null): ChatDoc["lastMessage"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, Json | undefined>;
  if (
    typeof raw["text"] !== "string" ||
    typeof raw["authorId"] !== "string" ||
    typeof raw["authorName"] !== "string" ||
    typeof raw["type"] !== "string" ||
    typeof raw["createdAt"] !== "string"
  ) {
    return null;
  }
  return {
    text: raw["text"],
    authorId: raw["authorId"],
    authorName: raw["authorName"],
    type: raw["type"],
    createdAt: toTimestamp(raw["createdAt"]),
  };
}

function toReplyRef(value: Json | null | undefined): MessageReplyRef | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const raw = value as Record<string, Json | undefined>;
  if (
    typeof raw["id"] !== "string" ||
    typeof raw["authorName"] !== "string" ||
    typeof raw["text"] !== "string"
  ) {
    return null;
  }
  return { id: raw["id"], authorName: raw["authorName"], text: raw["text"] };
}

function toAttachments(value: Json | null | undefined): MessageAttachment[] {
  if (!Array.isArray(value)) return [];
  const out: MessageAttachment[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const raw = item as Record<string, Json | undefined>;
    const kind = raw["kind"];
    if (
      (kind === "image" || kind === "video" || kind === "audio" || kind === "file") &&
      typeof raw["url"] === "string" &&
      typeof raw["name"] === "string" &&
      typeof raw["size"] === "number" &&
      typeof raw["mime"] === "string"
    ) {
      const attachment: MessageAttachment = {
        kind,
        url: raw["url"],
        name: raw["name"],
        size: raw["size"],
        mime: raw["mime"],
      };
      // Campos opcionales (dimensiones, duración, path): solo si son válidos.
      if (typeof raw["path"] === "string" && raw["path"] !== "") {
        attachment.path = raw["path"];
      }
      if (typeof raw["width"] === "number" && Number.isFinite(raw["width"])) {
        attachment.width = raw["width"];
      }
      if (typeof raw["height"] === "number" && Number.isFinite(raw["height"])) {
        attachment.height = raw["height"];
      }
      if (
        typeof raw["duration"] === "number" &&
        Number.isFinite(raw["duration"]) &&
        raw["duration"] >= 0
      ) {
        attachment.duration = raw["duration"];
      }
      out.push(attachment);
    }
  }
  return out;
}

function toMessageDoc(
  row: MessageRow,
  reactions?: Map<string, { map: Record<string, string[]>; last: MessageDoc["lastReaction"] }>,
): MessageDoc {
  const entry = reactions?.get(row.id);
  return {
    id: row.id,
    authorId: row.author_id ?? "",
    authorName: row.author_name,
    text: row.text,
    mentions: [...row.mentions],
    replyTo: toReplyRef(row.reply_to),
    threadParentId: row.thread_parent_id,
    threadCount: row.thread_count,
    lastReplyAt: toTimestampOrNull(row.last_reply_at),
    attachments: toAttachments(row.attachments),
    reactions: entry ? { ...entry.map } : {},
    lastReaction: entry?.last ?? null,
    createdAt: toTimestamp(row.created_at),
    editedAt: toTimestampOrNull(row.edited_at),
    deleted: row.deleted,
    type: row.type as MessageDoc["type"],
    meta: (row.meta ?? null) as MessageDoc["meta"],
  };
}

function toMemberDoc(row: MemberRow): WorkspaceMember {
  return {
    uid: row.user_id,
    role: row.role as WorkspaceMember["role"],
    displayName: row.display_name,
    // workspace_members no guarda color: se deriva del uid como en T16.
    avatarColor: avatarColorFor(row.user_id),
    joinedAt: toTimestamp(row.joined_at),
  };
}

/** chat_reads no tiene columna de mensaje: el id leído no se persiste (los no
 *  leídos se calculan por fecha, igual que antes). */
function toReadDoc(row: ReadRow): ReadReceiptDoc {
  return {
    uid: row.user_id,
    lastReadAt: toTimestamp(row.last_read_at),
    lastReadMessageId: null,
  };
}

// --- Errores ----------------------------------------------------------------

function errorMessage(error: unknown, fallback: string): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    // Sin permiso o fila invisible por RLS: no es un fallo de red, es acceso.
    if (code === "42501") {
      return "No tienes acceso a este espacio. Vuelve a entrar.";
    }
  }
  return fallback;
}

// --- Realtime: postgres_changes ---------------------------------------------

type TableSubscription = {
  topic: string;
  table: "messages" | "message_reactions" | "chats" | "chat_reads" | "workspace_members" | "ai_messages";
  /** Filtro de servidor (una columna). El resto se filtra en cliente. */
  filter?: string;
  onEvent: () => void;
  onError?: (error: Error) => void;
};

/**
 * Suscripción a cambios de una tabla con carga inicial.
 *
 * Cada `listen*` entrega primero la foto actual (para que el hook no dependa
 * de cuándo llegue el primer evento) y luego recarga ante cada evento. Si el
 * canal falla, el error va a `onError`, nunca sin capturar.
 */
type TablePoolEntry = {
  refs: number;
  events: Set<() => void>;
  errors: Set<(error: Error) => void>;
  cancelled: boolean;
  remove: () => void;
};

/**
 * Un canal por topic, compartido entre componentes. `supabase.channel(topic)`
 * devuelve la misma instancia si ya existe y añadir `.on()` tras
 * `subscribe()` lanza ("cannot add postgres_changes callbacks after
 * subscribe"), lo que tumbaba la app cuando dos vistas escuchaban lo mismo
 * (p. ej. campana + toast). Aquí cada `listen*` suma sus callbacks y el
 * canal se crea una sola vez.
 */
const tablePool = new Map<string, TablePoolEntry>();

/** Reintentos de re-suscripción ante error del canal (con tope y pausa). */
const TABLE_REATTACH_MAX = 5;
const TABLE_REATTACH_DELAY_MS = 2000;

function attachTableChannel(
  sub: TableSubscription,
  entry: TablePoolEntry,
  attempts: number,
): void {
  const supabase = getSupabaseClient();
  try {
    const channel: RealtimeChannel = supabase.channel(sub.topic);
    channel.on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: sub.table,
        ...(sub.filter === undefined ? {} : { filter: sub.filter }),
      },
      () => {
        const current = tablePool.get(sub.topic);
        if (current === undefined || current.cancelled) return;
        for (const onEvent of current.events) onEvent();
      },
    );
    channel.subscribe((status, error) => {
      const current = tablePool.get(sub.topic);
      if (current === undefined || current.cancelled) return;
      if (status !== "CHANNEL_ERROR" && status !== "TIMED_OUT") return;
      const err =
        error instanceof Error ? error : new Error(`Canal ${sub.topic}: ${status}`);
      for (const onError of current.errors) onError(err);
      // El canal puede quedar muerto (red caída): se recrea con tope.
      if (attempts >= TABLE_REATTACH_MAX) return;
      void supabase.removeChannel(channel);
      setTimeout(() => {
        const live = tablePool.get(sub.topic);
        if (live === undefined || live.cancelled || live.refs <= 0) return;
        attachTableChannel(sub, live, attempts + 1);
      }, TABLE_REATTACH_DELAY_MS);
    });
    entry.remove = () => {
      void supabase.removeChannel(channel);
    };
  } catch {
    // Realtime caído: se entrega la foto inicial y se sigue por query.
    tablePool.delete(sub.topic);
  }
}

function subscribeTable(sub: TableSubscription): Unsubscribe {
  let entry = tablePool.get(sub.topic);
  if (entry === undefined) {
    const fresh: TablePoolEntry = {
      refs: 0,
      events: new Set(),
      errors: new Set(),
      cancelled: false,
      remove: () => undefined,
    };
    tablePool.set(sub.topic, fresh);
    entry = fresh;
    attachTableChannel(sub, fresh, 0);
    if (tablePool.get(sub.topic) === undefined) {
      // Realtime caído: foto inicial y se sigue por query.
      entry = undefined;
    }
  }
  if (entry === undefined) {
    sub.onEvent();
    return () => undefined;
  }
  const current = entry;
  current.refs += 1;
  current.events.add(sub.onEvent);
  if (sub.onError !== undefined) current.errors.add(sub.onError);
  // La foto inicial sale igual haya o no eventos después.
  sub.onEvent();
  let done = false;
  return () => {
    if (done) return;
    done = true;
    current.events.delete(sub.onEvent);
    if (sub.onError !== undefined) current.errors.delete(sub.onError);
    current.refs -= 1;
    if (current.refs <= 0) {
      current.cancelled = true;
      current.remove();
      if (tablePool.get(sub.topic) === current) tablePool.delete(sub.topic);
    }
  };
}

// --- Realtime: Broadcast para typing ----------------------------------------

type BroadcastPoolEntry = { channel: RealtimeChannel; refs: number };

const broadcastPool = new Map<string, BroadcastPoolEntry>();

function typingTopic(wsId: string, chatId: string): string {
  return `chat:${wsId}:${chatId}`;
}

function acquireBroadcast(topic: string): RealtimeChannel {
  const pooled = broadcastPool.get(topic);
  if (pooled !== undefined) {
    pooled.refs += 1;
    return pooled.channel;
  }
  const channel = getSupabaseClient().channel(topic, {
    config: { broadcast: { self: false } },
  });
  channel.subscribe();
  broadcastPool.set(topic, { channel, refs: 1 });
  return channel;
}

function releaseBroadcast(topic: string): void {
  const pooled = broadcastPool.get(topic);
  if (pooled === undefined) return;
  pooled.refs -= 1;
  if (pooled.refs <= 0) {
    broadcastPool.delete(topic);
    void getSupabaseClient().removeChannel(pooled.channel);
  }
}

type TypingPayload = {
  uid: string;
  displayName: string;
  /** Epoch ms del cliente que escribe. */
  at: number;
};

function isTypingPayload(value: unknown): value is TypingPayload {
  if (typeof value !== "object" || value === null) return false;
  const raw = value as Record<string, unknown>;
  return (
    typeof raw["uid"] === "string" &&
    typeof raw["displayName"] === "string" &&
    typeof raw["at"] === "number"
  );
}

// --- Chats ------------------------------------------------------------------

/** Genera un id de cliente para el envío optimista (también sirve de DM). */
export function newChatId(wsId: string): string {
  void wsId;
  return crypto.randomUUID();
}

/** Genera un id de mensaje de cliente para el envío optimista y reintentos. */
export function newMessageId(wsId: string, chatId: string): string {
  void wsId;
  void chatId;
  return crypto.randomUUID();
}

/**
 * Lista los chats visibles del espacio (RLS `can_access_chat`: grupos y posts
 * para todo el espacio, DMs solo para sus miembros), del más reciente al más
 * antiguo.
 */
export async function fetchChats(wsId: string, uid: string): Promise<ChatDoc[]> {
  // El uid lo usa la RLS de la sesión, no la consulta: se conserva por API.
  void uid;
  const { data, error } = await getSupabaseClient()
    .from("chats")
    .select(
      "workspace_id, id, type, name, emoji, member_ids, created_by, last_message, created_at, updated_at",
    )
    .eq("workspace_id", wsId)
    .order("updated_at", { ascending: false })
    .order("id", { ascending: true });
  if (error !== null) {
    throw new Error(errorMessage(error, "No se pudieron cargar los chats."));
  }
  return (data ?? []).map(toChatDoc);
}

export function listenChats(
  wsId: string,
  uid: string,
  cb: (chats: ChatDoc[]) => void,
): Unsubscribe {
  return subscribeTable({
    topic: `loki:chats:${wsId}`,
    table: "chats",
    filter: `workspace_id=eq.${wsId}`,
    onEvent: () => {
      void fetchChats(wsId, uid).then(cb).catch(() => {
        // Un fallo puntual deja la última lista en caché; el próximo evento
        // reintenta. Sin excepciones sin capturar.
      });
    },
  });
}

export type CreateDmInput = {
  name: string;
  memberIds: string[];
  createdBy: string;
  emoji?: string;
};

export async function createDm(
  wsId: string,
  input: CreateDmInput,
): Promise<string> {
  const name = input.name.trim();
  if (name === "" || name.length > 60) {
    throw new Error("El nombre del chat debe tener entre 1 y 60 caracteres.");
  }
  if (!input.memberIds.includes(input.createdBy)) {
    throw new Error("El creador debe ser miembro del chat directo.");
  }
  const id = crypto.randomUUID();
  const { error } = await getSupabaseClient().from("chats").insert({
    workspace_id: wsId,
    id,
    type: "dm",
    name,
    emoji: input.emoji ?? null,
    member_ids: input.memberIds,
    created_by: input.createdBy,
  });
  if (error !== null) {
    throw new Error(errorMessage(error, "No se pudo crear el chat."));
  }
  return id;
}

// --- Publicaciones (chat `posts`) --------------------------------------------

/**
 * Crea el chat `posts` si falta (espacios anteriores a T17) con la RPC
 * `ensure_posts_chat`: idempotente, devuelve true si lo creó.
 */
export async function ensurePostsChat(wsId: string, uid: string): Promise<void> {
  // La RPC usa auth.uid() de la sesión; el parámetro se conserva por API.
  void uid;
  const { error } = await getSupabaseClient().rpc("ensure_posts_chat", {
    p_workspace_id: wsId,
  });
  if (error !== null) {
    throw new Error(errorMessage(error, "No se pudo preparar el chat."));
  }
}

// --- Miembros (candidatos de mención) ----------------------------------------

/** Miembros del espacio ordenados por nombre (tope 100 para el menú @). */
export async function listMembers(wsId: string): Promise<WorkspaceMember[]> {
  const { data, error } = await getSupabaseClient()
    .from("workspace_members")
    .select("workspace_id, user_id, role, display_name, joined_at")
    .eq("workspace_id", wsId)
    .order("display_name", { ascending: true })
    .limit(100);
  if (error !== null) {
    throw new Error(errorMessage(error, "No se pudieron cargar los miembros."));
  }
  return (data ?? []).map(toMemberDoc);
}

/** Suscripción en vivo a los miembros (hoy: foto inicial; la tabla aún no
 *  está en la publicación de realtime, así que no llegan eventos). */
export function listenMembers(
  wsId: string,
  cb: (members: WorkspaceMember[]) => void,
): Unsubscribe {
  return subscribeTable({
    topic: `loki:members:${wsId}`,
    table: "workspace_members",
    filter: `workspace_id=eq.${wsId}`,
    onEvent: () => {
      void listMembers(wsId).then(cb).catch(() => undefined);
    },
  });
}

/** Miembros -> candidatos de mención ordenados (sin duplicar uid). */
export function membersToCandidates(
  members: readonly WorkspaceMember[],
): MentionCandidate[] {
  const seen = new Set<string>();
  const out: MentionCandidate[] = [];
  for (const member of members) {
    if (seen.has(member.uid)) continue;
    seen.add(member.uid);
    const name = member.displayName.trim();
    out.push({
      id: member.uid,
      displayName: name === "" ? "Miembro" : name,
    });
  }
  out.sort((a, b) => a.displayName.localeCompare(b.displayName, "es"));
  return out;
}

/** Candidatos del menú @: entrada fija de Loki primero + miembros. */
export function mentionCandidatesWithLoki(
  members: readonly WorkspaceMember[],
): MentionCandidate[] {
  return [LOKI_CANDIDATE, ...membersToCandidates(members)];
}

// --- Mensajes: lectura -------------------------------------------------------

const MESSAGE_COLUMNS =
  "id, workspace_id, chat_id, author_id, author_name, text, type, mentions, reply_to, thread_parent_id, thread_count, last_reply_at, attachments, edited_at, deleted, meta, created_at";

/** Reacciones de una lista de mensajes: mapa {emoji: uid[]} + última por fecha. */
async function fetchReactionMaps(
  messageIds: string[],
): Promise<
  Map<string, { map: Record<string, string[]>; last: MessageDoc["lastReaction"] }>
> {
  const out = new Map<
    string,
    { map: Record<string, string[]>; last: MessageDoc["lastReaction"] }
  >();
  if (messageIds.length === 0) return out;
  const { data, error } = await getSupabaseClient()
    .from("message_reactions")
    .select("message_id, user_id, emoji, created_at")
    .in("message_id", messageIds)
    .order("created_at", { ascending: true });
  if (error !== null) return out;
  for (const row of (data ?? []) as ReactionRow[]) {
    let entry = out.get(row.message_id);
    if (entry === undefined) {
      entry = { map: {}, last: null };
      out.set(row.message_id, entry);
    }
    const list = entry.map[row.emoji] ?? [];
    if (!list.includes(row.user_id)) list.push(row.user_id);
    entry.map[row.emoji] = list;
    // Orden ascendente: la última fila vista es la más reciente.
    entry.last = { uid: row.user_id, emoji: row.emoji };
  }
  return out;
}

function withReactions(
  rows: MessageRow[],
  maps: Map<string, { map: Record<string, string[]>; last: MessageDoc["lastReaction"] }>,
): MessageDoc[] {
  return rows.map((row) => toMessageDoc(row, maps));
}

/** Últimos mensajes del timeline principal (más antiguos primero). */
export async function fetchLatestMessages(
  wsId: string,
  chatId: string,
  pageSize = MESSAGES_PAGE_SIZE,
): Promise<MessageDoc[]> {
  const { data, error } = await getSupabaseClient()
    .from("messages")
    .select(MESSAGE_COLUMNS)
    .eq("workspace_id", wsId)
    .eq("chat_id", chatId)
    .is("thread_parent_id", null)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(pageSize);
  if (error !== null) {
    throw new Error(errorMessage(error, "No se pudieron cargar los mensajes."));
  }
  const rows = ((data ?? []) as MessageRow[]).slice().reverse();
  const maps = await fetchReactionMaps(rows.map((row) => row.id));
  return withReactions(rows, maps);
}

/**
 * Suscripción en vivo a los últimos mensajes del timeline.
 * Cada evento recarga la ventana y la entrega ordenada ascendente.
 */
export function listenLatestMessages(
  wsId: string,
  chatId: string,
  cb: (messages: MessageDoc[]) => void,
): Unsubscribe {
  return subscribeTable({
    topic: `loki:msgs:${wsId}:${chatId}`,
    table: "messages",
    filter: `workspace_id=eq.${wsId}`,
    onEvent: () => {
      void fetchLatestMessages(wsId, chatId)
        .then(cb)
        .catch(() => undefined);
    },
  });
}

function cursorPredicate(before: Exclude<PageCursor, null>): {
  createdAt: string;
  id: string;
} {
  return { createdAt: before.createdAt, id: before.id };
}

export async function fetchOlderMessages(
  wsId: string,
  chatId: string,
  before: PageCursor,
  pageSize = MESSAGES_PAGE_SIZE,
): Promise<OlderMessagesPage> {
  if (before === null) {
    return { messages: [], before: null, hasMore: false };
  }
  const { createdAt, id } = cursorPredicate(before);
  // Clave (created_at, id): estrictamente más antiguo que el cursor.
  const { data, error } = await getSupabaseClient()
    .from("messages")
    .select(MESSAGE_COLUMNS)
    .eq("workspace_id", wsId)
    .eq("chat_id", chatId)
    .is("thread_parent_id", null)
    .or(`created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${id})`)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(pageSize);
  if (error !== null) {
    throw new Error(errorMessage(error, "No se pudieron cargar los mensajes."));
  }
  const rows = ((data ?? []) as MessageRow[]).slice().reverse();
  const maps = await fetchReactionMaps(rows.map((row) => row.id));
  const messages = withReactions(rows, maps);
  const oldest = rows[0];
  return {
    messages,
    before:
      oldest === undefined
        ? null
        : { createdAt: oldest.created_at, id: oldest.id },
    hasMore: rows.length === pageSize,
  };
}

/** Respuestas de un hilo, de más antigua a más nueva (tope 100). */
export async function fetchThread(
  wsId: string,
  chatId: string,
  parentId: string,
): Promise<MessageDoc[]> {
  const { data, error } = await getSupabaseClient()
    .from("messages")
    .select(MESSAGE_COLUMNS)
    .eq("workspace_id", wsId)
    .eq("chat_id", chatId)
    .eq("thread_parent_id", parentId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(100);
  if (error !== null) {
    throw new Error(errorMessage(error, "No se pudieron cargar las respuestas."));
  }
  const rows = (data ?? []) as MessageRow[];
  const maps = await fetchReactionMaps(rows.map((row) => row.id));
  return withReactions(rows, maps);
}

export function listenThread(
  wsId: string,
  chatId: string,
  parentId: string,
  cb: (messages: MessageDoc[]) => void,
): Unsubscribe {
  return subscribeTable({
    topic: `loki:thread:${wsId}:${chatId}:${parentId}`,
    table: "messages",
    filter: `workspace_id=eq.${wsId}`,
    onEvent: () => {
      void fetchThread(wsId, chatId, parentId)
        .then(cb)
        .catch(() => undefined);
    },
  });
}

// --- Mensajes: escritura -----------------------------------------------------

export type SendMessageInput = {
  authorId: string;
  authorName: string;
  text: string;
  mentions?: string[];
  replyTo?: MessageReplyRef | null;
  threadParentId?: string | null;
  attachments?: MessageAttachment[];
  type?: "user" | "post" | "system" | "card";
  /** Datos de tarjeta (solo type "card"): p. ej. { kind: "list", list_id }. */
  meta?: Record<string, unknown> | null;
  /**
   * Id de cliente para envío optimista y reintentos: si se pasa, el
   * mensaje se escribe con ese id (mismo id al reintentar).
   */
  messageId?: string;
};

function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

/**
 * Envía un mensaje con id de cliente (`crypto.randomUUID()`).
 *
 * El preview del chat y los contadores de hilo los mantienen los triggers de
 * Postgres (el cliente no los escribe). Si el id ya existe (reintento cuyo
 * primer intento sí llegó), se considera éxito: envío idempotente.
 */
export async function sendMessage(
  wsId: string,
  chatId: string,
  input: SendMessageInput,
): Promise<string> {
  const text = input.text.trim();
  const attachments = input.attachments ?? [];
  // El texto puede ir vacío si el mensaje lleva adjuntos (foto sola, nota
  // de voz…); sin texto ni adjuntos no hay nada que enviar.
  if (text === "" && attachments.length === 0) {
    throw new Error("Escribe un mensaje primero.");
  }
  if (text.length > 4000) {
    throw new Error("El mensaje no puede superar los 4000 caracteres.");
  }
  if (input.authorId === "") {
    throw new Error("Inicia sesión para enviar mensajes.");
  }
  const id =
    input.messageId !== undefined && input.messageId !== ""
      ? input.messageId
      : crypto.randomUUID();
  const { error } = await getSupabaseClient().from("messages").insert({
    id,
    workspace_id: wsId,
    chat_id: chatId,
    author_id: input.authorId,
    author_name: input.authorName,
    text,
    type: input.type ?? "user",
    mentions: input.mentions ?? [],
    reply_to:
      input.replyTo === undefined || input.replyTo === null
        ? null
        : {
            id: input.replyTo.id,
            authorName: input.replyTo.authorName,
            text: input.replyTo.text,
          },
    thread_parent_id: input.threadParentId ?? null,
    attachments: (input.attachments ?? []) as unknown as Json,
    meta: (input.meta ?? {}) as unknown as Json,
  });
  if (error !== null) {
    // El reintento con el mismo id choca con la PK: el mensaje ya está.
    if (isDuplicateKey(error)) return id;
    throw new Error(errorMessage(error, "No se pudo enviar el mensaje."));
  }
  return id;
}

export async function editMessage(
  wsId: string,
  chatId: string,
  messageId: string,
  text: string,
  mentions?: string[],
): Promise<void> {
  const next = text.trim();
  if (next === "") {
    throw new Error("El mensaje no puede quedar vacío. Bórralo si prefieres.");
  }
  if (next.length > 4000) {
    throw new Error("El mensaje no puede superar los 4000 caracteres.");
  }
  void wsId;
  void chatId;
  const patch: { text: string; edited_at: string; mentions?: string[] } = {
    text: next,
    edited_at: new Date().toISOString(),
  };
  if (mentions !== undefined) {
    patch.mentions = mentions;
  }
  // Solo el id basta: la RLS (`author_id = auth.uid()`) y el guard de UPDATE
  // (solo text/mentions/edited_at/deleted) protegen el resto.
  const { error } = await getSupabaseClient()
    .from("messages")
    .update(patch)
    .eq("id", messageId);
  if (error !== null) {
    throw new Error(errorMessage(error, "No se pudo editar el mensaje."));
  }
}

/** Borrado suave: marca deleted y vacía el texto. */
export async function deleteMessage(
  wsId: string,
  chatId: string,
  messageId: string,
): Promise<void> {
  void wsId;
  void chatId;
  const { error } = await getSupabaseClient()
    .from("messages")
    .update({
      deleted: true,
      text: "",
      edited_at: new Date().toISOString(),
    })
    .eq("id", messageId);
  if (error !== null) {
    throw new Error(errorMessage(error, "No se pudo borrar el mensaje."));
  }
}

export async function toggleReaction(
  wsId: string,
  chatId: string,
  messageId: string,
  emoji: string,
  uid: string,
  hasReacted: boolean,
): Promise<void> {
  void wsId;
  void chatId;
  if (uid === "") {
    throw new Error("Inicia sesión para reaccionar.");
  }
  const supabase = getSupabaseClient();
  if (hasReacted) {
    const { error } = await supabase
      .from("message_reactions")
      .delete()
      .eq("message_id", messageId)
      .eq("user_id", uid)
      .eq("emoji", emoji);
    if (error !== null) {
      throw new Error(errorMessage(error, "No se pudo quitar la reacción."));
    }
    return;
  }
  const { error } = await supabase.from("message_reactions").insert({
    message_id: messageId,
    user_id: uid,
    emoji,
  });
  if (error !== null) {
    // Doble toque: la fila ya existe, el estado final es el querido.
    if (isDuplicateKey(error)) return;
    throw new Error(errorMessage(error, "No se pudo añadir la reacción."));
  }
}

/**
 * Avisa cuando cambian las reacciones (tabla sin columna de espacio: se
 * escucha sin filtro y quien llama recarga solo sus ids).
 */
export function listenReactions(onEvent: () => void): Unsubscribe {
  return subscribeTable({
    topic: "loki:reactions",
    table: "message_reactions",
    onEvent,
  });
}

/** Reacciones de unos mensajes ya cargados (para refrescar sus mapas). */
export async function fetchReactionsFor(
  messageIds: string[],
): Promise<
  Map<string, { map: Record<string, string[]>; last: MessageDoc["lastReaction"] }>
> {
  return fetchReactionMaps(messageIds);
}

// --- Publicaciones: feed -----------------------------------------------------

/** Feed: mensajes `type: "post"` del chat `posts`, más recientes primero. */
export async function fetchPosts(wsId: string): Promise<MessageDoc[]> {
  const { data, error } = await getSupabaseClient()
    .from("messages")
    .select(MESSAGE_COLUMNS)
    .eq("workspace_id", wsId)
    .eq("chat_id", POSTS_CHAT_ID)
    .is("thread_parent_id", null)
    .eq("type", "post")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(POSTS_PAGE_SIZE);
  if (error !== null) {
    throw new Error(errorMessage(error, "No se pudieron cargar las publicaciones."));
  }
  const rows = (data ?? []) as MessageRow[];
  const maps = await fetchReactionMaps(rows.map((row) => row.id));
  return withReactions(rows, maps);
}

/**
 * Suscripción en vivo al feed de publicaciones.
 * `onError` recibe fallos del canal (un espacio sin acceso no da error: la
 * RLS devuelve lista vacía).
 */
export function listenPosts(
  wsId: string,
  cb: (posts: MessageDoc[]) => void,
  onError?: (error: Error) => void,
): Unsubscribe {
  return subscribeTable({
    topic: `loki:posts:${wsId}`,
    table: "messages",
    filter: `workspace_id=eq.${wsId}`,
    onEvent: () => {
      void fetchPosts(wsId)
        .then((posts) => cb(posts.filter(isPostMessage)))
        .catch((error: unknown) => {
          onError?.(
            error instanceof Error ? error : new Error("Falló el feed."),
          );
        });
    },
    onError,
  });
}

// --- Loki IA (chat privado) ---------------------------------------------------

/**
 * Resuelve el chat privado de IA del usuario (el UI lo llama "loki-ia", en la
 * base es un uuid): primera fila propia o alta si no existe.
 */
async function ensureAiChat(uid: string): Promise<string> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("ai_chats")
    .select("id")
    .eq("user_id", uid)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error !== null) {
    throw new Error(errorMessage(error, "No se pudo abrir el chat de Loki."));
  }
  const existing = (data as Pick<AiChatRow, "id"> | null)?.id;
  if (typeof existing === "string" && existing !== "") return existing;
  const { data: created, error: insertError } = await supabase
    .from("ai_chats")
    .insert({ user_id: uid })
    .select("id")
    .single();
  if (insertError !== null) {
    throw new Error(errorMessage(insertError, "No se pudo abrir el chat de Loki."));
  }
  return (created as Pick<AiChatRow, "id">).id;
}

function toAiMessageDoc(
  uid: string,
  row: AiMessageRow,
): MessageDoc {
  const isLoki = row.type === "ai";
  return {
    id: row.id,
    authorId: isLoki ? AI_AUTHOR_ID : uid,
    authorName: isLoki ? LOKI_DISPLAY_NAME : "",
    text: row.content,
    mentions: [],
    replyTo: null,
    threadParentId: null,
    threadCount: 0,
    lastReplyAt: null,
    attachments: [],
    reactions: {},
    lastReaction: null,
    createdAt: toTimestamp(row.created_at),
    editedAt: null,
    deleted: false,
    type: isLoki ? "ai" : "user",
  };
}

export async function fetchAiMessages(uid: string, chatId: string): Promise<MessageDoc[]> {
  void chatId;
  const uuid = await ensureAiChat(uid);
  const { data, error } = await getSupabaseClient()
    .from("ai_messages")
    .select("id, chat_id, type, content, created_at")
    .eq("chat_id", uuid)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(100);
  if (error !== null) {
    throw new Error(errorMessage(error, "No se pudieron cargar los mensajes."));
  }
  return ((data ?? []) as AiMessageRow[]).map((row) => toAiMessageDoc(uid, row));
}

/**
 * Suscripción en vivo a los mensajes del chat privado con Loki.
 * `ai_messages` no está en la publicación de realtime: entrega la foto
 * inicial y la suscripción queda como no-op.
 */
export function listenAiMessages(
  uid: string,
  chatId: string,
  cb: (messages: MessageDoc[]) => void,
): Unsubscribe {
  void chatId;
  let cancel: Unsubscribe | null = null;
  let cancelled = false;
  void ensureAiChat(uid)
    .then((uuid) => {
      if (cancelled) return;
      cancel = subscribeTable({
        topic: `loki:ai:${uuid}`,
        table: "ai_messages",
        filter: `chat_id=eq.${uuid}`,
        onEvent: () => {
          void fetchAiMessages(uid, uuid)
            .then(cb)
            .catch(() => undefined);
        },
      });
    })
    .catch(() => {
      if (!cancelled) cb([]);
    });
  return () => {
    cancelled = true;
    cancel?.();
  };
}

/** Escribe mi mensaje (`type: "user"`) en el chat privado con Loki. */
export async function sendAiUserMessage(
  uid: string,
  chatId: string,
  input: { authorId: string; authorName: string; text: string },
): Promise<string> {
  void chatId;
  const text = input.text.trim();
  if (text === "") {
    throw new Error("Escribe un mensaje primero.");
  }
  if (text.length > 4000) {
    throw new Error("El mensaje no puede superar los 4000 caracteres.");
  }
  if (input.authorId === "" || input.authorId !== uid) {
    throw new Error("Inicia sesión para escribir a Loki.");
  }
  const uuid = await ensureAiChat(uid);
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("ai_messages")
    .insert({ chat_id: uuid, type: "user", content: text })
    .select("id")
    .single();
  if (error !== null) {
    throw new Error(errorMessage(error, "No se pudo enviar el mensaje."));
  }
  // Toca el chat para que ordene por actividad (best effort: el mensaje ya
  // quedó guardado aunque esto falle).
  await supabase
    .from("ai_chats")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", uuid)
    .then(
      () => undefined,
      () => undefined,
    );
  return ((data as Pick<AiMessageRow, "id"> | null)?.id ?? "").toString();
}

/**
 * Escribe la RESPUESTA de Loki (`type: "ai"`).
 *
 * La usa el streaming SIMULADO de T18. En Supabase la RLS solo deja `type:
 * "user"` al cliente (`'ai'` es de la service role de T23), así que hoy falla
 * con mensaje claro; T23 elimina este camino al poner la IA real.
 */
export async function sendAiAssistantMessage(
  uid: string,
  chatId: string,
  input: { text: string; mentions?: string[] },
): Promise<string> {
  const text = input.text.trim();
  if (text === "") {
    throw new Error("La respuesta de Loki no puede quedar vacía.");
  }
  if (text.length > 4000) {
    throw new Error("La respuesta no puede superar los 4000 caracteres.");
  }
  const uuid = await ensureAiChat(uid);
  void chatId;
  // ai_messages no tiene columna de menciones: se aceptan por API y se ignoran
  void input.mentions;
  const { data, error } = await getSupabaseClient()
    .from("ai_messages")
    .insert({ chat_id: uuid, type: "ai", content: text })
    .select("id")
    .single();
  if (error !== null) {
    throw new Error("No se pudo guardar la respuesta de Loki. Inténtalo de nuevo.");
  }
  return ((data as Pick<AiMessageRow, "id"> | null)?.id ?? "").toString();
}

// --- Typing (Broadcast) -------------------------------------------------------

/** Marca que el usuario está escribiendo (el throttle lo hace el hook). */
export async function setTyping(
  wsId: string,
  chatId: string,
  uid: string,
  displayName: string,
): Promise<void> {
  const name = displayName.trim() === "" ? "Miembro" : displayName.trim();
  const topic = typingTopic(wsId, chatId);
  const channel = acquireBroadcast(topic);
  try {
    await channel.send({
      type: "broadcast",
      event: "typing",
      payload: {
        uid,
        displayName: name.slice(0, 40),
        at: Date.now(),
      } satisfies TypingPayload,
    });
  } catch {
    // Ephemeral por diseño: el hook reintenta mientras se escribe.
  } finally {
    releaseBroadcast(topic);
  }
}

/** Borra la marca de escritura (input vacío o desmontaje). */
export async function clearTyping(
  wsId: string,
  chatId: string,
  uid: string,
): Promise<void> {
  const topic = typingTopic(wsId, chatId);
  const channel = acquireBroadcast(topic);
  try {
    await channel.send({
      type: "broadcast",
      event: "typing-clear",
      payload: { uid, displayName: "", at: Date.now() } satisfies TypingPayload,
    });
  } catch {
    // Sin red no hay a quién avisar: el aviso expira solo por TTL.
  } finally {
    releaseBroadcast(topic);
  }
}

/** Suscripción en vivo a quién está escribiendo en el chat. */
export function listenTyping(
  wsId: string,
  chatId: string,
  cb: (typing: TypingDoc[]) => void,
): Unsubscribe {
  const topic = typingTopic(wsId, chatId);
  const channel = acquireBroadcast(topic);
  const byUid = new Map<string, { displayName: string; at: number }>();
  const emit = (): void => {
    cb(
      [...byUid.entries()].map(([uid, item]) => ({
        uid,
        displayName: item.displayName,
        updatedAt: Timestamp.fromMillis(item.at),
      })),
    );
  };
  const offTyping = channel.on("broadcast", { event: "typing" }, (envelope) => {
    const payload: unknown = (envelope as { payload?: unknown }).payload;
    if (!isTypingPayload(payload)) return;
    byUid.set(payload.uid, { displayName: payload.displayName, at: payload.at });
    emit();
  });
  const offClear = channel.on("broadcast", { event: "typing-clear" }, (envelope) => {
    const payload: unknown = (envelope as { payload?: unknown }).payload;
    if (!isTypingPayload(payload)) return;
    if (byUid.delete(payload.uid)) emit();
  });
  void offTyping;
  void offClear;
  emit();
  return () => {
    // `.on` devuelve el canal: basta con soltar la referencia del pool.
    releaseBroadcast(topic);
  };
}

// --- Lecturas -----------------------------------------------------------------

/** Guarda mi marca de lectura (solo mi fila de chat_reads). */
export async function markChatRead(
  wsId: string,
  chatId: string,
  uid: string,
  lastReadMessageId: string | null,
): Promise<void> {
  void lastReadMessageId;
  // chat_reads no guarda el id del mensaje, solo la fecha (los no leídos van
  // por `last_read_at`). El upsert crea o refresca mi fila.
  const { error } = await getSupabaseClient()
    .from("chat_reads")
    .upsert(
      {
        workspace_id: wsId,
        chat_id: chatId,
        user_id: uid,
        last_read_at: new Date().toISOString(),
      },
      { onConflict: "workspace_id,chat_id,user_id" },
    );
  if (error !== null) {
    throw new Error(errorMessage(error, "No se pudo guardar la lectura."));
  }
}

/** Lee mi marca de lectura una vez (para el E2E y revalidaciones). */
export async function fetchMyRead(
  wsId: string,
  chatId: string,
  uid: string,
): Promise<ReadReceiptDoc | null> {
  const { data, error } = await getSupabaseClient()
    .from("chat_reads")
    .select("workspace_id, chat_id, user_id, last_read_at")
    .eq("workspace_id", wsId)
    .eq("chat_id", chatId)
    .eq("user_id", uid)
    .maybeSingle();
  if (error !== null) return null;
  if (data === null) return null;
  return toReadDoc(data as ReadRow);
}

/** Suscripción a mi marca de lectura de un chat (null si nunca lo abrí). */
export function listenMyRead(
  wsId: string,
  chatId: string,
  uid: string,
  cb: (read: ReadReceiptDoc | null) => void,
): Unsubscribe {
  return subscribeTable({
    topic: `loki:reads:${wsId}:${chatId}`,
    table: "chat_reads",
    filter: `workspace_id=eq.${wsId}`,
    onEvent: () => {
      void fetchMyRead(wsId, chatId, uid).then(cb);
    },
  });
}

/**
 * Ventana de no leídos: conteo + id del último + desde cuándo (para el
 * resumen de no leídos y su caché). Misma regla que fetchUnreadCount.
 */
export async function fetchUnreadWindow(
  wsId: string,
  chatId: string,
  uid: string,
  sinceMs: number | null,
): Promise<{ count: number; lastId: string | null; since: string | null }> {
  const { data, error } = await getSupabaseClient()
    .from("messages")
    .select("id, author_id, created_at")
    .eq("workspace_id", wsId)
    .eq("chat_id", chatId)
    .is("thread_parent_id", null)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(100);
  if (error !== null) return { count: 0, lastId: null, since: null };
  let count = 0;
  let lastId: string | null = null;
  let since: string | null = null;
  for (const row of (data ?? []) as { id: string; author_id: string | null; created_at: string }[]) {
    if (row.author_id === uid) continue;
    const ms = new Date(row.created_at).getTime();
    const isNew = sinceMs === null || Number.isNaN(ms) || ms > sinceMs;
    if (!isNew) continue;
    count += 1;
    // El primero en orden desc es el más nuevo.
    if (lastId === null) {
      lastId = row.id;
      since = row.created_at;
    }
  }
  return { count, lastId, since };
}
export async function fetchUnreadCount(
  wsId: string,
  chatId: string,
  uid: string,
  sinceMs: number | null,
): Promise<number> {
  const { data, error } = await getSupabaseClient()
    .from("messages")
    .select("author_id, created_at")
    .eq("workspace_id", wsId)
    .eq("chat_id", chatId)
    .is("thread_parent_id", null)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(50);
  if (error !== null) return 0;
  let count = 0;
  for (const row of (data ?? []) as { author_id: string | null; created_at: string }[]) {
    if (row.author_id === uid) continue;
    if (sinceMs === null) {
      count += 1;
      continue;
    }
    const ms = new Date(row.created_at).getTime();
    if (!Number.isNaN(ms) && ms > sinceMs) count += 1;
    else if (Number.isNaN(ms)) count += 1;
  }
  return count;
}
