"use client";

/**
 * Encuestas sobre Supabase (Postgres + RLS).
 *
 * Todo lo que la tarjeta necesita sale de la RPC `poll_results`: es
 * `SECURITY DEFINER` porque en una encuesta anónima la RLS esconde los votos
 * de los demás, así que el conteo llega de la función (que además no expone
 * los `user_id`). Es la misma puerta que usa el resto: cada RPC vuelve a
 * comprobar `can_access_chat` y que la encuesta siga abierta.
 *
 * Crear una encuesta son tres escrituras (mensaje tarjeta → polls →
 * poll_options) con el id de la encuesta generado en el cliente: así la
 * tarjeta ya sabe su `poll_id` desde el primer pintado y no hay que
 * "enlazarla" después. Si la encuesta no sale, el mensaje se borra en suave.
 */

import { Timestamp } from "@/lib/timestamp";
import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSupabaseClient } from "@/lib/supabase/client";
import type { Database, Json } from "@/types/supabase";
import type {
  NewPollInput,
  PollCloseBy,
  PollKind,
  PollOptionView,
  PollSettings,
  PollView,
} from "@/types/organizer";
import {
  defaultOptionEnd,
  defaultPollSettings,
  normalizePollKind,
  POLL_MAX_QUESTION,
  POLL_MAX_OPTIONS,
  validatePollDraft,
  yesNoOptions,
} from "@/lib/polls/poll";

export type Unsubscribe = () => void;

// --- Lectura de valores (el jsonb de la RPC llega como `unknown`) -------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry !== "");
}

function toTimestamp(iso: string): Timestamp {
  const date = new Date(iso);
  return Timestamp.fromDate(Number.isNaN(date.getTime()) ? new Date() : date);
}

function toTimestampOrNull(iso: string | null): Timestamp | null {
  if (iso === null) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : Timestamp.fromDate(date);
}

function parseSettings(raw: unknown): PollSettings {
  const base = defaultPollSettings();
  if (!isRecord(raw)) return base;
  const closeBy: PollCloseBy = raw["closeBy"] === "anyone" ? "anyone" : "creator";
  return {
    anonymous: flag(raw["anonymous"], base.anonymous),
    allowSuggestions: flag(raw["allowSuggestions"], base.allowSuggestions),
    remindMissing: flag(raw["remindMissing"], base.remindMissing),
    closeBy,
  };
}

function parseOption(raw: unknown): PollOptionView | null {
  if (!isRecord(raw)) return null;
  const id = text(raw["id"]);
  if (id === "") return null;
  return {
    id,
    text: text(raw["text"]),
    startsAt: toTimestampOrNull(textOrNull(raw["startsAt"])),
    endsAt: toTimestampOrNull(textOrNull(raw["endsAt"])),
    position: count(raw["position"]),
    addedBy: textOrNull(raw["addedBy"]),
    votes: count(raw["votes"]),
    mine: flag(raw["mine"], false),
    voters: idList(raw["voters"]),
    busy: null,
  };
}

/** Traduce el jsonb de `poll_results` al tipo que pinta la tarjeta. */
export function parsePollView(raw: unknown): PollView | null {
  if (!isRecord(raw)) return null;
  const id = text(raw["id"]);
  if (id === "") return null;
  const optionsRaw = Array.isArray(raw["options"]) ? raw["options"] : [];
  const settings = parseSettings(raw["settings"]);
  return {
    id,
    messageId: text(raw["messageId"]),
    workspaceId: text(raw["workspaceId"]),
    chatId: text(raw["chatId"]),
    question: text(raw["question"]),
    kind: normalizePollKind(raw["kind"]),
    settings,
    closesAt: toTimestampOrNull(textOrNull(raw["closesAt"])),
    closedAt: toTimestampOrNull(textOrNull(raw["closedAt"])),
    closedBy: textOrNull(raw["closedBy"]),
    createdBy: textOrNull(raw["createdBy"]),
    createdAt: toTimestamp(text(raw["createdAt"])),
    anonymous: flag(raw["anonymous"], settings.anonymous),
    allowSuggestions: flag(raw["allowSuggestions"], settings.allowSuggestions),
    remindMissing: flag(raw["remindMissing"], settings.remindMissing),
    closeBy: raw["closeBy"] === "anyone" ? "anyone" : "creator",
    isOpen: flag(raw["isOpen"], false),
    canManage: flag(raw["canManage"], false),
    canSuggest: flag(raw["canSuggest"], false),
    options: optionsRaw
      .map(parseOption)
      .filter((option): option is PollOptionView => option !== null),
    maxVotes: count(raw["maxVotes"]),
    winners: idList(raw["winners"]),
    tied: flag(raw["tied"], false),
    totalVotes: count(raw["totalVotes"]),
    membersCount: count(raw["membersCount"]),
    missingCount: count(raw["missingCount"]),
    missing: idList(raw["missing"]),
  };
}

