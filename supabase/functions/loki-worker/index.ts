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
// barato). transcribe_audio, ocr_image y dispatch_agent terminan en error
// claro "no soportado todavía" (sin reintentos infinitos).
// Sin LLM_API_KEY: lo que necesita modelo termina en error
// "Loki IA sin configurar", sin reintentar.
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

async function processJob(job: Job): Promise<Record<string, unknown>> {
  switch (job.type) {
    case "chat_summary":
      return processChatSummary(job);
    case "day_digest":
    case "redact_highlights":
      return processDigest(job, job.type === "redact_highlights");
    case "transcribe_audio":
    case "ocr_image":
    case "dispatch_agent":
      throw Object.assign(
        new Error(`El trabajo ${job.type} aún no está soportado.`),
        { terminal: true },
      );
    default:
      throw Object.assign(new Error("Tipo de trabajo desconocido."), { terminal: true });
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
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
    const terminal = isRecord(error) && (error as { terminal?: unknown }).terminal === true;
    const message = error instanceof Error ? error.message : "Error del trabajador.";
    const providerDown = /HTTP 4|HTTP 5|fetch failed|network/i.test(message);
    await finishError(job.id, message, !terminal && providerDown, job.attempts, job.max_attempts);
    return json(200, { claimed: true, status: !terminal && providerDown ? "queued" : "error" });
  }
});
