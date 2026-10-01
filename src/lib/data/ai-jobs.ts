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
  | "redact_highlights";

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

export type Unsubscribe = () => void;

/** Estado en vivo de un trabajo por Realtime (filtro por id). */
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