// --- Errores -----------------------------------------------------------------

function errorCode(error: unknown): string {
  return isRecord(error) && typeof error["code"] === "string" ? error["code"] : "";
}

/**
 * Las RPCs de encuestas escriben el motivo en español ("La encuesta ya está
 * cerrada"), así que ese texto se muestra tal cual; los errores internos de
 * Postgres (con código o nombres de objeto) no, y cae el texto genérico.
 */
function pollError(error: unknown, fallback: string): string {
  const code = errorCode(error);
  if (code === "42501") return "No tienes permiso para eso en este chat.";
  if (code === "P0002") return "Esa encuesta ya no existe.";
  const raw = isRecord(error) && typeof error["message"] === "string" ? error["message"].trim() : "";
  if (raw !== "" && raw.length <= 160 && !raw.includes("SQLSTATE") && !raw.includes("pg_")) {
    return raw;
  }
  return fallback;
}

// --- Lectura -----------------------------------------------------------------

/** Estado completo de la encuesta (null si ya no existe). */
export async function fetchPoll(pollId: string): Promise<PollView | null> {
  const { data, error } = await getSupabaseClient().rpc("poll_results", {
    p_poll_id: pollId,
  });
  if (error !== null) {
    if (errorCode(error) === "P0002") return null;
    throw new Error(pollError(error, "No se pudo cargar la encuesta."));
  }
  return parsePollView(data);
}

/**
 * Ocupados por opción (kind 'date'): solo el número, nunca el evento.
 * `null` si la RPC falla (la tarjeta sigue mostrando las barras).
 */
export async function fetchPollBusy(
  pollId: string,
): Promise<Map<string, number> | null> {
  const { data, error } = await getSupabaseClient().rpc("poll_option_busy", {
    p_poll_id: pollId,
  });
  if (error !== null || !isRecord(data)) return null;
  const rows = Array.isArray(data["options"]) ? data["options"] : [];
  const out = new Map<string, number>();
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const id = text(row["id"]);
    if (id !== "") out.set(id, count(row["busy"]));
  }
  return out;
}

// --- Alta --------------------------------------------------------------------

export type CreatedPoll = { messageId: string; pollId: string };

/**
 * Crea la encuesta y su mensaje tarjeta en el chat. El id de la encuesta se
 * genera aquí para que el mensaje nazca con `meta.poll_id` (la tarjeta resuelve
 * sola) y para que el reintento no duplique nada.
 */
