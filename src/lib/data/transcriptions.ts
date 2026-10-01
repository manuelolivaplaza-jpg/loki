"use client";

/**
 * Transcripciones de audio (`audio_transcriptions`), capa de datos.
 *
 * Flujo completo (por eventos, nada escuchando 24/7):
 *   1. El cliente sube el audio a Storage (`src/lib/media/upload.ts`).
 *   2. Inserta UNA fila pidiendo la transcripción (RLS: tiene que ser miembro
 *      del espacio del archivo, que es el primer segmento de la ruta). El
 *      trigger `audio_transcriptions_enqueue` mete el trabajo en `ai_jobs` y
 *      `wake_ai_worker` despierta a `loki-worker` por pg_net.
 *   3. La UI se entera del fin por Realtime sobre la fila (sin bucles).
 *
 * El mismo camino sirve para "Ver transcripción" (bajo demanda, solo cuando
 * alguien abre) y para "Dictar a Loki" (siempre, porque el texto alimenta el
 * analizador). Nunca hay una llamada bloqueante a un proveedor desde el cliente.
 */

import { getSupabaseClient } from "@/lib/supabase/client";
import { edgeHeaders } from "@/lib/edge";
import type { Database } from "@/types/supabase";

type Row = Database["public"]["Tables"]["audio_transcriptions"]["Row"];

export type TranscriptionStatus = "pending" | "running" | "ready" | "error";

/** Aviso único cuando no hay proveedor de voz a texto configurado. */
export const TRANSCRIPTION_NOT_CONFIGURED = "Transcripción sin configurar";

export type AudioTranscription = {
  id: string;
  workspaceId: string;
  bucket: string;
  /** Ruta en Storage sin el bucket: `{wsId}/{uuid}-{nombre}`. */
  objectPath: string;
  messageId: string | null;
  chatId: string | null;
  text: string;
  language: string;
  durationSeconds: number | null;
  status: TranscriptionStatus;
  provider: string;
  error: string | null;
  createdAt: string;
};

export type RequestTranscriptionInput = {
  workspaceId: string;
  bucket: string;
  objectPath: string;
  /** Mensaje que lleva el audio (hereda su visibilidad). */
  messageId?: string | null;
  chatId?: string | null;
  authorId?: string | null;
  durationSeconds?: number | null;
};

function asStatus(value: string): TranscriptionStatus {
  if (value === "running" || value === "ready" || value === "error") return value;
  return "pending";
}

function toTranscription(row: Row): AudioTranscription {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    bucket: row.bucket,
    objectPath: row.object_path,
    messageId: row.message_id,
    chatId: row.chat_id,
    text: row.text,
    language: row.language,
    durationSeconds: row.duration_seconds,
    status: asStatus(row.status),
    provider: row.provider,
    error: row.error,
    createdAt: row.created_at,
  };
}

const COLUMNS =
  "id, workspace_id, bucket, object_path, message_id, chat_id, requested_by, " +
  "text, language, duration_seconds, status, provider, error, created_at";

/**
 * Estado del proveedor de voz a texto (GET /health de `loki-worker`).
 * Nunca lanza: sin función servida o sin clave, `configured` es false y la UI
 * muestra "Transcripción sin configurar" sin encolar nada.
 */
export type SttHealth = { configured: boolean; provider: string; model: string };

const STT_OFFLINE: SttHealth = { configured: false, provider: "none", model: "" };

let sttPromise: Promise<SttHealth> | null = null;

export async function getSttHealth(): Promise<SttHealth> {
  if (sttPromise !== null) return sttPromise;
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  if (base === "") return STT_OFFLINE;
  sttPromise = (async () => {
    try {
      // Con la apikey publica siempre; ademas el JWT de sesion, porque el
      // gateway de Supabase puede exigirlo tambien en las lecturas.
      const { data } = await getSupabaseClient().auth.getSession();
      const token = data.session?.access_token ?? "";
      const res = await fetch(
        `${base.replace(/\/+$/, "")}/functions/v1/loki-worker`,
        { method: "GET", headers: edgeHeaders(token) },
      );
      if (!res.ok) return STT_OFFLINE;
      const body: unknown = await res.json();
      if (typeof body !== "object" || body === null) return STT_OFFLINE;
      const stt = (body as Record<string, unknown>)["stt"];
      if (typeof stt !== "object" || stt === null) return STT_OFFLINE;
      const rec = stt as Record<string, unknown>;
      return {
        configured: rec["configured"] === true,
        provider: typeof rec["provider"] === "string" ? rec["provider"] : "none",
        model: typeof rec["model"] === "string" ? rec["model"] : "",
      };
    } catch {
      return STT_OFFLINE;
    }
  })();
  return sttPromise;
}

