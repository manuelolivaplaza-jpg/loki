"use client";

/**
 * Trabajos de IA (`ai_jobs`): pedir, ver estado en vivo y reintentar.
 * El ciclo (queued→running→done/error) lo mueve la Edge `loki-worker` con la
 * service role; el cliente solo crea (a nombre propio) y lee su espacio.
 * El estado en vivo llega por Realtime sobre la fila, sin bucles.
 */

import { getSupabaseClient } from "@/lib/supabase/client";
import type { Database } from "@/types/supabase";

export type AiJobType =
  | "chat_summary"
  | "day_digest"
  | "transcribe_audio"
  | "ocr_image"
  | "dispatch_agent"
  | "redact_highlights"
  | "chat_digest"
  | "poll_summary"
  | "day_highlights";

export type AiJobStatus = "queued" | "running" | "done" | "error" | "cancelled";

type JobRow = Database["public"]["Tables"]["ai_jobs"]["Row"];

export type AiJob = {
  id: string;
  workspaceId: string;
  requestedBy: string | null;
  type: AiJobType;
  status: AiJobStatus;
  attempts: number;
  error: string | null;
  createdAt: string;
};

function toJob(row: JobRow): AiJob {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    requestedBy: row.requested_by,
    type: row.type as AiJobType,
    status: row.status as AiJobStatus,
    attempts: row.attempts,
    error: row.error,
    createdAt: row.created_at,
  };
}

export async function requestAiJob(
  wsId: string,
  uid: string,
  type: AiJobType,
  payload: Record<string, unknown> = {},
  idempotencyKey?: string,
): Promise<string> {
  const { data, error } = await getSupabaseClient()
    .from("ai_jobs")
    .insert({
      workspace_id: wsId,
      requested_by: uid,
      type,
      payload: payload as Database["public"]["Tables"]["ai_jobs"]["Insert"]["payload"],
      ...(idempotencyKey !== undefined ? { idempotency_key: idempotencyKey } : {}),
    })
    .select("id")
    .single();
  if (error !== null || data === null) {
    throw new Error("No se pudo pedir el trabajo de IA.");
  }
  return (data as { id: string }).id;
}

export async function getAiJob(jobId: string): Promise<AiJob | null> {
  const { data, error } = await getSupabaseClient()
    .from("ai_jobs")
    .select("id, workspace_id, requested_by, type, status, attempts, error, created_at")
    .eq("id", jobId)
    .maybeSingle();
  if (error !== null || data === null) return null;
  return toJob(data as JobRow);
}

export async function retryAiJob(jobId: string): Promise<boolean> {
  const { data, error } = await getSupabaseClient().rpc("retry_ai_job", {
    p_job_id: jobId,
  });
  if (error !== null) {
    throw new Error("No se pudo reintentar el trabajo.");
  }
  return data === true;
}

/** Resultado crudo de un trabajo (para el resumen de no leídos). */
export async function getAiJobResult(jobId: string): Promise<Record<string, unknown> | null> {
  const { data, error } = await getSupabaseClient()
    .from("ai_jobs")
    .select("result")
    .eq("id", jobId)
    .maybeSingle();
  if (error !== null || data === null) return null;
  const result = (data as { result: unknown }).result;
  return typeof result === "object" && result !== null
    ? (result as Record<string, unknown>)
    : null;
}

/** Resumen cacheado por (usuario, chat, último mensaje incluido). */
export async function getCachedChatDigest(
  uid: string,
  wsId: string,
  chatId: string,
): Promise<{ digest: Record<string, unknown>; lastMessageId: string | null } | null> {
  const { data, error } = await getSupabaseClient()
    .from("ai_summaries")
    .select("summary, last_message_id")
    .eq("user_id", uid)
    .eq("chat_key", `${wsId}:${chatId}`)
    .maybeSingle();
  if (error !== null || data === null) return null;
  const row = data as { summary: string; last_message_id: string | null };
  try {
    const digest: unknown = JSON.parse(row.summary);
    if (typeof digest !== "object" || digest === null) return null;
    return { digest: digest as Record<string, unknown>, lastMessageId: row.last_message_id };
  } catch {
    return null;
  }
}

export type Unsubscribe = () => void;

/**
 * Último trabajo de este tipo pedido por esta persona para una encuesta.
 * Evita volver a encolar el mismo resumen (y volver a pagar): si el anterior
 * terminó, se reutiliza su resultado; si está en vuelo, se espera a ese.
 */
export async function findLatestPollSummaryJob(
  wsId: string,
  pollId: string,
  uid: string,
): Promise<AiJob | null> {
  const { data, error } = await getSupabaseClient()
    .from("ai_jobs")
    .select("id, workspace_id, requested_by, type, status, attempts, error, created_at")
    .eq("workspace_id", wsId)
    .eq("type", "poll_summary")
    .eq("requested_by", uid)
    .eq("payload->>poll_id", pollId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error !== null || data === null) return null;
  return toJob(data as JobRow);
}
export function listenAiJob(jobId: string, cb: (job: AiJob | null) => void): Unsubscribe {
  const supabase = getSupabaseClient();
  const channel = supabase.channel(`loki:ai-job:${jobId}`);
  channel.on(
    "postgres_changes",
    { event: "*", schema: "public", table: "ai_jobs", filter: `id=eq.${jobId}` },
    () => {
      void getAiJob(jobId).then(cb).catch(() => undefined);
    },
  );
  channel.subscribe();
  void getAiJob(jobId).then(cb).catch(() => undefined);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    void supabase.removeChannel(channel);
  };
}