export async function createPoll(
  wsId: string,
  chatId: string,
  uid: string,
  authorName: string,
  input: NewPollInput,
): Promise<CreatedPoll> {
  const question = input.question.trim().slice(0, POLL_MAX_QUESTION);
  const validation = validatePollDraft({
    question,
    kind: input.kind,
    settings: input.settings,
    closesAt: input.closesAt,
    options: input.options,
  });
  if (!validation.ok) throw new Error(validation.message);

  const client = getSupabaseClient();
  const pollId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const cardMeta: Json = { kind: "poll", poll_id: pollId };

  const { error: messageError } = await client.from("messages").insert({
    id: messageId,
    workspace_id: wsId,
    chat_id: chatId,
    author_id: uid,
    author_name: authorName,
    text: question,
    type: "card",
    mentions: [],
    meta: cardMeta,
  });
  if (messageError !== null) {
    throw new Error(pollError(messageError, "No se pudo publicar la encuesta."));
  }

  const { error: pollErrorResult } = await client.from("polls").insert({
    id: pollId,
    message_id: messageId,
    workspace_id: wsId,
    chat_id: chatId,
    question,
    kind: input.kind,
    settings: input.settings as unknown as Json,
    closes_at: input.closesAt?.toISOString() ?? null,
    created_by: uid,
  });
  if (pollErrorResult !== null) {
    // El mensaje tarjeta sin encuesta es ruido: se retira en suave (la RLS de
    // messages deja al autor tocar `deleted`).
    await client
      .from("messages")
      .update({ deleted: true, text: "" })
      .eq("id", messageId)
      .then(
        () => undefined,
        () => undefined,
      );
    throw new Error(pollError(pollErrorResult, "No se pudo crear la encuesta."));
  }

  const options = input.kind === "yesno" ? yesNoOptions() : input.options;
  let position = 1024;
  for (const option of options) {
    const label = option.text.trim().slice(0, 200);
    if (label === "") continue;
    const startsAt = option.startsAt?.toISOString() ?? null;
    const endsAt =
      option.endsAt !== null && option.endsAt !== undefined
        ? option.endsAt.toISOString()
        : option.startsAt !== null && option.startsAt !== undefined
          ? defaultOptionEnd(option.startsAt).toISOString()
          : null;
    const { error: optionError } = await client.from("poll_options").insert({
      poll_id: pollId,
      workspace_id: wsId,
      text: label,
      starts_at: startsAt,
      ends_at: endsAt,
      position,
      added_by: uid,
    });
    if (optionError !== null) {
      throw new Error(pollError(optionError, "No se pudieron agregar las opciones."));
    }
    position += 1024;
  }

  return { messageId, pollId };
}

/** Cierra la encuesta a mano (creador, admin o quien diga `closeBy`). */
export async function closePoll(pollId: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc("close_poll", { p_poll_id: pollId });
  if (error !== null) throw new Error(pollError(error, "No se pudo cerrar la encuesta."));
}

/** Vota, cambia o retira el voto (lista vacía). */
export async function castPollVote(
  pollId: string,
  optionIds: string[],
): Promise<void> {
  const { error } = await getSupabaseClient().rpc("cast_poll_vote", {
    p_poll_id: pollId,
    p_option_ids: optionIds,
  });
  if (error !== null) throw new Error(pollError(error, "No se pudo registrar tu voto."));
}

export type UpdatePollPatch = {
  question?: string;
  settings?: PollSettings;
  closesAt?: Date | null;
};

/** Edita la pregunta, los ajustes o el plazo (creador o admin). */
export async function updatePoll(pollId: string, patch: UpdatePollPatch): Promise<void> {
  const data: Database["public"]["Tables"]["polls"]["Update"] = {};
  if (patch.question !== undefined) {
    const question = patch.question.trim().slice(0, POLL_MAX_QUESTION);
    if (question === "") throw new Error("La pregunta no puede quedar vacía.");
    data["question"] = question;
  }
  if (patch.settings !== undefined) data["settings"] = patch.settings as unknown as Json;
  if (patch.closesAt !== undefined) data["closes_at"] = patch.closesAt?.toISOString() ?? null;
  if (Object.keys(data).length === 0) return;
  const { error } = await getSupabaseClient().from("polls").update(data).eq("id", pollId);
  if (error !== null) throw new Error(pollError(error, "No se pudo guardar la encuesta."));
}

/** Borra la encuesta con sus opciones y votos (creador o admin). */
export async function deletePoll(pollId: string): Promise<void> {
  const { error } = await getSupabaseClient().from("polls").delete().eq("id", pollId);
  if (error !== null) throw new Error(pollError(error, "No se pudo borrar la encuesta."));
}