/** ¿Hay transcripción pedida antes para este archivo? (no encola nada) */
export async function findTranscription(
  workspaceId: string,
  objectPath: string,
): Promise<AudioTranscription | null> {
  const { data, error } = await getSupabaseClient()
    .from("audio_transcriptions")
    .select(COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("object_path", objectPath)
    .maybeSingle();
  if (error !== null || data === null) return null;
  return toTranscription(data as Row);
}

/**
 * Pide la transcripción de un audio ya subido. Devuelve la fila creada (o la
 * que ya existía para ese archivo: el índice único lo garantiza). Lanza con
 * mensaje en español si la RLS lo rechaza (típico: ya no eres del espacio).
 */
export async function requestTranscription(
  input: RequestTranscriptionInput,
): Promise<AudioTranscription> {
  const supabase = getSupabaseClient();
  const { data: session } = await supabase.auth.getSession();
  const uid = session.session?.user.id ?? "";
  if (uid === "") throw new Error("Inicia sesión para transcribir.");
  const { data, error } = await supabase
    .from("audio_transcriptions")
    .insert({
      workspace_id: input.workspaceId,
      bucket: input.bucket,
      object_path: input.objectPath,
      message_id: input.messageId ?? null,
      chat_id: input.chatId ?? null,
      author_id: input.authorId ?? null,
      requested_by: uid,
      ...(input.durationSeconds !== undefined && input.durationSeconds !== null
        ? { duration_seconds: input.durationSeconds }
        : {}),
    })
    .select(COLUMNS)
    .single();
  if (error !== null || data === null) {
    // Carrera: otro miembro la pidió primero. Se devuelve la suya.
    const existing = await findTranscription(input.workspaceId, input.objectPath);
    if (existing !== null) return existing;
    throw new Error("No se pudo pedir la transcripción.");
  }
  return toTranscription(data as Row);
}

/** Reintenta una transcripción que falló (RPC: el ciclo no lo mueve el cliente). */
export async function retryTranscription(id: string): Promise<boolean> {
  const { data, error } = await getSupabaseClient().rpc("retry_transcription", {
    p_transcription_id: id,
  });
  if (error !== null) throw new Error("No se pudo reintentar la transcripción.");
  return data === true;
}

export type Unsubscribe = () => void;

function refetch(
  workspaceId: string,
  objectPath: string,
  cb: (row: AudioTranscription | null) => void,
): Promise<void> {
  return findTranscription(workspaceId, objectPath)
    .then(cb)
    .catch(() => undefined);
}

/**
 * Estado de la transcripción de un archivo en vivo, por Realtime (sin bucles):
 * el primer fetch pinta lo que ya había y cada cambio de la fila repinta.
 * Devuelve el `stop` para desuscribirse.
 */
export function listenTranscription(
  workspaceId: string,
  objectPath: string,
  cb: (row: AudioTranscription | null) => void,
): Unsubscribe {
  if (workspaceId === "" || objectPath === "") return () => undefined;
  const supabase = getSupabaseClient();
  // Filtro por el espacio (no por la ruta: lleva `/` y no siempre cabe limpio
  // en el filtro) y se discrimina por object_path al recibir el evento.
  const channel = supabase.channel(`loki:transcription:${workspaceId}`);
  channel.on(
    "postgres_changes",
    {
      event: "*",
      schema: "public",
      table: "audio_transcriptions",
      filter: `workspace_id=eq.${workspaceId}`,
    },
    () => {
      void refetch(workspaceId, objectPath, cb);
    },
  );
  channel.subscribe();
  void refetch(workspaceId, objectPath, cb);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    void supabase.removeChannel(channel);
  };
}

/**
 * Espera a que la transcripción termine (listo o error) sin bucles: se apoya
 * en Realtime y, si el canal no llegara (worker apagado, publicación sin
 * WAL), reintenta con esperas crecientes hasta un tope. Solo con el trabajo
 * en vuelo, nunca 24/7.
 */
export async function waitForTranscription(
  workspaceId: string,
  objectPath: string,
  options: { timeoutMs?: number } = {},
): Promise<AudioTranscription> {
  const timeoutMs = options.timeoutMs ?? 150_000;
  return new Promise<AudioTranscription>((resolve, reject) => {
    let settled = false;
    const ticks: ReturnType<typeof setTimeout>[] = [];
    let stop: Unsubscribe = () => undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const settle = (): void => {
      if (timer !== null) clearTimeout(timer);
      for (const tick of ticks) clearTimeout(tick);
      stop();
    };
    const finish = (row: AudioTranscription): void => {
      if (settled) return;
      settled = true;
      settle();
      resolve(row);
    };
    const fail = (message: string): void => {
      if (settled) return;
      settled = true;
      settle();
      reject(new Error(message));
    };
    const check = (row: AudioTranscription | null): void => {
      if (row === null) return;
      if (row.status === "ready" && row.text !== "") finish(row);
      else if (row.status === "error") fail(row.error ?? "No se pudo transcribir el audio.");
    };

    stop = listenTranscription(workspaceId, objectPath, check);

    // Red de seguridad acotada: si el evento de Realtime no llegara, se
    // vuelve a leer la fila a los 6s, 21s, 51s y 111s (y para ahí).
    let spent = 0;
    for (const wait of [6_000, 15_000, 30_000, 60_000]) {
      if (spent >= timeoutMs) break;
      spent += wait;
      ticks.push(setTimeout(() => refetch(workspaceId, objectPath, check), wait));
    }
    timer = setTimeout(() => {
      fail("La transcripción está tardando mucho. Inténtalo de nuevo en un rato.");
    }, timeoutMs);
  });
}
