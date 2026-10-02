// =============================================================================
// Trabajadora de IA · Edge Function `loki-worker` (Deno, sin dependencias).
//
// Procesa UN trabajo de `ai_jobs` por llamada: la despierta el trigger
// `wake_ai_worker` (pg_net) o el rescate pg_cron con { job_id }.
//
// Seguridad: exige `Authorization: Bearer <WORKER_KEY>` (secreto del servidor,
// mismo valor que `loki.worker_key` en la base). Sin él, 401: un cliente nunca
// puede invocarla para saltarse cuotas. Rate limit 30 req/min como el resto.
//
// Tipos soportados: chat_summary (modelo barato), day_digest y
// redact_highlights (plantilla determinista + pulido opcional con modelo
// barato), day_highlights ("lo importante de tus espacios" para la vista
// "Tu día": bajo demanda al abrir, modelo barato, cacheado por día en
// ai_summaries con chat_key `day:YYYY-MM-DD`), chat_digest, transcribe_audio (notas de voz bajo demanda),
// ocr_image (texto en imágenes bajo demanda, solo si el espacio lo activó) y
// poll_summary (resumen del resultado de una encuesta, bajo demanda).
// dispatch_agent termina en error claro "no soportado todavía"
// (sin reintentos infinitos).
// Sin LLM_API_KEY: lo que necesita modelo termina en error
// "Loki IA sin configurar", sin reintentar. Para transcribe_audio la clave es
// la de voz a texto (STT_API_KEY) y para ocr_image la de visión (OCR_API_KEY
// o la del LLM): sin ella el trabajo termina como omitido y la UI lo muestra
// tal cual.
//
// Antes de cada llamada al LLM reserva cuota con reserve_ai_quota() (espacio +
// usuario); sin cuota el trabajo termina en error amable. Lo determinista
// (plantillas) no consume cuota.
//
// Reintentos con backoff: error transitorio -> queued con run_after en
// 2^attempts minutos (el rescate pg_cron la vuelve a despertar); al agotar
// max_attempts -> error terminal. Idempotencia: el reclamo es atómico
// (queued -> running solo si sigue queued) y la doble entrega no reprocesa.
// =============================================================================

import { SttError, sttHealth, transcribeAudio } from "../_shared/transcribe.ts";
import { OcrError, extractImageText, isOcrConfigured, ocrHealth } from "../_shared/vision.ts";

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const WORKER_KEY = (Deno.env.get("WORKER_KEY") ?? "").trim();

const PROVIDER = (Deno.env.get("LLM_PROVIDER") ?? "").trim().toLowerCase();
const MODEL = (Deno.env.get("LLM_MODEL") ?? "").trim();
const MODEL_FAST = (Deno.env.get("LLM_MODEL_FAST") ?? "").trim() || MODEL;
const API_KEY = (Deno.env.get("LLM_API_KEY") ?? "").trim();
const BASE_URL = (Deno.env.get("LLM_BASE_URL") ?? "https://api.openai.com/v1").replace(
  /\/+$/,
  "",
);

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, apikey",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

function svcHeaders(): Record<string, string> {
  return {
    apikey: SERVICE_KEY,
    authorization: `Bearer ${SERVICE_KEY}`,
    "content-type": "application/json",
  };
}

// --- Rate limit (igual que loki-chat/push-send) --------------------------------
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, number[]>();

function isRateLimited(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  const ip = forwarded.split(",")[0]?.trim() ||
    (req.headers.get("cf-connecting-ip") ?? "sin-ip");
  const now = Date.now();
  const stamps = (rateBuckets.get(ip) ?? []).filter(
    (stamp) => now - stamp < RATE_LIMIT_WINDOW_MS,
  );
  if (stamps.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(ip, stamps);
    return true;
  }
  stamps.push(now);
  if (rateBuckets.size > 2000) {
    const oldest = rateBuckets.keys().next();
    if (!oldest.done) rateBuckets.delete(oldest.value);
  }
  rateBuckets.set(ip, stamps);
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function llmConfigured(): boolean {
  return API_KEY !== "" &&
    (PROVIDER === "openai" || PROVIDER === "anthropic" || PROVIDER === "gemini");
}

/** Texto corto con el modelo barato (resúmenes, pulidos). */
async function completeFast(system: string, user: string): Promise<string> {
  if (PROVIDER === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL_FAST === "" ? "claude-3-5-haiku-latest" : MODEL_FAST,
        max_tokens: 512,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(`anthropic: HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (!isRecord(body) || !Array.isArray(body["content"])) return "";
    return body["content"]
      .map((b) => isRecord(b) && b["type"] === "text" && typeof b["text"] === "string" ? b["text"] : "")
      .join("");
  }
  if (PROVIDER === "gemini") {
    const model = MODEL_FAST === "" ? "gemini-2.0-flash" : MODEL_FAST;
    const base = BASE_URL === "https://api.openai.com/v1"
      ? "https://generativelanguage.googleapis.com"
      : BASE_URL;
    const res = await fetch(
      `${base}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(API_KEY)}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
        }),
      },
    );
    if (!res.ok) throw new Error(`gemini: HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (!isRecord(body) || !Array.isArray(body["candidates"])) return "";
    const first = body["candidates"][0];
    if (!isRecord(first) || !isRecord(first["content"])) return "";
    const parts = first["content"]["parts"];
    if (!Array.isArray(parts)) return "";
    return parts.map((p) => isRecord(p) && typeof p["text"] === "string" ? p["text"] : "").join("");
  }
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL_FAST === "" ? "gpt-4o-mini" : MODEL_FAST,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 512,
    }),
  });
  if (!res.ok) throw new Error(`openai: HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!isRecord(body) || !Array.isArray(body["choices"])) return "";
  const first = body["choices"][0];
  if (!isRecord(first) || !isRecord(first["message"])) return "";
  const content = first["message"]["content"];
  return typeof content === "string" ? content : "";
}

type Job = {
  id: string;
  workspace_id: string;
  requested_by: string | null;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
};

async function svcGet(path: string): Promise<{ ok: boolean; data: unknown }> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, { headers: svcHeaders() });
    return { ok: res.ok, data: await res.json().catch(() => null) };
  } catch {
    return { ok: false, data: null };
  }
}