export type NewPollOption = {
  text: string;
  startsAt: Date | null;
  endsAt: Date | null;
};

/** Agrega una opción al final (mismo criterio que los ítems de lista). */
export async function addPollOption(
  pollId: string,
  wsId: string,
  uid: string,
  option: NewPollOption,
): Promise<void> {
  const label = option.text.trim().slice(0, 200);
  if (label === "") throw new Error("La opción no puede quedar vacía.");
  const client = getSupabaseClient();
  const { data: last } = await client
    .from("poll_options")
    .select("position")
    .eq("poll_id", pollId)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  const previous = last === null ? null : Number((last as { position: number }).position);
  const position = previous === null || !Number.isFinite(previous) ? 1024 : previous + 1024;
  const startsAt = option.startsAt?.toISOString() ?? null;
  const endsAt =
    option.endsAt !== null
      ? option.endsAt.toISOString()
      : option.startsAt !== null
        ? defaultOptionEnd(option.startsAt).toISOString()
        : null;
  const { error } = await client.from("poll_options").insert({
    poll_id: pollId,
    workspace_id: wsId,
    text: label,
    starts_at: startsAt,
    ends_at: endsAt,
    position,
    added_by: uid,
  });
  if (error !== null) {
    throw new Error(pollError(error, "No se pudo agregar la opción."));
  }
}

/** Edita el texto o la franja de una opción. */
export async function updatePollOption(
  optionId: string,
  patch: { text?: string; startsAt?: Date | null; endsAt?: Date | null },
): Promise<void> {
  const data: Database["public"]["Tables"]["poll_options"]["Update"] = {};
  if (patch.text !== undefined) {
    const label = patch.text.trim().slice(0, 200);
    if (label === "") throw new Error("La opción no puede quedar vacía.");
    data["text"] = label;
  }
  if (patch.startsAt !== undefined) data["starts_at"] = patch.startsAt?.toISOString() ?? null;
  if (patch.endsAt !== undefined) data["ends_at"] = patch.endsAt?.toISOString() ?? null;
  if (Object.keys(data).length === 0) return;
  const { error } = await getSupabaseClient().from("poll_options").update(data).eq("id", optionId);
  if (error !== null) {
    throw new Error(pollError(error, "No se pudo editar la opción."));
  }
}

/** Quita una opción (sus votos caen en cascada). */
export async function deletePollOption(optionId: string): Promise<void> {
  const { error } = await getSupabaseClient().from("poll_options").delete().eq("id", optionId);
  if (error !== null) throw new Error(pollError(error, "No se pudo quitar la opción."));
}

// --- Realtime -----------------------------------------------------------------

/**
 * Una sola suscripción para las tres tablas de la encuesta: cualquier cambio
 * (voto, opción nueva, cierre) vuelve a pedir `poll_results`, que es la única
 * fuente de la tarjeta. Sin Realtime la tarjeta sigue funcionando (la acción
 * local invalida la query).
 */
export function listenPoll(pollId: string, onChange: () => void): Unsubscribe {
  const supabase = getSupabaseClient();
  let channel: RealtimeChannel;
  try {
    channel = supabase.channel(`loki:poll:${pollId}`);
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "polls", filter: `id=eq.${pollId}` },
      onChange,
    );
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "poll_options", filter: `poll_id=eq.${pollId}` },
      onChange,
    );
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "poll_votes", filter: `poll_id=eq.${pollId}` },
      onChange,
    );
    channel.subscribe();
  } catch {
    // Realtime caído: la tarjeta sigue viva por query.
    return () => undefined;
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    void supabase.removeChannel(channel);
  };
}

/** Tope de opciones expuesto a la UI (mismo que valida el borrador). */
export { POLL_MAX_OPTIONS };

/** Tipos reexportados para no importar de dos lugares en los componentes. */
export type { PollKind, PollSettings, PollView, PollOptionView };