async function setJob(
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/ai_jobs?id=eq.${id}`, {
    method: "PATCH",
    headers: svcHeaders(),
    body: JSON.stringify(patch),
  }).catch(() => undefined);
}

/** Reclamo atómico: queued -> running solo si nadie lo tomó. */
async function claimJob(id: string): Promise<Job | null> {
  const res = await svcGet(
    `/ai_jobs?id=eq.${id}&status=eq.queued&select=id,workspace_id,requested_by,type,payload,attempts,max_attempts&limit=1`,
  );
  if (!res.ok || !Array.isArray(res.data)) return null;
  const row = res.data[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  // CAS: solo pasa a running si sigue queued (doble entrega no reprocesa).
  const cas = await fetch(
    `${SUPABASE_URL}/rest/v1/ai_jobs?id=eq.${id}&status=eq.queued`,
    {
      method: "PATCH",
      headers: { ...svcHeaders(), prefer: "return=representation" },
      body: JSON.stringify({ status: "running", started_at: new Date().toISOString() }),
    },
  ).catch(() => null);
  if (cas === null || !cas.ok) return null;
  const updated = (await cas.json().catch(() => [])) as unknown[];
  if (updated.length === 0) return null;
  return {
    id: String(row["id"] ?? id),
    workspace_id: String(row["workspace_id"] ?? ""),
    requested_by: asString(row["requested_by"]),
    type: String(row["type"] ?? ""),
    payload: isRecord(row["payload"]) ? row["payload"] : {},
    attempts: typeof row["attempts"] === "number" ? row["attempts"] : 0,
    max_attempts: typeof row["max_attempts"] === "number" ? row["max_attempts"] : 3,
  };
}

async function finishOk(id: string, result: Record<string, unknown>): Promise<void> {
  await setJob(id, {
    status: "done",
    result,
    error: null,
    finished_at: new Date().toISOString(),
  });
}

async function finishError(id: string, message: string, retryable: boolean, attempts: number, max: number): Promise<void> {
  if (retryable && attempts + 1 < max) {
    const backoffMin = 2 ** attempts;
    await setJob(id, {
      status: "queued",
      attempts: attempts + 1,
      run_after: new Date(Date.now() + backoffMin * 60_000).toISOString(),
      started_at: null,
      error: message,
    });
    return;
  }
  await setJob(id, {
    status: "error",
    attempts: attempts + 1,
    error: message,
    run_after: null,
    finished_at: new Date().toISOString(),
  });
}

async function reserve(
  workspaceId: string,
  userId: string | null,
  jobType: string,
  units: number,
): Promise<{ allowed: boolean; reason: string }> {
  if (userId === null) return { allowed: false, reason: "forbidden" };
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/reserve_ai_quota`, {
      method: "POST",
      headers: svcHeaders(),
      body: JSON.stringify({
        p_workspace_id: workspaceId,
        p_user_id: userId,
        p_job_type: jobType,
        p_units: units,
      }),
    });
    if (!res.ok) return { allowed: true, reason: "ok" };
    const body: unknown = await res.json();
    if (!isRecord(body)) return { allowed: true, reason: "ok" };
    return {
      allowed: body["allowed"] === true,
      reason: typeof body["reason"] === "string" ? body["reason"] : "ok",
    };
  } catch {
    return { allowed: true, reason: "ok" };
  }
}

function quotaMessage(reason: string): string {
  if (reason === "space_daily") return "Este espacio llegó a su límite de IA de hoy.";
  if (reason === "space_monthly") return "Este espacio llegó a su límite de IA del mes.";
  return "Llegaste al límite diario de Loki IA. Vuelve mañana.";
}

async function notifyUser(
  userId: string,
  workspaceId: string | null,
  title: string,
  body: string,
  link: string,
): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/notifications`, {
    method: "POST",
    headers: { ...svcHeaders(), prefer: "resolution=ignore-duplicates" },
    body: JSON.stringify({
      user_id: userId,
      workspace_id: workspaceId,
      type: "ai_alert",
      title: title.slice(0, 120),
      body: body.slice(0, 300),
      link,
      dedupe: `ai-job:${title.slice(0, 40)}:${new Date().toISOString().slice(0, 13)}`,
    }),
  }).catch(() => undefined);
}

async function processChatSummary(job: Job): Promise<Record<string, unknown>> {
  const chatKey = asString(job.payload["chat_key"]) ?? "personal";
  const chatId = asString(job.payload["chat_id"]);
  if (!llmConfigured()) throw Object.assign(new Error("Loki IA sin configurar."), { terminal: true });
  const q = await reserve(job.workspace_id, job.requested_by, "chat_summary", 4);
  if (!q.allowed) throw Object.assign(new Error(quotaMessage(q.reason)), { terminal: true });
  // Historial reciente del chat personal (service role: el worker es backend).
  let lines = "";
  if (chatId !== null) {
    const res = await svcGet(
      `/ai_messages?chat_id=eq.${encodeURIComponent(chatId)}&select=type,content&order=created_at.desc&limit=30`,
    );
    if (res.ok && Array.isArray(res.data)) {
      lines = (res.data as Record<string, unknown>[])
        .reverse()
        .map((m) => `${m["type"] === "assistant" ? "Loki" : "Yo"}: ${String(m["content"] ?? "").slice(0, 300)}`)
        .join("\n");
    }
  }
  if (lines === "") throw Object.assign(new Error("Sin historial para resumir."), { terminal: true });
  const summary = (await completeFast(
    "Resume la conversación en 2 líneas en español, solo lo esencial (temas y decisiones). Sin adornos.",
    lines.slice(0, 6000),
  )).trim();
  if (summary === "") throw new Error("El proveedor no devolvió resumen.");
  const uid = job.requested_by ?? "";
  await fetch(`${SUPABASE_URL}/rest/v1/ai_summaries`, {
    method: "POST",
    headers: { ...svcHeaders(), prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({ user_id: uid, chat_key: chatKey, summary: summary.slice(0, 1000) }),
  }).catch(() => undefined);
  return { chat_key: chatKey, chars: summary.length };
}

async function processDigest(job: Job, highlights: boolean): Promise<Record<string, unknown>> {
  const userId = job.requested_by;
  if (userId === null) throw Object.assign(new Error("Sin usuario."), { terminal: true });
  const ws = job.workspace_id;
  const today = new Date().toISOString().slice(0, 10);
  const tasks = await svcGet(
    `/tasks?workspace_id=eq.${ws}&status=neq.done&select=title,due_at&order=due_at.asc.nullsfirst&limit=10`,
  );
  const events = await svcGet(
    `/events?workspace_id=eq.${ws}&select=title,starts_at&gte=starts_at&order=starts_at.asc&limit=10`,
  );
  const taskList = Array.isArray(tasks.data) ? tasks.data as Record<string, unknown>[] : [];
  const eventList = Array.isArray(events.data) ? events.data as Record<string, unknown>[] : [];
  let body = "";
  if (taskList.length > 0) {
    body += `Tareas abiertas: ${taskList.slice(0, 5).map((t) => `“${String(t["title"] ?? "").slice(0, 60)}”`).join(", ")}. `;
  }
  if (eventList.length > 0) {
    body += `Próximo: “${String(eventList[0]?.["title"] ?? "").slice(0, 60)}”.`;
  }
  if (body === "") body = "Nada pendiente hoy. Buen día para adelantar algo.";
  // Pulido opcional con el barato (plantilla determinista si no hay modelo).
  if (highlights && llmConfigured()) {
    const q = await reserve(ws, userId, "day_digest", 3);
    if (q.allowed) {
      try {
        const polished = (await completeFast(
          "Redacta en 2 líneas en español, tono cercano, los destacados del día a partir de estos datos. Sin adornos.",
          `Tareas: ${JSON.stringify(taskList.slice(0, 8))}. Eventos: ${JSON.stringify(eventList.slice(0, 8))}.`,
        )).trim();
        if (polished !== "") body = polished.slice(0, 300);
      } catch {
        // Se queda la plantilla: el aviso igual sale.
      }
    }
  }
  await notifyUser(userId, ws, "Tu día con Loki", body, "/calendario");
  return { date: today, tasks: taskList.length, events: eventList.length };
}

// -----------------------------------------------------------------------------
// Destacados del día para la vista "Tu día" (bajo demanda, modelo barato).
//
// NO se genera para todos a las 8:00: el cliente encola UN trabajo cuando el
// usuario abre "Tu día" (idempotency_key `day:<uid>:<YYYY-MM-DD>` para no
// pagar dos veces lo mismo). El corpus es determinista y barato: menciones
// al usuario en las últimas 48 h + mensajes recientes de sus espacios
// (chats grupales; los DMs ajenos quedan fuera porque solo se leen espacios
// donde el usuario es miembro y chats grupales). Los recuerdos sensibles
// nunca entran (no se consultan aquí).
//
// Sin LLM: el detalle determinista ES la respuesta (la UI muestra todo lo
// demás igual y la nota "Destacados con IA no disponibles"). Con modelo: se
// reserva cuota del espacio ANTES de llamar y se guarda un resumen corto.
// El resultado queda cacheado por día en `ai_summaries`
// (`chat_key = 'day:YYYY-MM-DD'`), que el cliente lee sin encolar de nuevo.
// -----------------------------------------------------------------------------
async function processDayHighlights(job: Job): Promise<Record<string, unknown>> {
  const target = asString(job.payload["user_id"]) ?? job.requested_by;
  if (target === null) throw Object.assign(new Error("Sin usuario."), { terminal: true });
  const day = asString(job.payload["date"]) ?? new Date().toISOString().slice(0, 10);
  const chatKey = `day:${day}`;

  // Cache por día: si ya se generó hoy, se reutiliza sin gastar nada.
  const cached = await svcGet(
    `/ai_summaries?user_id=eq.${encodeURIComponent(target)}&chat_key=eq.${encodeURIComponent(chatKey)}&select=summary&limit=1`,
  );
  if (cached.ok && Array.isArray(cached.data) && cached.data.length > 0) {
    return { date: day, cached: true };
  }

  // Espacios del usuario (service role, pero verificados: solo sus espacios).
  const members = await svcGet(
    `/workspace_members?user_id=eq.${encodeURIComponent(target)}&select=workspace_id&limit=30`,
  );
  const wsIds: string[] = members.ok && Array.isArray(members.data)
    ? (members.data as Record<string, unknown>[])
      .map((m) => String(m["workspace_id"] ?? ""))
      .filter((id) => id !== "")
    : [];
  if (wsIds.length === 0) {
    return { date: day, empty: true, deterministic: true, detail: "" };
  }
  const wsFilter = wsIds.map((id) => encodeURIComponent(id)).join(",");
  const since = new Date(Date.now() - 48 * 3600_000).toISOString();

  // Menciones a ti (48 h) + mensajes recientes de grupos (24 h, tope 30).
  const [mentions, recent] = await Promise.all([
    svcGet(
      `/messages?workspace_id=in.(${wsFilter})&created_at=gte.${encodeURIComponent(since)}` +
      `&deleted=is.false&mentions=cs.{${encodeURIComponent(target)}}` +
      `&select=workspace_id,chat_id,author_name,text,created_at&order=created_at.desc&limit=10`,
    ),
    svcGet(
      `/messages?workspace_id=in.(${wsFilter})&created_at=gte.${encodeURIComponent(new Date(Date.now() - 24 * 3600_000).toISOString())}` +
      `&deleted=is.false&thread_parent_id=is.null&type=in.(user,post,card)` +
      `&select=workspace_id,author_name,text,created_at&order=created_at.desc&limit=30`,
    ),
  ]);
  const mentionRows = mentions.ok && Array.isArray(mentions.data)
    ? (mentions.data as Record<string, unknown>[]).filter(isRecord)
    : [];
  const recentRows = recent.ok && Array.isArray(recent.data)
    ? (recent.data as Record<string, unknown>[]).filter(isRecord)
    : [];

  const lines: string[] = [];
  for (const m of mentionRows.slice(0, 10)) {
    lines.push(
      `Te mencionó ${String(m["author_name"] ?? "Alguien").slice(0, 40)}: ${String(m["text"] ?? "").slice(0, 200)}`,
    );
  }
  if (recentRows.length > 0) {
    lines.push(
      `${recentRows.length} mensajes en tus espacios en las últimas 24 h.`,
    );
  }
  const detail = lines.join("\n").slice(0, 1500);
  if (lines.length === 0) {
    await fetch(`${SUPABASE_URL}/rest/v1/ai_summaries`, {
      method: "POST",
      headers: { ...svcHeaders(), prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ user_id: target, chat_key: chatKey, summary: JSON.stringify({ empty: true }) }),
    }).catch(() => undefined);
    return { date: day, empty: true, deterministic: true, detail: "" };
  }

  // Sin modelo: el detalle determinista es la respuesta (sin gastar cuota).
  if (!llmConfigured()) {
    await fetch(`${SUPABASE_URL}/rest/v1/ai_summaries`, {
      method: "POST",
      headers: { ...svcHeaders(), prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        user_id: target,
        chat_key: chatKey,
        summary: JSON.stringify({ deterministic: true, detail }),
      }),
    }).catch(() => undefined);
    return { date: day, deterministic: true, detail, mentions: mentionRows.length };
  }

  const quota = await reserve(
    job.workspace_id,
    target,
    "day_highlights",
    Math.max(2, Math.ceil(detail.length / 250)),
  );
  if (!quota.allowed) {
    throw Object.assign(new Error(quotaMessage(quota.reason)), { terminal: true });
  }
  const summary = (await completeFast(
    "Resume en español, máximo 5 líneas y sin adornos, lo importante de estas " +
    "novedades de los espacios del usuario (menciones a él primero, después " +
    "lo demás). No inventes datos: usa solo lo dado.",
    detail.slice(0, 6000),
  )).trim();
  const body = summary !== "" ? summary.slice(0, 1200) : detail;
  await fetch(`${SUPABASE_URL}/rest/v1/ai_summaries`, {
    method: "POST",
    headers: { ...svcHeaders(), prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      user_id: target,
      chat_key: chatKey,
      summary: JSON.stringify({ deterministic: summary === "", detail, summary: body }),
    }),
  }).catch(() => undefined);
  return { date: day, deterministic: summary === "", mentions: mentionRows.length, summary: body.slice(0, 300) };
}

async function processJob(job: Job): Promise<Record<string, unknown>> {  switch (job.type) {
    case "chat_summary":
      return processChatSummary(job);
    case "day_digest":
    case "redact_highlights":
      return processDigest(job, job.type === "redact_highlights");
    case "day_highlights":
      return processDayHighlights(job);
    case "chat_digest":
      return processChatDigest(job);
    case "transcribe_audio":
      return processTranscribe(job);
    case "ocr_image":
      return processOcr(job);
    case "poll_summary":
      return processPollSummary(job);
    case "dispatch_agent":
      throw Object.assign(
        new Error(`El trabajo ${job.type} aún no está soportado.`),
        { terminal: true },
      );
    default:
      throw Object.assign(new Error("Tipo de trabajo desconocido."), { terminal: true });
  }
}

// -----------------------------------------------------------------------------
// Transcripción de notas de voz (bajo demanda).
//
// El cliente NO manda el audio: solo pide la transcripción de una fila de
// `audio_transcriptions` (con la ruta `{workspace_id}/...` que ya vive en el
// bucket). Aquí se descarga con la service role (permisos de servidor), se
// manda al proveedor de voz a texto y se guarda el texto.
//
// Seguridad, en este orden y sin saltarse nada:
//   1. La fila tiene que existir y pedirla tiene que ser del mismo espacio.
//   2. Si tiene message_id, el chat tiene que existir y, si es DM, quien lo
//      pidió tiene que estar en member_ids (misma regla que can_access_chat).
//   3. Cuota del espacio ANTES de bajar el audio: si el espacio llegó a su
//      límite, el trabajo termina con error y el audio no sale del servidor.
// -----------------------------------------------------------------------------

type TranscriptionRow = {
  id: string;
  workspace_id: string;
  bucket: string;
  object_path: string;
  message_id: string | null;
  chat_id: string | null;
  requested_by: string | null;
  status: string;
  duration_seconds: number | null;
};

/** Nombre con extensión deducido de la ruta (el multipart lo exige). */
function audioFileName(objectPath: string, mime: string): string {
  const base = objectPath.split("/").pop() ?? "nota-de-voz";
  const clean = base.replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80);
  const hasExt = /\.[A-Za-z0-9]{2,5}$/.test(clean);
  if (hasExt) return clean;
  if (mime.includes("mp4") || mime.includes("aac") || mime.includes("m4a")) {
    return `${clean}.m4a`;
  }
  if (mime.includes("mpeg") || mime.includes("mp3")) return `${clean}.mp3`;
  if (mime.includes("wav")) return `${clean}.wav`;
  if (mime.includes("ogg")) return `${clean}.ogg`;
  if (mime.includes("flac")) return `${clean}.flac`;
  return `${clean}.webm`;
}

/** MIME por extension, para cuando Storage devuelve octet-stream. */
const MIME_BY_EXT: Readonly<Record<string, string>> = {
  webm: "audio/webm",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  mp3: "audio/mpeg",
  mpga: "audio/mpeg",
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  flac: "audio/flac",
};

/** MIME utilizable: el que dice Storage y, si no sirve, el de la extension. */
function usableMime(stored: string, fileName: string): string {
  const mime = stored.split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime.startsWith("audio/")) return stored;
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const byExt = MIME_BY_EXT[ext];
  // Sin nada reconocible, webm es lo que produce MediaRecorder en Chrome y
  // en Android (y lo que aceptan los dos proveedores soportados).
  return byExt ?? "audio/webm";
}

/** Descarga el audio con la service role (permisos de servidor). */
async function downloadAudio(
  bucket: string,
  objectPath: string,
): Promise<{ bytes: ArrayBuffer; mime: string } | null> {
  const encoded = objectPath.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${encoded}`, {
    // Sin content-type application/json: esto es una descarga, no un JSON.
    headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new SttError(
      "download",
      `No se pudo descargar el audio (HTTP ${res.status}).`,
      res.status >= 500,
    );
  }
  return {
    bytes: await res.arrayBuffer(),
    mime: res.headers.get("content-type") ?? "",
  };
}

async function loadTranscription(id: string): Promise<TranscriptionRow | null> {
  const res = await svcGet(
    `/audio_transcriptions?id=eq.${encodeURIComponent(id)}&select=id,workspace_id,bucket,object_path,message_id,chat_id,requested_by,status,duration_seconds&limit=1`,
  );
  if (!res.ok || !Array.isArray(res.data)) return null;
  const row = res.data[0];
  if (!isRecord(row)) return null;
  return {
    id: String(row["id"] ?? id),
    workspace_id: String(row["workspace_id"] ?? ""),
    bucket: String(row["bucket"] ?? "chat-media"),
    object_path: String(row["object_path"] ?? ""),
    message_id: asString(row["message_id"]),
    chat_id: asString(row["chat_id"]),
    requested_by: asString(row["requested_by"]),
    status: String(row["status"] ?? ""),
    duration_seconds: typeof row["duration_seconds"] === "number" ? row["duration_seconds"] : null,
  };
}

/** Marca la fila (service role) y avisa a la UI por Realtime. */
async function saveTranscription(
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/audio_transcriptions?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: svcHeaders(),
    body: JSON.stringify(patch),
  }).catch(() => undefined);
}

async function processTranscribe(job: Job): Promise<Record<string, unknown>> {
  const transcriptionId = asString(job.payload["transcription_id"]);
  if (transcriptionId === null) {
    throw Object.assign(new Error("Sin transcripción que hacer."), { terminal: true });
  }
  const row = await loadTranscription(transcriptionId);
  if (row === null) {
    throw Object.assign(new Error("La transcripción ya no existe."), { terminal: true });
  }
  if (row.status === "ready") {
    return { transcription_id: row.id, cached: true };
  }
  // El espacio de la fila manda: el job y la transcripción son del mismo.
  const ws = row.workspace_id !== "" ? row.workspace_id : job.workspace_id;
  const uid = row.requested_by ?? job.requested_by;

  // --- 1. Membresía del espacio ---
  if (uid === null) {
    await saveTranscription(row.id, { status: "error", error: "Sin usuario que lo pidió." });
    throw Object.assign(new Error("Sin usuario que pidió la transcripción."), { terminal: true });
  }
  const member = await svcGet(
    `/workspace_members?workspace_id=eq.${encodeURIComponent(ws)}&user_id=eq.${encodeURIComponent(uid)}&select=user_id&limit=1`,
  );
  if (!member.ok || !Array.isArray(member.data) || member.data.length === 0) {
    await saveTranscription(row.id, {
      status: "error",
      error: "Ya no tienes acceso a este espacio.",
    });
    throw Object.assign(new Error("Sin acceso al espacio."), { terminal: true });
  }

  // --- 2. Visibilidad heredada del mensaje (DMs incluidos) ---
  if (row.message_id !== null) {
    const chatId = row.chat_id;
    if (chatId === null) {
      await saveTranscription(row.id, { status: "error", error: "Transcripción sin chat." });
      throw Object.assign(new Error("Transcripción sin chat."), { terminal: true });
    }
    const chat = await svcGet(
      `/chats?workspace_id=eq.${encodeURIComponent(ws)}&id=eq.${encodeURIComponent(chatId)}&select=type,member_ids&limit=1`,
    );
    const chatRow =
      chat.ok && Array.isArray(chat.data) && isRecord(chat.data[0]) ? chat.data[0] : null;
    if (chatRow === null) {
      await saveTranscription(row.id, {
        status: "error",
        error: "El chat ya no existe.",
      });
      throw Object.assign(new Error("Chat no encontrado."), { terminal: true });
    }
    if (chatRow["type"] === "dm") {
      const ids = Array.isArray(chatRow["member_ids"]) ? chatRow["member_ids"] : [];
      if (!ids.includes(uid)) {
        await saveTranscription(row.id, {
          status: "error",
          error: "Ya no tienes acceso a este chat.",
        });
        throw Object.assign(new Error("Sin acceso a ese chat."), { terminal: true });
      }
    }
  }

  // --- 3. Cuota ANTES de bajar el audio ---
  // 1 unidad ≈ 1 minuto de audio (mínimo 1). Si no hay cuota, el audio no sale
  // del servidor: se avisa en la transcripción y en el aviso al usuario.
  const minutes = Math.max(1, Math.ceil((row.duration_seconds ?? 60) / 60));
  const q = await reserve(ws, uid, "transcribe_audio", minutes);
  if (!q.allowed) {
    const message = quotaMessage(q.reason);
    await saveTranscription(row.id, { status: "error", error: message });
    await notifyUser(uid, ws, "Transcripción sin hacer", message, "/chat/loki-ia");
    throw Object.assign(new Error(message), { terminal: true });
  }

  await saveTranscription(row.id, { status: "running", error: null });

  // --- 4. Descarga con permisos de servidor ---
  const objectPath = row.object_path;
  // El CHECK de la tabla ata el primer segmento al workspace, pero el worker
  // también lo comprueba: nada de bajar rutas de otros espacios.
  if (!objectPath.startsWith(`${ws}/`)) {
    await saveTranscription(row.id, {
      status: "error",
      error: "El audio no pertenece a este espacio.",
    });
    throw Object.assign(
      new Error("El audio no pertenece a este espacio."),
      { terminal: true },
    );
  }
  let bytes: ArrayBuffer;
  let mime: string;
  const fileName = audioFileName(objectPath, row.bucket);
  try {
    const file = await downloadAudio(row.bucket, objectPath);
    if (file === null) {
      await saveTranscription(row.id, {
        status: "error",
        error: "El audio ya no está en el almacenamiento.",
      });
      throw Object.assign(new Error("Audio no encontrado."), { terminal: true });
    }
    bytes = file.bytes;
    mime = usableMime(file.mime, fileName);
  } catch (error) {
    if (error instanceof SttError) {
      await saveTranscription(row.id, { status: "error", error: error.message });
      throw Object.assign(new Error(error.message), {
        terminal: !error.retryable,
        sttRetryable: error.retryable,
      });
    }
    if (isRecord(error) && (error as { terminal?: unknown }).terminal === true) {
      throw error;
    }
    const message = "No se pudo descargar el audio.";
    await saveTranscription(row.id, { status: "error", error: message });
    throw Object.assign(new Error(message), { terminal: true });
  }

  // --- 5. Transcripción ---
  try {
    const result = await transcribeAudio({
      bytes,
      mimeType: mime,
      filename: fileName,
      language: "es",
      durationSeconds: row.duration_seconds,
    });
    await saveTranscription(row.id, {
      status: "ready",
      text: result.text.slice(0, 16000),
      language: result.language.slice(0, 16),
      provider: result.provider.slice(0, 40),
      error: null,
    });
    return { transcription_id: row.id, chars: result.text.length, provider: result.provider };
  } catch (error) {
    const message =
      error instanceof SttError
        ? error.message
        : error instanceof Error
          ? error.message
          : "No se pudo transcribir el audio.";
    // Sin config o sin voz: no reintentar (repetir da lo mismo). Un fallo de
    // red o del proveedor sí se reintenta con backoff.
    const retryable = error instanceof SttError
      ? error.retryable
      : /HTTP 5|fetch failed|network/i.test(message);
    await saveTranscription(row.id, { status: "error", error: message });
    throw Object.assign(new Error(message), { terminal: !retryable, sttRetryable: retryable });
  }
}

// -----------------------------------------------------------------------------
// Texto en imágenes (OCR bajo demanda, solo si el espacio lo activó).
//
// El cliente NO manda la imagen: el trigger `enqueue_image_ocr` ya dejó el
// trabajo `ocr_image` con el id de la fila de `message_attachments`. Aquí se
// descarga con la service role, se lee el texto con el modelo de visión y se
// guarda indexado para la búsqueda.
//
// Seguridad, en este orden y sin saltarse nada (igual que la transcripción):
//   1. La fila tiene que existir.
//   2. Quien la pidió (el autor del mensaje) sigue siendo miembro y, si el
//      chat es DM, sigue estando en member_ids.
//   3. Cuota del espacio ANTES de bajar la imagen.
// Sin visión configurada la imagen queda `skipped` (se encuentra por nombre).
// -----------------------------------------------------------------------------

type AttachmentRow = {
  id: string;
  workspace_id: string;
  bucket: string;
  object_path: string;
  chat_id: string;
  message_id: string;
  mime: string;
  author_id: string | null;
  ocr_status: string;
};

/** Descarga un objeto con la service role (permisos de servidor). */
async function downloadObject(
  bucket: string,
  objectPath: string,
): Promise<{ bytes: ArrayBuffer; mime: string } | null> {
  const encoded = objectPath.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${encoded}`, {
    headers: { apikey: SERVICE_KEY, authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new OcrError(
      "download",
      `No se pudo descargar la imagen (HTTP ${res.status}).`,
      res.status >= 500,
    );
  }
  return {
    bytes: await res.arrayBuffer(),
    mime: res.headers.get("content-type") ?? "",
  };
}

async function loadAttachment(id: string): Promise<AttachmentRow | null> {
  const res = await svcGet(
    `/message_attachments?id=eq.${encodeURIComponent(id)}&select=id,workspace_id,bucket,object_path,chat_id,message_id,mime,author_id,ocr_status&limit=1`,
  );
  if (!res.ok || !Array.isArray(res.data)) return null;
  const row = res.data[0];
  if (!isRecord(row)) return null;
  const objectPath = asString(row["object_path"]);
  const bucket = asString(row["bucket"]);
  if (objectPath === null || bucket === null) return null;
  return {
    id: String(row["id"] ?? id),
    workspace_id: String(row["workspace_id"] ?? ""),
    bucket,
    object_path: objectPath,
    chat_id: String(row["chat_id"] ?? ""),
    message_id: String(row["message_id"] ?? ""),
    mime: String(row["mime"] ?? ""),
    author_id: asString(row["author_id"]),
    ocr_status: String(row["ocr_status"] ?? ""),
  };
}

/** Marca la fila del índice (service role). Sin trigger de UPDATE: no recursa. */
async function saveAttachment(
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/message_attachments?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: svcHeaders(),
    body: JSON.stringify(patch),
  }).catch(() => undefined);
}

async function processOcr(job: Job): Promise<Record<string, unknown>> {
  const attachmentId = asString(job.payload["attachment_id"]);
  if (attachmentId === null) {
    throw Object.assign(new Error("Sin imagen que leer."), { terminal: true });
  }
  const row = await loadAttachment(attachmentId);
  if (row === null) {
    throw Object.assign(new Error("El adjunto ya no existe."), { terminal: true });
  }
  if (row.ocr_status === "ready") {
    return { attachment_id: row.id, cached: true };
  }
  const ws = row.workspace_id !== "" ? row.workspace_id : job.workspace_id;
  const uid = row.author_id ?? job.requested_by;
  if (uid === null) {
    await saveAttachment(row.id, { ocr_status: "skipped" });
    throw Object.assign(new Error("Sin usuario al que cargarle el OCR."), { terminal: true });
  }

  // --- 1. Membresía del espacio ---
  const member = await svcGet(
    `/workspace_members?workspace_id=eq.${encodeURIComponent(ws)}&user_id=eq.${encodeURIComponent(uid)}&select=user_id&limit=1`,
  );
  if (!member.ok || !Array.isArray(member.data) || member.data.length === 0) {
    await saveAttachment(row.id, { ocr_status: "skipped" });
    throw Object.assign(new Error("Sin acceso al espacio."), { terminal: true });
  }

  // --- 2. Visibilidad heredada del mensaje (DMs incluidos) ---
  const chat = await svcGet(
    `/chats?workspace_id=eq.${encodeURIComponent(ws)}&id=eq.${encodeURIComponent(row.chat_id)}&select=type,member_ids&limit=1`,
  );
  const chatRow =
    chat.ok && Array.isArray(chat.data) && isRecord(chat.data[0]) ? chat.data[0] : null;
  if (chatRow === null) {
    await saveAttachment(row.id, { ocr_status: "skipped" });
    throw Object.assign(new Error("Chat no encontrado."), { terminal: true });
  }
  if (chatRow["type"] === "dm") {
    const ids = Array.isArray(chatRow["member_ids"]) ? chatRow["member_ids"] : [];
    if (!ids.includes(uid)) {
      await saveAttachment(row.id, { ocr_status: "skipped" });
      throw Object.assign(new Error("Sin acceso a ese chat."), { terminal: true });
    }
  }
  if (!row.object_path.startsWith(`${ws}/`)) {
    await saveAttachment(row.id, { ocr_status: "skipped" });
    throw Object.assign(
      new Error("La imagen no pertenece a este espacio."),
      { terminal: true },
    );
  }

  // --- 3. Cuota ANTES de bajar la imagen (texto fijo: 2 unidades) ---
  const q = await reserve(ws, uid, "ocr_image", 2);
  if (!q.allowed) {
    const message = quotaMessage(q.reason);
    await saveAttachment(row.id, { ocr_status: "error" });
    await notifyUser(uid, ws, "Texto en imagen sin leer", message, "/chat/loki-ia");
    throw Object.assign(new Error(message), { terminal: true });
  }

  // --- 4. Sin visión configurada no se gasta nada: por nombre no más ---
  if (!isOcrConfigured()) {
    await saveAttachment(row.id, { ocr_status: "skipped" });
    throw Object.assign(new Error("OCR sin configurar."), { terminal: true });
  }

  // --- 5. Descarga con permisos de servidor ---
  let bytes: ArrayBuffer;
  let mime: string;
  try {
    const file = await downloadObject(row.bucket, row.object_path);
    if (file === null) {
      await saveAttachment(row.id, { ocr_status: "error" });
      throw Object.assign(new Error("Imagen no encontrada."), { terminal: true });
    }
    bytes = file.bytes;
    // Storage puede devolver octet-stream: el MIME que declaró la subida
    // (file.type del cliente) manda si el guardado no parece imagen.
    mime = file.mime.toLowerCase().startsWith("image/") ? file.mime : row.mime;
  } catch (error) {
    if (error instanceof OcrError) {
      await saveAttachment(row.id, { ocr_status: "error" });
      throw Object.assign(new Error(error.message), {
        terminal: !error.retryable,
        ocrRetryable: error.retryable,
      });
    }
    if (isRecord(error) && (error as { terminal?: unknown }).terminal === true) {
      throw error;
    }
    await saveAttachment(row.id, { ocr_status: "error" });
    throw Object.assign(new Error("No se pudo descargar la imagen."), { terminal: true });
  }

  // --- 6. Extracción (una imagen sin texto devuelve "" y queda lista) ---
  try {
    const result = await extractImageText({ bytes, mimeType: mime });
    await saveAttachment(row.id, {
      ocr_status: "ready",
      ocr_text: result.text.slice(0, 8000),
    });
    return { attachment_id: row.id, chars: result.text.length, provider: result.provider };
  } catch (error) {
    const message =
      error instanceof OcrError
        ? error.message
        : error instanceof Error
          ? error.message
          : "No se pudo leer el texto de la imagen.";
    const retryable = error instanceof OcrError
      ? error.retryable
      : /HTTP 5|fetch failed|network/i.test(message);
    // Sin config a mitad de camino (clave revocada): omitir, no reintentar.
    const skipped = error instanceof OcrError && error.code === "not_configured";
    await saveAttachment(row.id, { ocr_status: skipped ? "skipped" : "error" });
    throw Object.assign(new Error(message), { terminal: !retryable || skipped, ocrRetryable: retryable && !skipped });
  }
}

// -----------------------------------------------------------------------------
// Resumen del resultado de una encuesta (bajo demanda, modelo barato).
//
// El resultado se arma con SQL (determinista): opciones, votos, ganador o
// empate. Solo si hay modelo se le pide un lectura en prosa de ESE resultado
// más las opiniones del hilo (los comentarios del mensaje tarjeta), con la
// cuota del espacio reservada antes de llamar. En las anónimas el resumen no
// nombra a nadie: los votos se cuentan, no se atribuyen.
// -----------------------------------------------------------------------------

type PollSummaryRow = {
  id: string;
  workspace_id: string;
  chat_id: string;
  message_id: string;
  question: string;
  kind: string;
  closed_at: string | null;
  settings: Record<string, unknown>;
};

function pollFlag(settings: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = settings[key];
  return typeof value === "boolean" ? value : fallback;
}

async function loadPoll(pollId: string): Promise<PollSummaryRow | null> {
  const res = await svcGet(
    `/polls?id=eq.${encodeURIComponent(pollId)}` +
    `&select=id,workspace_id,chat_id,message_id,question,kind,closed_at,settings&limit=1`,
  );
  if (!res.ok || !Array.isArray(res.data)) return null;
  const row = res.data[0];
  if (!isRecord(row)) return null;
  return {
    id: String(row["id"] ?? pollId),
    workspace_id: String(row["workspace_id"] ?? ""),
    chat_id: String(row["chat_id"] ?? ""),
    message_id: String(row["message_id"] ?? ""),
    question: String(row["question"] ?? "").slice(0, 200),
    kind: String(row["kind"] ?? "single"),
    closed_at: typeof row["closed_at"] === "string" ? row["closed_at"] : null,
    settings: isRecord(row["settings"]) ? (row["settings"] as Record<string, unknown>) : {},
  };
}

async function processPollSummary(job: Job): Promise<Record<string, unknown>> {
  const pollId = asString(job.payload["poll_id"]);
  if (pollId === null) {
    throw Object.assign(new Error("Sin encuesta que resumir."), { terminal: true });
  }
  const poll = await loadPoll(pollId);
  if (poll === null) {
    throw Object.assign(new Error("La encuesta ya no existe."), { terminal: true });
  }
  // El espacio de la encuesta manda: el trabajo y la encuesta son del mismo.
  const ws = poll.workspace_id !== "" ? poll.workspace_id : job.workspace_id;
  const uid = job.requested_by;
  if (uid === null) {
    throw Object.assign(new Error("Sin usuario que lo pidió."), { terminal: true });
  }

  // Membresía del espacio y del chat (en un DM, solo sus miembros).
  const member = await svcGet(
    `/workspace_members?workspace_id=eq.${encodeURIComponent(ws)}` +
    `&user_id=eq.${encodeURIComponent(uid)}&select=user_id&limit=1`,
  );
  if (!member.ok || !Array.isArray(member.data) || member.data.length === 0) {
    throw Object.assign(new Error("Sin acceso al espacio."), { terminal: true });
  }
  const chat = await svcGet(
    `/chats?workspace_id=eq.${encodeURIComponent(ws)}` +
    `&id=eq.${encodeURIComponent(poll.chat_id)}&select=id,type,member_ids&limit=1`,
  );
  const chatRow = chat.ok && Array.isArray(chat.data) && isRecord(chat.data[0])
    ? chat.data[0]
    : null;
  if (chatRow === null) {
    throw Object.assign(new Error("El chat ya no existe."), { terminal: true });
  }
  if (chatRow["type"] === "dm") {
    const ids = Array.isArray(chatRow["member_ids"]) ? chatRow["member_ids"] : [];
    if (!ids.includes(uid)) {
      throw Object.assign(new Error("Sin acceso a ese chat."), { terminal: true });
    }
  }

  // --- Resultado con SQL (sin IA) ---
  const optionsRes = await svcGet(
    `/poll_options?poll_id=eq.${encodeURIComponent(poll.id)}` +
    `&select=id,text,starts_at,ends_at,position&order=position.asc&limit=20`,
  );
  const optionRows = optionsRes.ok && Array.isArray(optionsRes.data)
    ? (optionsRes.data as Record<string, unknown>[]).filter(isRecord)
    : [];
  const votesRes = await svcGet(
    `/poll_votes?poll_id=eq.${encodeURIComponent(poll.id)}&select=option_id,user_id&limit=500`,
  );
  const voteRows = votesRes.ok && Array.isArray(votesRes.data)
    ? (votesRes.data as Record<string, unknown>[]).filter(isRecord)
    : [];
  const voters = new Set(voteRows.map((v) => String(v["user_id"] ?? "")).filter((id) => id !== ""));

  const lines: string[] = [];
  let max = 0;
  for (const option of optionRows) {
    const text = String(option["text"] ?? "").slice(0, 80);
    const id = String(option["id"] ?? "");
    const count = voteRows.filter((v) => String(v["option_id"] ?? "") === id).length;
    if (count > max) max = count;
    const when = typeof option["starts_at"] === "string"
      ? ` (${option["starts_at"]})`
      : "";
    lines.push(`- ${text}${when}: ${count} ${count === 1 ? "voto" : "votos"}`);
  }
  const tied = max > 0 && optionRows.filter((o) => {
    const id = String(o["id"] ?? "");
    return voteRows.filter((v) => String(v["option_id"] ?? "") === id).length === max;
  }).length > 1;
  const winner = tied
    ? null
    : (optionRows.find((o) => {
      const id = String(o["id"] ?? "");
      return voteRows.filter((v) => String(v["option_id"] ?? "") === id).length === max;
    }) ?? null);

  // Opiniones del hilo: los comentarios del mensaje tarjeta.
  const threadRes = await svcGet(
    `/messages?workspace_id=eq.${encodeURIComponent(ws)}` +
    `&thread_parent_id=eq.${encodeURIComponent(poll.message_id)}` +
    `&deleted=is.false&select=author_name,text&order=created_at.asc&limit=20`,
  );
  const comments = threadRes.ok && Array.isArray(threadRes.data)
    ? (threadRes.data as Record<string, unknown>[])
      .filter(isRecord)
      .map((m) => `${String(m["author_name"] ?? "").slice(0, 40)}: ${String(m["text"] ?? "").slice(0, 300)}`)
      .filter((line) => !line.endsWith(": "))
    : [];

  const resultLines = [
    `Pregunta: ${poll.question}`,
    `Tipo: ${poll.kind}`,
    pollFlag(poll.settings, "anonymous", false) ? "Anónima: no se sabe quién votó" : "",
    `Estado: ${poll.closed_at === null ? "abierta" : "cerrada"}`,
    `Votos: ${voters.size}`,
    ...lines,
    winner === null
      ? (max === 0 ? "Sin votos todavía." : "Empate: decide quien creó la encuesta.")
      : `Ganó: ${String(winner["text"] ?? "").slice(0, 80)} con ${max} ${max === 1 ? "voto" : "votos"}.`,
  ];
  if (comments.length > 0) {
    resultLines.push("Opiniones del hilo:", ...comments.map((line) => `- ${line}`));
  }
  const corpus = resultLines.filter((line) => line !== "").join("\n");

  // Sin modelo: el resultado determinista ES la respuesta (la UI lo muestra
  // igual y no se gasta nada). Con modelo: una lectura corta encima.
  if (!llmConfigured()) {
    return {
      poll_id: poll.id,
      kind: poll.kind,
      votes: voters.size,
      winner: winner === null ? null : String(winner["text"] ?? "").slice(0, 80),
      tied,
      summary: "",
      detail: corpus.slice(0, 1500),
      comments: comments.length,
      deterministic: true,
    };
  }

  const quota = await reserve(ws, uid, "poll_summary", Math.max(2, Math.ceil(corpus.length / 250)));
  if (!quota.allowed) {
    throw Object.assign(new Error(quotaMessage(quota.reason)), { terminal: true });
  }
  const summary = (await completeFast(
    "Resume en español, máximo 4 líneas y sin adornos, el resultado de esta " +
      "encuesta y las opiniones que dejó el hilo. No inventes datos: usa solo " +
      "las cifras dadas. Si hay empate, dilo. Si el hilo está vacío, resume " +
      "solo el resultado.",
    corpus.slice(0, 6000),
  )).trim();
  if (summary === "") {
    // El proveedor no devolvió nada: el resultado determinista sigue siendo válido.
    return {
      poll_id: poll.id,
      kind: poll.kind,
      votes: voters.size,
      winner: winner === null ? null : String(winner["text"] ?? "").slice(0, 80),
      tied,
      summary: "",
      detail: corpus.slice(0, 1500),
      comments: comments.length,
      deterministic: true,
    };
  }
  return {
    poll_id: poll.id,
    kind: poll.kind,
    votes: voters.size,
    winner: winner === null ? null : String(winner["text"] ?? "").slice(0, 80),
    tied,
    summary: summary.slice(0, 1200),
    detail: corpus.slice(0, 1500),
    comments: comments.length,
    deterministic: false,
  };
}

/**
 * Resumen privado de no leídos: puntos, decisiones, preguntas y menciones,
 * con ids de mensajes para enlazar. Solo mensajes que el usuario puede leer
 * (miembro del espacio; en DMs, parte del chat). Guarda caché en
 * ai_summaries (chat_key `ws:chat` + last_message_id).
 */
async function processChatDigest(job: Job): Promise<Record<string, unknown>> {
  const userId = job.requested_by;
  if (userId === null) throw Object.assign(new Error("Sin usuario."), { terminal: true });
  const ws = job.workspace_id;
  const chatId = asString(job.payload["chat_id"]);
  const after = asString(job.payload["after"]);
  const upto = asString(job.payload["upto"]);
  if (chatId === null) throw Object.assign(new Error("Sin chat."), { terminal: true });

  // Membresía del espacio (service role, pero verificada).
  const member = await svcGet(
    `/workspace_members?workspace_id=eq.${ws}&user_id=eq.${userId}&select=user_id&limit=1`,
  );
  if (!member.ok || !Array.isArray(member.data) || member.data.length === 0) {
    throw Object.assign(new Error("Sin acceso al espacio."), { terminal: true });
  }
  // En DMs, solo si es parte del chat.
  const chat = await svcGet(
    `/chats?workspace_id=eq.${ws}&id=eq.${encodeURIComponent(chatId)}&select=type,member_ids&limit=1`,
  );
  const chatRow = chat.ok && Array.isArray(chat.data) && isRecord(chat.data[0]) ? chat.data[0] : null;
  if (chatRow === null) throw Object.assign(new Error("Chat no encontrado."), { terminal: true });
  if (chatRow["type"] === "dm") {
    const ids = Array.isArray(chatRow["member_ids"]) ? chatRow["member_ids"] : [];
    if (!ids.includes(userId)) {
      throw Object.assign(new Error("Sin acceso a ese chat."), { terminal: true });
    }
  }

  let path =
    `/messages?workspace_id=eq.${ws}&chat_id=eq.${encodeURIComponent(chatId)}` +
    `&thread_parent_id=is.null&deleted=is.false&select=id,author_name,text,created_at` +
    `&order=created_at.asc&limit=60`;
  if (after !== null) path += `&created_at=gt.${encodeURIComponent(after)}`;
  const msgs = await svcGet(path);
  const rows = msgs.ok && Array.isArray(msgs.data) ? msgs.data as Record<string, unknown>[] : [];
  if (rows.length === 0) {
    return { points: [], decisions: [], questions: [], mentions: [], empty: true };
  }
  if (!llmConfigured()) throw Object.assign(new Error("Loki IA sin configurar."), { terminal: true });
  const corpus = rows
    .map((m) => `[${String(m["id"] ?? "").slice(0, 8)}] ${String(m["author_name"] ?? "")}: ${String(m["text"] ?? "").slice(0, 300)}`)
    .join("\n");
  const q = await reserve(ws, userId, "chat_digest", Math.max(2, Math.ceil(corpus.length / 250)));
  if (!q.allowed) throw Object.assign(new Error(quotaMessage(q.reason)), { terminal: true });
  const raw = (await completeFast(
    "Resumes mensajes de un chat en español. Devuelves SOLO un JSON {\"points\": [{\"text\": string, \"msg\": string (los 8 chars del id entre corchetes)}], \"decisions\": [string], \"questions\": [string], \"mentions\": [string]}. Máximo 6 puntos. Sin adornos ni markdown.",
    corpus.slice(0, 8000),
  )).trim();
  let digest: Record<string, unknown> = { points: [], decisions: [], questions: [], mentions: [] };
  try {
    const parsed: unknown = JSON.parse(raw.replace(/^```json|```$/g, "").trim());
    if (isRecord(parsed)) digest = parsed;
  } catch {
    digest = { points: [{ text: raw.slice(0, 500), msg: "" }], decisions: [], questions: [], mentions: [] };
  }
  // Caché por (usuario, chat, último mensaje).
  const chatKey = `${ws}:${chatId}`;
  const cacheText = JSON.stringify(digest).slice(0, 4000);
  await fetch(`${SUPABASE_URL}/rest/v1/ai_summaries`, {
    method: "POST",
    headers: { ...svcHeaders(), prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      user_id: userId,
      chat_key: chatKey,
      summary: cacheText,
      last_message_id: upto,
    }),
  }).catch(() => undefined);
  return { ...digest, chat_key: chatKey, upto };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }
  if (req.method === "GET") {
    // Público a propósito (como /health de loki-chat): solo booleanos y el
    // nombre del proveedor/modelo. Sirve para los avisos "sin configurar"
    // sin gastar un trabajo.
    return json(200, { stt: sttHealth(), ocr: ocrHealth(), llm: llmConfigured() });
  }
  if (req.method !== "POST") {
    return json(405, { code: "method_not_allowed" });
  }
  if (isRateLimited(req)) {
    return json(429, {
      code: "rate_limited",
      message: "Demasiadas peticiones. Espera un minuto e inténtalo de nuevo.",
    });
  }
  // Clave interna del trigger: sin ella nadie (ni un cliente) la invoca.
  const auth = req.headers.get("authorization") ?? "";
  if (WORKER_KEY === "" || auth !== `Bearer ${WORKER_KEY}`) {
    return json(401, { code: "unauthorized" });
  }
  if (SUPABASE_URL === "" || SERVICE_KEY === "") {
    return json(503, { code: "not_configured" });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { code: "bad_request" });
  }
  const jobId = isRecord(body) ? asString(body["job_id"]) : null;
  if (jobId === null) {
    return json(400, { code: "bad_request" });
  }
  const job = await claimJob(jobId);
  if (job === null) {
    // Ya tomado, terminado o inexistente: idempotente, nada que hacer.
    return json(200, { claimed: false });
  }
  try {
    const result = await processJob(job);
    await finishOk(job.id, result);
    return json(200, { claimed: true, status: "done" });
  } catch (error) {
    const rec = isRecord(error) ? (error as Record<string, unknown>) : {};
    const terminal = rec["terminal"] === true;
    const message = error instanceof Error ? error.message : "Error del trabajador.";
    // La transcripción marca si su fallo es reintentable (red o 5xx); el OCR
    // igual; el resto de trabajos deducen del mensaje, como antes.
    const providerDown =
      rec["sttRetryable"] === true || rec["ocrRetryable"] === true ||
      /HTTP 4|HTTP 5|fetch failed|network/i.test(message);
    await finishError(job.id, message, !terminal && providerDown, job.attempts, job.max_attempts);
    return json(200, { claimed: true, status: !terminal && providerDown ? "queued" : "error" });
  }
});

// GET /health: solo dice si hay proveedor de transcripción (nunca la clave).
// Lo usa la UI para mostrar "Transcripción sin configurar" sin encolar nada.
