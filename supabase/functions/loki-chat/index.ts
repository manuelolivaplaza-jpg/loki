// =============================================================================
// Loki IA con herramientas · Edge Function `loki-chat` (Deno, sin dependencias).
//
// - GET  /health -> { configured, provider, model } (sin exponer la clave).
// - POST          -> chat con SSE real (`data: {"delta": "…"}` + `data: [DONE]`).
//
// Autenticación: el cliente manda su JWT (`Authorization: Bearer …`) y aquí
// se valida contra Auth (`/auth/v1/user`). La `service_role` del entorno solo
// se usa para historial, cuota (`ai_usage`), resúmenes (`ai_summaries`) y
// guardar la respuesta `ai` (el cliente nunca puede escribir `type: "ai"`).
// Los DATOS del espacio (eventos, tareas, proyectos, mensajes) se leen y
// escriben con el JWT del usuario (respeta la RLS).
//
// Proveedor por entorno (`supabase/functions/.env`, gitignored):
//   LLM_PROVIDER=openai|anthropic|gemini, LLM_MODEL, LLM_API_KEY,
//   LLM_BASE_URL (solo openai-compatible: Groq, OpenRouter, Ollama),
//   AI_DAILY_LIMIT (default 50).
// Niveles por tarea (caen a LLM_MODEL si no se configuran):
//   LLM_MODEL_FAST  (barato y rápido: intenciones, resúmenes cortos)
//   LLM_MODEL_SMART (potente: respuestas con datos, resúmenes largos)
// Regla: determinista primero, barato después, potente solo si la tarea
// lo exige (datos que razonar, texto largo).
// Sin clave: 503 { code: "not_configured" }. Cuota superada: 429 {code:"limit"}.
//
// Protocolo SSE extendido: además de {delta}, una acción que modifica datos
// emite {tool_pending:{id,action,label,params}} y cierra con [DONE] SIN
// guardar respuesta. El cliente muestra la tarjeta de confirmación y hace un
// segundo POST {mode, confirm:{id,action,params,ok}}: con ok=true se ejecuta
// (POST/PATCH real con el JWT) y el stream sigue con "Listo: …"; con
// ok=false responde "Entendido, lo dejé sin hacer."
//
// Secretos de Supabase (los pone el runtime): SUPABASE_URL,
// SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
// =============================================================================

import { analyzeIntent } from "../_shared/intent.ts";

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const PROVIDER = (Deno.env.get("LLM_PROVIDER") ?? "").trim().toLowerCase();
const MODEL = (Deno.env.get("LLM_MODEL") ?? "").trim();
const MODEL_FAST = (Deno.env.get("LLM_MODEL_FAST") ?? "").trim() || MODEL;
const MODEL_SMART = (Deno.env.get("LLM_MODEL_SMART") ?? "").trim() || MODEL;
const API_KEY = (Deno.env.get("LLM_API_KEY") ?? "").trim();
const BASE_URL = (Deno.env.get("LLM_BASE_URL") ?? "https://api.openai.com/v1").replace(
  /\/+$/,
  "",
);

const DAILY_LIMIT = (() => {
  const raw = (Deno.env.get("AI_DAILY_LIMIT") ?? "50").trim();
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
})();

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, apikey",
};

const SSE_HEADERS: Record<string, string> = {
  ...CORS,
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
};

type ModelTier = "fast" | "smart";

/**
 * Modelo según nivel: barato para clasificar/resumir poco, potente para
 * razonar sobre datos o texto largo. Cada nivel cae a LLM_MODEL.
 */
function modelFor(tier: ModelTier, fallback: string): string {
  const pick = tier === "smart" ? MODEL_SMART : MODEL_FAST;
  return pick === "" ? fallback : pick;
}

// --- Límite de peticiones (T35) -------------------------------------------------
// Cubo en memoria por IP+JWT: 30 req/min. Al superarlas, 429 amable en
// español. Best effort (el runtime puede reiniciar el mapa entre
// invocaciones); la cuota diaria `bump_ai_usage` sigue siendo el límite
// real de uso de IA.

const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, number[]>();

function rateLimitKey(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  const ip = forwarded.split(",")[0]?.trim() ||
    (req.headers.get("cf-connecting-ip") ?? "sin-ip");
  const auth = req.headers.get("authorization") ?? "";
  return `${ip}|${auth.slice(0, 32)}`;
}

function isRateLimited(req: Request): boolean {
  const key = rateLimitKey(req);
  const now = Date.now();
  const stamps = (rateBuckets.get(key) ?? []).filter(
    (stamp) => now - stamp < RATE_LIMIT_WINDOW_MS,
  );
  if (stamps.length >= RATE_LIMIT_MAX) {
    rateBuckets.set(key, stamps);
    return true;
  }
  stamps.push(now);
  // El mapa no crece sin tope: se podan las claves vacías de a una.
  if (rateBuckets.size > 2000) {
    const oldest = rateBuckets.keys().next();
    if (!oldest.done) rateBuckets.delete(oldest.value);
  }
  rateBuckets.set(key, stamps);
  return false;
}

// Límites estrictos espejo de `src/lib/validators.ts` (sin dependencias).
const MAX_TEXT = 4000;
const MAX_ID = 200;

function validId(value: unknown): string | null {
  return typeof value === "string" && value !== "" && value.length <= MAX_ID
    ? value
    : null;
}

const SYSTEM_PROMPT =
  "Eres Loki, el asistente personal dentro de la app familiar Loki. " +
  "Respondes en español, tono cercano y sobrio, con respuestas cortas salvo " +
  "que pidan detalle. No inventes datos del usuario (calendario, tareas, " +
  "notas): si te piden algo que no ves, dilo claramente. " +
  "Tienes herramientas para consultar el resumen de hoy, eventos, tareas, " +
  "proyectos y mensajes del espacio. Úsalas antes de responder sobre datos " +
  "reales. Si te piden crear o completar algo, llama a la herramienta de " +
  "escritura: el sistema pide confirmación antes de ejecutar.";

const SYSTEM_PROMPT_SUMMARY =
  "Resume la conversación en 2 líneas en español, solo lo esencial " +
  "(temas y decisiones). Sin adornos.";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

function isConfigured(): boolean {
  return API_KEY !== "" && (PROVIDER === "openai" || PROVIDER === "anthropic" || PROVIDER === "gemini");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * Mantiene viva una promesa secundaria tras cerrar la respuesta (resumen
 * fire-and-forget). Si el runtime no lo soporta, no hace nada.
 */
function keepAlive(promise: Promise<unknown>): void {
  try {
    const runtime = (globalThis as unknown as {
      EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void };
    }).EdgeRuntime;
    runtime?.waitUntil?.(promise);
  } catch {
    // Sin soporte: la promesa sigue en segundo plano igual.
  }
}

/** Valida el JWT del usuario contra Auth. Devuelve id + token o null. */
async function authUser(req: Request): Promise<{ uid: string; token: string } | null> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ")
    ? header.slice("bearer ".length).trim()
    : "";
  if (token === "" || SUPABASE_URL === "" || SUPABASE_ANON_KEY === "") return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!isRecord(body)) return null;
    const id = body["id"];
    if (typeof id !== "string" || id === "") return null;
    return { uid: id, token };
  } catch {
    return null;
  }
}

function svcHeaders(): Record<string, string> {
  return {
    apikey: SERVICE_KEY,
    authorization: `Bearer ${SERVICE_KEY}`,
    "content-type": "application/json",
  };
}

/** REST contra Supabase con el JWT del usuario (respeta la RLS). */
async function userRest(
  path: string,
  jwt: string,
  init?: { method?: string; body?: unknown },
): Promise<{ ok: boolean; status: number; data: unknown }> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
      method: init?.method ?? "GET",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        Prefer: "return=representation",
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

// --- Cuota diaria y resúmenes -------------------------------------------------

type UsageResult = { allowed: boolean; count: number };

/** Incrementa la cuota del día vía `bump_ai_usage` (service_role). */
async function bumpUsage(uid: string): Promise<UsageResult> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/bump_ai_usage`, {
      method: "POST",
      headers: svcHeaders(),
      body: JSON.stringify({ p_uid: uid, p_limit: DAILY_LIMIT }),
    });
    if (!res.ok) return { allowed: true, count: 0 };
    const body: unknown = await res.json();
    if (!isRecord(body)) return { allowed: true, count: 0 };
    return {
      allowed: body["allowed"] === true,
      count: typeof body["count"] === "number" ? body["count"] : 0,
    };
  } catch {
    // Sin base disponible no se bloquea la conversación.
    return { allowed: true, count: 0 };
  }
}

type QuotaResult = { allowed: boolean; reason: string };

/**
 * Reserva cuota antes de llamar al LLM: espacio (día/mes) + usuario (día).
 * 1 unidad ≈ 250 caracteres de ida. Sin base disponible no bloquea.
 */
async function reserveQuota(
  workspaceId: string | null,
  uid: string,
  units: number,
): Promise<QuotaResult> {
  if (workspaceId === null) return { ...(await bumpUsage(uid)), reason: "ok" };
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/reserve_ai_quota`, {
      method: "POST",
      headers: svcHeaders(),
      body: JSON.stringify({
        p_workspace_id: workspaceId,
        p_user_id: uid,
        p_job_type: "chat",
        p_units: units,
      }),
    });
    if (!res.ok) return { allowed: true, reason: "ok" };
    const body: unknown = await res.json();
    if (!isRecord(body)) return { allowed: true, reason: "ok" };
    const reason = typeof body["reason"] === "string" ? body["reason"] : "ok";
    return { allowed: body["allowed"] === true, reason };
  } catch {
    return { allowed: true, reason: "ok" };
  }
}

/** Resumen previo guardado para esta conversación (o null). */
async function loadSummary(uid: string, chatKey: string): Promise<string | null> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/ai_summaries?user_id=eq.${uid}&chat_key=eq.${encodeURIComponent(chatKey)}&select=summary&limit=1`,
      { headers: svcHeaders() },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as { summary?: unknown }[];
    const first = rows[0];
    return first !== undefined && typeof first.summary === "string" && first.summary !== ""
      ? first.summary
      : null;
  } catch {
    return null;
  }
}

/** Guarda el resumen sin romper el flujo (fire-and-forget desde el handler). */
async function storeSummary(uid: string, chatKey: string, summary: string): Promise<void> {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/ai_summaries`, {
      method: "POST",
      headers: { ...svcHeaders(), Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ user_id: uid, chat_key: chatKey, summary }),
    });
  } catch {
    // Best effort: el resumen es solo contexto compacto.
  }
}

/** Recorta el historial a ~6000 caracteres (conserva lo más reciente). */
function trimHistory(history: ChatMessage[], maxChars: number): ChatMessage[] {
  let total = 0;
  const kept: ChatMessage[] = [];
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item === undefined) continue;
    total += item.content.length;
    if (total > maxChars && kept.length >= 10) break;
    kept.unshift(item);
  }
  return kept;
}

// --- Historial ----------------------------------------------------------------

type AiChatRow = { id: string };

async function ensurePersonalChat(uid: string): Promise<string | null> {
  try {
    const found = await fetch(
      `${SUPABASE_URL}/rest/v1/ai_chats?user_id=eq.${uid}&select=id&order=created_at.asc&limit=1`,
      { headers: svcHeaders() },
    );
    if (found.ok) {
      const rows = (await found.json()) as AiChatRow[];
      if (rows.length > 0 && rows[0] !== undefined) return rows[0].id;
    }
    const created = await fetch(`${SUPABASE_URL}/rest/v1/ai_chats`, {
      method: "POST",
      headers: { ...svcHeaders(), Prefer: "return=representation" },
      body: JSON.stringify({ user_id: uid }),
    });
    if (!created.ok) return null;
    const rows = (await created.json()) as AiChatRow[];
    return rows.length > 0 && rows[0] !== undefined ? rows[0].id : null;
  } catch {
    return null;
  }
}

type AiHistoryRow = { type: string; content: string };

/** Últimos 30 mensajes del chat privado (límite de contexto). */
async function personalHistory(chatId: string): Promise<ChatMessage[]> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/ai_messages?chat_id=eq.${chatId}&select=type,content&order=created_at.desc&limit=30`,
      { headers: svcHeaders() },
    );
    if (!res.ok) return [];
    const rows = ((await res.json()) as AiHistoryRow[]).reverse();
    return rows.map((row) => ({
      role: row.type === "ai" ? ("assistant" as const) : ("user" as const),
      content: row.content,
    }));
  } catch {
    return [];
  }
}

type SpaceHistoryRow = { author_name: string; text: string };

/**
 * Contexto del chat para @loki: últimos 15 mensajes. Con hilo abierto, los
 * del hilo; si no, la raíz. La membresía ya se comprobó con `isMember`.
 */
async function mentionHistory(
  workspaceId: string,
  chatId: string,
  threadParentId?: string,
): Promise<ChatMessage[]> {
  try {
    const threadFilter = threadParentId !== undefined
      ? `thread_parent_id=eq.${encodeURIComponent(threadParentId)}`
      : "thread_parent_id=is.null";
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/messages?workspace_id=eq.${encodeURIComponent(workspaceId)}&chat_id=eq.${encodeURIComponent(chatId)}&${threadFilter}&select=author_name,text&order=created_at.desc&limit=15`,
      { headers: svcHeaders() },
    );
    if (!res.ok) return [];
    const rows = ((await res.json()) as SpaceHistoryRow[]).reverse();
    return rows.map((row) => ({
      role: "user" as const,
      content: `${row.author_name}: ${row.text}`,
    }));
  } catch {
    return [];
  }
}

async function isMember(workspaceId: string, uid: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/workspace_members?workspace_id=eq.${workspaceId}&user_id=eq.${uid}&select=user_id&limit=1`,
      { headers: svcHeaders() },
    );
    if (!res.ok) return false;
    const rows = (await res.json()) as unknown[];
    return rows.length > 0;
  } catch {
    return false;
  }
}

async function savePersonalReply(chatId: string, text: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/ai_messages`, {
    method: "POST",
    headers: svcHeaders(),
    body: JSON.stringify({ chat_id: chatId, type: "ai", content: text }),
  }).catch(() => undefined);
}

async function saveMentionReply(
  workspaceId: string,
  chatId: string,
  text: string,
  threadParentId?: string,
): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/messages`, {
    method: "POST",
    headers: svcHeaders(),
    body: JSON.stringify({
      workspace_id: workspaceId,
      chat_id: chatId,
      author_id: null,
      author_name: "Loki",
      text,
      type: "ai",
      mentions: [],
      thread_parent_id: threadParentId ?? null,
    }),
  }).catch(() => undefined);
}

// --- Herramientas ---------------------------------------------------------------

type ToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

const TOOLS: ToolDef[] = [
  {
    name: "get_today_summary",
    description: "Resume las tareas que vencen hoy y los eventos de hoy del espacio.",
    parameters: {
      type: "object",
      properties: { workspaceId: { type: "string", description: "Id del espacio" } },
      required: ["workspaceId"],
    },
  },
  {
    name: "list_events",
    description: "Lista los próximos eventos del espacio.",
    parameters: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["workspaceId"],
    },
  },
  {
    name: "create_event",
    description: "Crea un evento en el calendario. Requiere confirmación.",
    parameters: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        title: { type: "string" },
        startsAt: { type: "string", description: "ISO 8601" },
        endsAt: { type: "string", description: "ISO 8601" },
        location: { type: "string" },
        description: { type: "string" },
      },
      required: ["workspaceId", "title", "startsAt"],
    },
  },
  {
    name: "list_tasks",
    description: "Lista tareas del espacio, opcionalmente por proyecto o estado.",
    parameters: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        projectId: { type: "string" },
        status: { type: "string", enum: ["todo", "doing", "done"] },
      },
      required: ["workspaceId"],
    },
  },
  {
    name: "create_task",
    description: "Crea una tarea en un proyecto. Requiere confirmación.",
    parameters: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        projectId: { type: "string" },
        title: { type: "string" },
        dueAt: { type: "string", description: "ISO 8601" },
        notes: { type: "string" },
      },
      required: ["workspaceId", "projectId", "title"],
    },
  },
  {
    name: "complete_task",
    description: "Marca una tarea como hecha. Requiere confirmación.",
    parameters: {
      type: "object",
      properties: { taskId: { type: "string" } },
      required: ["taskId"],
    },
  },
  {
    name: "list_projects",
    description: "Lista los proyectos del espacio con su progreso.",
    parameters: {
      type: "object",
      properties: { workspaceId: { type: "string" } },
      required: ["workspaceId"],
    },
  },
  {
    name: "search_messages",
    description: "Busca texto en los mensajes del espacio.",
    parameters: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        chatId: { type: "string" },
        query: { type: "string" },
      },
      required: ["workspaceId", "query"],
    },
  },
  {
    name: "create_reminder",
    description: "Crea un recordatorio (tarea con hora de aviso). Requiere confirmación.",
    parameters: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        projectId: { type: "string" },
        taskId: { type: "string", description: "Si existe, solo le pone el aviso" },
        title: { type: "string" },
        remindAt: { type: "string", description: "ISO 8601" },
      },
      required: ["workspaceId", "remindAt"],
    },
  },
];

/** Acciones que modifican datos: no se ejecutan, piden confirmación. */
const WRITE_ACTIONS: ReadonlySet<string> = new Set([
  "create_event",
  "create_task",
  "complete_task",
  "create_reminder",
]);

const ACTION_LABELS: Record<string, string> = {
  create_event: "Crear evento",
  create_task: "Crear tarea",
  complete_task: "Completar tarea",
  create_reminder: "Crear recordatorio",
};

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? "Confirmar acción";
}

function dayRangeISO(now: Date): { start: string; end: string } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Primer espacio del usuario (para herramientas en modo personal). */
async function defaultWorkspaceId(uid: string, jwt: string): Promise<string | null> {
  const res = await userRest(
    `/workspace_members?user_id=eq.${uid}&select=workspace_id&limit=1`,
    jwt,
  );
  if (!res.ok || !Array.isArray(res.data)) return null;
  const first = res.data[0];
  return isRecord(first) ? asString(first["workspace_id"]) : null;
}

/**
 * Ejecuta una herramienta de LECTURA con el JWT del usuario.
 * Devuelve texto compacto para alimentar al modelo.
 */
async function execReadTool(
  name: string,
  args: Record<string, unknown>,
  jwt: string,
): Promise<string> {
  const workspaceId = asString(args["workspaceId"]);
  if ((name !== "complete_task" && workspaceId === null) || workspaceId === null) {
    return "Falta el espacio para consultar.";
  }
  const ws = encodeURIComponent(workspaceId as string);
  if (name === "get_today_summary") {
    const { start, end } = dayRangeISO(new Date());
    const [tasks, events] = await Promise.all([
      userRest(
        `/tasks?workspace_id=eq.${ws}&status=neq.done&due_at=gte.${encodeURIComponent(start)}&due_at=lt.${encodeURIComponent(end)}&select=id,title,due_at,project_id&order=due_at.asc&limit=20`,
        jwt,
      ),
      userRest(
        `/events?workspace_id=eq.${ws}&starts_at=gte.${encodeURIComponent(start)}&starts_at=lt.${encodeURIComponent(end)}&select=id,title,starts_at,location&order=starts_at.asc&limit=20`,
        jwt,
      ),
    ]);
    return JSON.stringify({ tareas_hoy: tasks.data, eventos_hoy: events.data });
  }
  if (name === "list_events") {
    const res = await userRest(
      `/events?workspace_id=eq.${ws}&select=id,title,starts_at,ends_at,location&order=starts_at.asc&limit=20`,
      jwt,
    );
    return JSON.stringify(res.data);
  }
  if (name === "list_tasks") {
    const projectId = asString(args["projectId"]);
    const status = asString(args["status"]);
    let path =
      `/tasks?workspace_id=eq.${ws}&select=id,title,status,due_at,project_id&order=created_at.desc&limit=30`;
    if (projectId !== null) path += `&project_id=eq.${encodeURIComponent(projectId)}`;
    if (status !== null) path += `&status=eq.${encodeURIComponent(status)}`;
    const res = await userRest(path, jwt);
    return JSON.stringify(res.data);
  }
  if (name === "list_projects") {
    const res = await userRest(
      `/projects?workspace_id=eq.${ws}&select=id,name,emoji,status&order=created_at.asc&limit=30`,
      jwt,
    );
    const rows = Array.isArray(res.data) ? res.data : [];
    const ids = rows
      .map((row) => (isRecord(row) ? asString(row["id"]) : null))
      .filter((id): id is string => id !== null);
    let progress: unknown = [];
    if (ids.length > 0) {
      const prog = await userRest(
        `/project_progress?project_id=in.(${ids.map((id) => encodeURIComponent(id)).join(",")})&select=project_id,total,done`,
        jwt,
      );
      progress = prog.data;
    }
    return JSON.stringify({ proyectos: rows, progreso: progress });
  }
  if (name === "search_messages") {
    const query = asString(args["query"]) ?? "";
    const chatId = asString(args["chatId"]);
    const clean = query.replace(/[%*]/g, "").slice(0, 80);
    let path =
      `/messages?workspace_id=eq.${ws}&text=ilike.*${encodeURIComponent(clean)}*&select=author_name,text,created_at&order=created_at.desc&limit=20`;
    if (chatId !== null) path += `&chat_id=eq.${encodeURIComponent(chatId)}`;
    const res = await userRest(path, jwt);
    return JSON.stringify(res.data);
  }
  return "Herramienta no soportada.";
}

/** Parámetros para la tarjeta de confirmación (acción de escritura). */
function pendingParams(
  args: Record<string, unknown>,
  fallback: { workspaceId?: string; chatId?: string },
): Record<string, unknown> {
  const params: Record<string, unknown> = { ...args };
  if (asString(params["workspaceId"]) === null && fallback.workspaceId !== undefined) {
    params["workspaceId"] = fallback.workspaceId;
  }
  if (asString(params["chatId"]) === null && fallback.chatId !== undefined) {
    params["chatId"] = fallback.chatId;
  }
  return params;
}

// --- Primera pasada con tools (no streaming) ------------------------------------

type LlmToolCall = { name: string; args: Record<string, unknown> } | null;

function parseArgs(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Argumentos rotos: se tratan como vacíos.
    }
  }
  return {};
}

function openAiTools(): unknown[] {
  return TOOLS.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

async function openAiFirstPass(messages: ChatMessage[]): Promise<{ text: string; tool: LlmToolCall }> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: modelFor("fast", "gpt-4o-mini"),
      messages,
      tools: openAiTools(),
      tool_choice: "auto",
    }),
  });
  if (!res.ok) throw new Error(`Proveedor openai: HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!isRecord(body)) return { text: "", tool: null };
  const choices = body["choices"];
  const message = Array.isArray(choices) && isRecord(choices[0])
    ? (choices[0] as Record<string, unknown>)["message"]
    : null;
  if (!isRecord(message)) return { text: "", tool: null };
  const text = typeof message["content"] === "string" ? message["content"] : "";
  const calls = message["tool_calls"];
  const first = Array.isArray(calls) && isRecord(calls[0]) ? calls[0] : null;
  const fn = first !== null && isRecord(first["function"]) ? first["function"] : null;
  if (fn === null || typeof fn["name"] !== "string") return { text, tool: null };
  return { text, tool: { name: fn["name"], args: parseArgs(fn["arguments"]) } };
}

async function anthropicFirstPass(messages: ChatMessage[]): Promise<{ text: string; tool: LlmToolCall }> {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const rest = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: modelFor("fast", "claude-3-5-haiku-latest"),
      max_tokens: 1024,
      system: system === "" ? SYSTEM_PROMPT : system,
      messages: rest,
      tools: TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
      })),
    }),
  });
  if (!res.ok) throw new Error(`Proveedor anthropic: HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!isRecord(body) || !Array.isArray(body["content"])) return { text: "", tool: null };
  let text = "";
  let tool: LlmToolCall = null;
  for (const block of body["content"]) {
    if (!isRecord(block)) continue;
    if (block["type"] === "text" && typeof block["text"] === "string") text += block["text"];
    if (block["type"] === "tool_use" && typeof block["name"] === "string") {
      tool = { name: block["name"], args: parseArgs(block["input"]) };
    }
  }
  return { text, tool };
}

async function geminiFirstPass(messages: ChatMessage[]): Promise<{ text: string; tool: LlmToolCall }> {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const model = modelFor("fast", "gemini-2.0-flash");
  const base = BASE_URL === "https://api.openai.com/v1"
    ? "https://generativelanguage.googleapis.com"
    : BASE_URL;
  const res = await fetch(
    `${base}/v1beta/models/${model}:generateContent?key=${encodeURIComponent(API_KEY)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system === "" ? SYSTEM_PROMPT : system }] },
        contents,
        tools: [{
          functionDeclarations: TOOLS.map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
          })),
        }],
      }),
    },
  );
  if (!res.ok) throw new Error(`Proveedor gemini: HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!isRecord(body) || !Array.isArray(body["candidates"])) return { text: "", tool: null };
  const first = body["candidates"][0];
  if (!isRecord(first) || !isRecord(first["content"])) return { text: "", tool: null };
  const parts = first["content"]["parts"];
  if (!Array.isArray(parts)) return { text: "", tool: null };
  let text = "";
  let tool: LlmToolCall = null;
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (typeof part["text"] === "string") text += part["text"];
    if (isRecord(part["functionCall"]) && typeof part["functionCall"]["name"] === "string") {
      tool = {
        name: part["functionCall"]["name"],
        args: parseArgs(part["functionCall"]["args"]),
      };
    }
  }
  return { text, tool };
}

async function firstPassWithTools(
  history: ChatMessage[],
  prompt: string,
): Promise<{ text: string; tool: LlmToolCall }> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: prompt },
  ];
  if (PROVIDER === "anthropic") return anthropicFirstPass(messages);
  if (PROVIDER === "gemini") return geminiFirstPass(messages);
  return openAiFirstPass(messages);
}

/** Texto corto sin streaming (para el resumen de 2 líneas). */
async function completeText(messages: ChatMessage[]): Promise<string> {
  if (PROVIDER === "anthropic") {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const rest = messages.filter((m) => m.role !== "system").map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: modelFor("fast", "claude-3-5-haiku-latest"),
        max_tokens: 256,
        system,
        messages: rest,
      }),
    });
    if (!res.ok) throw new Error("summary_error");
    const body: unknown = await res.json();
    if (!isRecord(body) || !Array.isArray(body["content"])) return "";
    return body["content"]
      .map((block) =>
        isRecord(block) && block["type"] === "text" && typeof block["text"] === "string"
          ? block["text"]
          : ""
      )
      .join("");
  }
  if (PROVIDER === "gemini") {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const contents = messages.filter((m) => m.role !== "system").map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
    const model = modelFor("fast", "gemini-2.0-flash");
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
          contents,
        }),
      },
    );
    if (!res.ok) throw new Error("summary_error");
    const body: unknown = await res.json();
    if (!isRecord(body) || !Array.isArray(body["candidates"])) return "";
    const first = body["candidates"][0];
    if (!isRecord(first) || !isRecord(first["content"])) return "";
    const parts = first["content"]["parts"];
    if (!Array.isArray(parts)) return "";
    return parts
      .map((part) => (isRecord(part) && typeof part["text"] === "string" ? part["text"] : ""))
      .join("");
  }
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: modelFor("fast", "gpt-4o-mini"),
      messages,
      max_tokens: 256,
    }),
  });
  if (!res.ok) throw new Error("summary_error");
  const body: unknown = await res.json();
  if (!isRecord(body) || !Array.isArray(body["choices"])) return "";
  const first = body["choices"][0];
  if (!isRecord(first) || !isRecord(first["message"])) return "";
  const content = first["message"]["content"];
  return typeof content === "string" ? content : "";
}

/**
 * Fallback por regex cuando el proveedor no soporta tools: detecta la
 * intención en español y devuelve la llamada equivalente (o null).
 */
function detectIntentFallback(text: string): LlmToolCall {
  const lower = text.toLowerCase();
  if (/(crea|creá|crear|agrega|agregá|añade|nuevo|nueva)\s+(un\s+)?evento/.test(lower)) {
    return { name: "create_event", args: { title: text.trim().slice(0, 120) } };
  }
  if (/(crea|creá|crear|agrega|agregá|añade|nueva|nuevo)\s+(una\s+)?tarea/.test(lower)) {
    return { name: "create_task", args: { title: text.trim().slice(0, 200) } };
  }
  if (/(recu[eé]rdame|recordatorio|av[ií]same|aviso|recu[eé]rdale)/.test(lower)) {
    return { name: "create_reminder", args: { title: text.trim().slice(0, 200) } };
  }
  if (/(completa|completá|termina|marca.*(hecha|completada|lista)|tacha)/.test(lower)) {
    return { name: "complete_task", args: {} };
  }
  if (/(resumen del d[ií]a|qu[eé] hay hoy|mi d[ií]a|agenda de hoy)/.test(lower)) {
    return { name: "get_today_summary", args: {} };
  }
  if (/(busca|buscar|encuentra|encuentra|dijeron|dijo).*(mensaje|chat)/.test(lower)) {
    return { name: "search_messages", args: { query: text.trim().slice(0, 80) } };
  }
  if (/(mis tareas|mis pendientes|tareas pendientes|qu[eé] tareas)/.test(lower)) {
    return { name: "list_tasks", args: {} };
  }
  if (/(mis eventos|pr[oó]ximos eventos|calendario)/.test(lower)) {
    return { name: "list_events", args: {} };
  }
  if (/(mis proyectos|proyectos)/.test(lower)) {
    return { name: "list_projects", args: {} };
  }
  return null;
}

// --- Ejecución con confirmación (JWT del usuario) ---------------------------------

function paramStr(params: Record<string, unknown>, key: string): string | null {
  return asString(params[key]);
}

/**
 * Ejecuta una acción de escritura confirmada con el JWT (RLS del usuario).
 * Devuelve el texto final en español para el stream.
 */
async function execConfirmedAction(
  action: string,
  params: Record<string, unknown>,
  ctx: { uid: string; jwt: string; workspaceId?: string },
): Promise<{ ok: boolean; text: string }> {
  const workspaceId = paramStr(params, "workspaceId") ?? ctx.workspaceId ?? null;

  if (action === "create_event") {
    const title = paramStr(params, "title");
    const startsAt = paramStr(params, "startsAt") ?? paramStr(params, "starts_at");
    if (workspaceId === null || title === null || startsAt === null) {
      return { ok: false, text: "Me faltan datos para crear el evento (título y fecha). Dímelos y lo creo." };
    }
    const endsAt = paramStr(params, "endsAt") ?? paramStr(params, "ends_at") ?? startsAt;
    const res = await userRest("/events", ctx.jwt, {
      method: "POST",
      body: {
        workspace_id: workspaceId,
        title: title.slice(0, 120),
        starts_at: startsAt,
        ends_at: endsAt,
        location: paramStr(params, "location") ?? "",
        description: paramStr(params, "description") ?? "",
        created_by: ctx.uid,
      },
    });
    if (!res.ok) return { ok: false, text: "No pude crear el evento. Revisa la fecha e inténtalo de nuevo." };
    return { ok: true, text: `Listo: creé el evento “${title.slice(0, 100)}”.` };
  }

  if (action === "create_task") {
    const title = paramStr(params, "title");
    const projectId = paramStr(params, "projectId") ?? paramStr(params, "project_id");
    if (workspaceId === null || title === null || projectId === null) {
      return { ok: false, text: "Me faltan datos para crear la tarea (proyecto y título). Dímelos y la creo." };
    }
    const dueAt = paramStr(params, "dueAt") ?? paramStr(params, "due_at");
    const res = await userRest("/tasks", ctx.jwt, {
      method: "POST",
      body: {
        workspace_id: workspaceId,
        project_id: projectId,
        title: title.slice(0, 200),
        notes: paramStr(params, "notes") ?? "",
        ...(dueAt !== null ? { due_at: dueAt } : {}),
        created_by: ctx.uid,
      },
    });
    if (!res.ok) return { ok: false, text: "No pude crear la tarea. Revisa el proyecto e inténtalo de nuevo." };
    return { ok: true, text: `Listo: creé la tarea “${title.slice(0, 100)}”.` };
  }

  if (action === "complete_task") {
    const taskId = paramStr(params, "taskId") ?? paramStr(params, "task_id");
    if (taskId === null) {
      return { ok: false, text: "No sé qué tarea completar. Dime cuál y la marco." };
    }
    const res = await userRest(`/tasks?id=eq.${encodeURIComponent(taskId)}`, ctx.jwt, {
      method: "PATCH",
      body: { status: "done", completed_at: new Date().toISOString() },
    });
    if (!res.ok) return { ok: false, text: "No pude completar la tarea. Inténtalo de nuevo." };
    return { ok: true, text: "Listo: marqué la tarea como hecha." };
  }

  if (action === "create_reminder") {
    const remindAt = paramStr(params, "remindAt") ?? paramStr(params, "remind_at");
    if (remindAt === null) {
      return { ok: false, text: "Me falta la hora del recordatorio. Dímela y lo dejo listo." };
    }
    const taskId = paramStr(params, "taskId") ?? paramStr(params, "task_id");
    if (taskId !== null) {
      const res = await userRest(`/tasks?id=eq.${encodeURIComponent(taskId)}`, ctx.jwt, {
        method: "PATCH",
        body: { reminder_at: remindAt },
      });
      if (!res.ok) return { ok: false, text: "No pude dejar el recordatorio. Inténtalo de nuevo." };
      return { ok: true, text: "Listo: dejé el recordatorio en la tarea." };
    }
    const title = paramStr(params, "title") ?? "Recordatorio";
    const projectId = paramStr(params, "projectId") ?? paramStr(params, "project_id");
    if (workspaceId === null || projectId === null) {
      return { ok: false, text: "Me falta el proyecto para el recordatorio. Dime en cuál lo creo." };
    }
    const res = await userRest("/tasks", ctx.jwt, {
      method: "POST",
      body: {
        workspace_id: workspaceId,
        project_id: projectId,
        title: title.slice(0, 200),
        reminder_at: remindAt,
        created_by: ctx.uid,
      },
    });
    if (!res.ok) return { ok: false, text: "No pude crear el recordatorio. Inténtalo de nuevo." };
    return { ok: true, text: `Listo: te avisaré de “${title.slice(0, 100)}”.` };
  }

  return { ok: false, text: "Esa acción no está soportada." };
}

// --- Proveedores (streaming) --------------------------------------------------

type DeltaHandler = (delta: string) => void;

/** Parte el stream en líneas SSE y entrega cada `data:` al callback. */
async function pumpSseLines(
  body: ReadableStream<Uint8Array>,
  onData: (payload: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice("data:".length).trim();
      if (payload === "" || payload === "[DONE]") continue;
      onData(payload);
    }
  }
  const tail = buffer.trim();
  if (tail.startsWith("data:")) {
    const payload = tail.slice("data:".length).trim();
    if (payload !== "" && payload !== "[DONE]") onData(payload);
  }
}

function openAiDelta(payload: string, onDelta: DeltaHandler): void {
  try {
    const json = JSON.parse(payload) as {
      choices?: { delta?: { content?: string } }[];
    };
    const content = json.choices?.[0]?.delta?.content;
    if (typeof content === "string" && content !== "") onDelta(content);
  } catch {
    // Línea de control: se ignora.
  }
}

async function streamOpenAi(
  messages: ChatMessage[],
  onDelta: DeltaHandler,
  tier: ModelTier = "fast",
): Promise<void> {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: modelFor(tier, "gpt-4o-mini"),
      messages,
      stream: true,
    }),
  });
  if (!res.ok || res.body === null) {
    throw new Error(`Proveedor openai: HTTP ${res.status}`);
  }
  await pumpSseLines(res.body, (payload) => openAiDelta(payload, onDelta));
}

async function streamAnthropic(
  messages: ChatMessage[],
  onDelta: DeltaHandler,
  tier: ModelTier = "fast",
): Promise<void> {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const rest = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: modelFor(tier, "claude-3-5-haiku-latest"),
      max_tokens: 1024,
      system: system === "" ? SYSTEM_PROMPT : system,
      messages: rest,
      stream: true,
    }),
  });
  if (!res.ok || res.body === null) {
    throw new Error(`Proveedor anthropic: HTTP ${res.status}`);
  }
  await pumpSseLines(res.body, (payload) => {
    try {
      const json = JSON.parse(payload) as {
        type?: string;
        delta?: { type?: string; text?: string };
      };
      if (json.type === "content_block_delta" && typeof json.delta?.text === "string") {
        onDelta(json.delta.text);
      }
    } catch {
      // Línea de control: se ignora.
    }
  });
}

async function streamGemini(
  messages: ChatMessage[],
  onDelta: DeltaHandler,
  tier: ModelTier = "fast",
): Promise<void> {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  const model = modelFor(tier, "gemini-2.0-flash");
  const base = BASE_URL === "https://api.openai.com/v1"
    ? "https://generativelanguage.googleapis.com"
    : BASE_URL;
  const res = await fetch(
    `${base}/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(API_KEY)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: system === "" ? SYSTEM_PROMPT : system }] },
        contents,
      }),
    },
  );
  if (!res.ok || res.body === null) {
    throw new Error(`Proveedor gemini: HTTP ${res.status}`);
  }
  await pumpSseLines(res.body, (payload) => {
    try {
      const json = JSON.parse(payload) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };
      const parts = json.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (typeof part.text === "string" && part.text !== "") onDelta(part.text);
      }
    } catch {
      // Línea de control: se ignora.
    }
  });
}

async function streamFromProvider(
  history: ChatMessage[],
  prompt: string,
  onDelta: DeltaHandler,
  tier: ModelTier = "fast",
): Promise<void> {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: prompt },
  ];
  if (PROVIDER === "anthropic") return streamAnthropic(messages, onDelta, tier);
  if (PROVIDER === "gemini") return streamGemini(messages, onDelta, tier);
  return streamOpenAi(messages, onDelta, tier);
}

// --- Handler ------------------------------------------------------------------

type ConfirmPayload = {
  id: string;
  action: string;
  params: Record<string, unknown>;
  ok: boolean;
};

type ChatRequest =
  | { mode: "personal"; text: string; confirm?: ConfirmPayload; threadParentId?: undefined }
  | {
    mode: "mention";
    text: string;
    workspaceId: string;
    chatId: string;
    threadParentId?: string;
    confirm?: ConfirmPayload;
  };

function parseConfirm(raw: unknown): ConfirmPayload | undefined {
  if (!isRecord(raw)) return undefined;
  const id = validId(raw["id"]);
  const action = validId(raw["action"]);
  if (id === null || action === null) return undefined;
  const params = isRecord(raw["params"]) ? raw["params"] : {};
  // Las confirmaciones no arrastran textos largos: tope de seguridad.
  if (JSON.stringify(params).length > 4000) return undefined;
  return { id, action, params, ok: raw["ok"] === true };
}

function parseRequest(body: unknown): ChatRequest | null {
  if (!isRecord(body)) return null;
  const mode = body["mode"];
  const confirm = body["confirm"] !== undefined ? parseConfirm(body["confirm"]) : undefined;
  if (body["confirm"] !== undefined && confirm === undefined) return null;

  const textRaw = body["text"];
  const text = typeof textRaw === "string" ? textRaw.trim() : "";
  // Con confirmación el texto puede venir vacío: la acción ya trae el contexto.
  if (text === "" && confirm === undefined) return null;
  if (text.length > MAX_TEXT) return null;

  if (mode === "personal") {
    return { mode: "personal", text, confirm };
  }
  const workspaceId = validId(body["workspaceId"]);
  const chatId = validId(body["chatId"]);
  if (mode === "mention" && workspaceId !== null && chatId !== null) {
    const threadRaw = body["threadParentId"] ?? body["thread_parent_id"] ?? null;
    const threadParentId = typeof threadRaw === "string" && threadRaw !== "" ? validId(threadRaw) : undefined;
    if (typeof threadRaw === "string" && threadRaw !== "" && threadParentId === undefined) return null;
    return {
      mode: "mention",
      text,
      workspaceId,
      chatId,
      threadParentId,
      confirm,
    };
  }
  return null;
}

/** Stream SSE que emite deltas y guarda la respuesta final. */
function sseReplyStream(
  save: ((full: string) => Promise<void>) | null,
  run: (send: (delta: string) => void, sendPending: (pending: unknown) => void) => Promise<void>,
  after?: (full: string) => void,
): Response {
  const encoder = new TextEncoder();
  let full = "";
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (delta: string): void => {
        full += delta;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta })}\n\n`));
      };
      const sendPending = (pending: unknown): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ tool_pending: pending })}\n\n`));
      };
      try {
        await run(send, sendPending);
        if (full.trim() !== "") {
          await save?.(full);
          after?.(full);
        }
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        const message = error instanceof Error ? error.message : "provider_error";
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ error: message })}\n\n`),
        );
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: SSE_HEADERS });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }
  if (req.method === "GET") {
    return json(200, {
      configured: isConfigured(),
      provider: isConfigured() ? PROVIDER : "none",
      model: isConfigured() ? MODEL : "",
      fast: isConfigured() ? MODEL_FAST : "",
      smart: isConfigured() ? MODEL_SMART : "",
    });
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
  if (!isConfigured()) {
    return json(503, {
      code: "not_configured",
      message: "Loki IA sin configurar. Pide al administrador que configure el proveedor.",
    });
  }
  const auth = await authUser(req);
  if (auth === null) {
    return json(401, { code: "unauthorized" });
  }
  const { uid, token } = auth;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { code: "bad_request" });
  }
  const input = parseRequest(body);
  if (input === null) {
    return json(400, { code: "bad_request" });
  }

  // --- Segundo POST: confirmación de una acción pendiente -----------------------
  if (input.confirm !== undefined) {
    const confirm = input.confirm;
    let save: ((full: string) => Promise<void>) | null = null;
    let workspaceId: string | undefined;
    if (input.mode === "mention") {
      const member = await isMember(input.workspaceId, uid);
      if (!member) return json(403, { code: "forbidden" });
      workspaceId = input.workspaceId;
      const { workspaceId: ws, chatId, threadParentId } = input;
      save = (full: string) => saveMentionReply(ws, chatId, full, threadParentId);
    } else {
      const chatId = await ensurePersonalChat(uid);
      if (chatId === null) return json(502, { code: "provider_error" });
      save = (full: string) => savePersonalReply(chatId, full);
    }
    return sseReplyStream(save, async (send) => {
      if (!confirm.ok) {
        send("Entendido, lo dejé sin hacer.");
        return;
      }
      const result = await execConfirmedAction(confirm.action, confirm.params, {
        uid,
        jwt: token,
        workspaceId,
      });
      send(result.text);
    });
  }

  // --- Vía determinista (sin modelo): verbo + fecha clara en español ---------
  // Si el analizador está seguro (p. ej. "recuérdame mañana a las 9 sacar
  // la basura"), se arma la herramienta directo y no se gasta cuota ni LLM.
  if (input.confirm === undefined) {
    const quick = analyzeIntent(input.text);
    if (
      quick !== null && quick.confident && quick.dateISO !== null &&
      (quick.action === "remind" || quick.action === "create_event")
    ) {
      if (input.mode === "mention") {
        const member = await isMember(input.workspaceId, uid);
        if (!member) return json(403, { code: "forbidden" });
      }
      const tool = quick.action === "remind"
        ? {
          name: "create_reminder",
          args: { title: quick.title, remindAt: quick.dateISO },
        }
        : {
          name: "create_event",
          args: { title: quick.title, startsAt: quick.dateISO },
        };
      const pending = {
        id: crypto.randomUUID(),
        action: tool.name,
        label: actionLabel(tool.name),
        params: pendingParams(tool.args, {
          workspaceId: input.mode === "mention" ? input.workspaceId : undefined,
          chatId: input.mode === "mention" ? input.chatId : undefined,
        }),
      };
      return sseReplyStream(null, async (_send, sendPending) => {
        sendPending(pending);
      });
    }
  }

  // --- Primer POST: cuota (espacio + usuario) ---------------------------------
  const quotaWs = input.mode === "mention"
    ? input.workspaceId
    : await defaultWorkspaceId(uid, token);
  const quotaUnits = Math.max(1, Math.ceil(input.text.length / 250));
  const quota = await reserveQuota(quotaWs, uid, quotaUnits);
  if (!quota.allowed) {
    if (quota.reason === "space_daily") {
      return json(429, {
        code: "limit",
        message:
          "Este espacio llegó a su límite de IA de hoy. Lo simple (recordatorios con fecha clara) sigue funcionando.",
      });
    }
    if (quota.reason === "space_monthly") {
      return json(429, {
        code: "limit",
        message: "Este espacio llegó a su límite de IA del mes.",
      });
    }
    return json(429, {
      code: "limit",
      message: "Llegaste al límite diario de Loki IA. Vuelve mañana.",
    });
  }

  // --- Contexto: historial (30 mensajes, ~6000 chars) + resumen previo ---------
  let history: ChatMessage[] = [];
  let save: ((full: string) => Promise<void>) | null = null;
  let chatKey = "personal";
  let mentionCtx: { workspaceId: string; chatId: string } | null = null;
  if (input.mode === "personal") {
    const chatId = await ensurePersonalChat(uid);
    if (chatId === null) return json(502, { code: "provider_error" });
    history = await personalHistory(chatId);
    save = (full: string) => savePersonalReply(chatId, full);
  } else {
    const member = await isMember(input.workspaceId, uid);
    if (!member) return json(403, { code: "forbidden" });
    history = await mentionHistory(input.workspaceId, input.chatId, input.threadParentId);
    const { workspaceId, chatId, threadParentId } = input;
    save = (full: string) => saveMentionReply(workspaceId, chatId, full, threadParentId);
    chatKey = `${workspaceId}:${chatId}`;
    mentionCtx = { workspaceId, chatId };
  }
  const previousSummary = await loadSummary(uid, chatKey);
  const trimmed = trimHistory(history, 6000);
  const context: ChatMessage[] = previousSummary !== null
    ? [{ role: "system", content: `Resumen previo: ${previousSummary}` }, ...trimmed]
    : trimmed;
  const historyLen = history.length;
  const prompt = input.text;

  /** Tras responder con historial largo: resumen de 2 líneas (sin romper). */
  const scheduleSummary = (full: string): void => {
    if (historyLen <= 20) return;
    const job = completeText([
      { role: "system", content: SYSTEM_PROMPT_SUMMARY },
      ...trimHistory([...context, { role: "assistant", content: full }], 6000),
    ]).then(
      (summary) => {
        if (summary.trim() !== "") {
          void storeSummary(uid, chatKey, summary.trim().slice(0, 1000));
        }
      },
      () => undefined,
    );
    keepAlive(job);
  };

  // --- Primera pasada: el modelo decide si usa herramientas ----------------------
  let first: { text: string; tool: LlmToolCall };
  try {
    first = await firstPassWithTools(context, prompt);
  } catch {
    // El proveedor no soporta tools (o falló): intención por regex.
    first = { text: "", tool: detectIntentFallback(prompt) };
  }
  if (first.tool === null && first.text === "") {
    const fallback = detectIntentFallback(prompt);
    if (fallback !== null) first = { text: "", tool: fallback };
  }

  // --- Sin herramienta: stream directo -------------------------------------------
  // Charla corta con el barato; texto largo (razonar) con el potente.
  const plainTier: ModelTier = prompt.length > 1500 ? "smart" : "fast";
  if (first.tool === null) {
    return sseReplyStream(save, async (send) => {
      if (first.text !== "") {
        send(first.text);
        return;
      }
      await streamFromProvider(context, prompt, send, plainTier);
    }, scheduleSummary);
  }

  const tool = first.tool;
  const known = TOOLS.some((t) => t.name === tool.name);
  if (!known) {
    return sseReplyStream(save, async (send) => {
      await streamFromProvider(context, prompt, send, plainTier);
    });
  }

  // En modo personal el modelo no conoce el espacio: se usa el primero del
  // usuario como contexto (la RLS del JWT sigue mandando).
  const fallbackWs = input.mode === "personal" &&
      asString(tool.args["workspaceId"]) === null
    ? await defaultWorkspaceId(uid, token)
    : null;
  const toolArgs: Record<string, unknown> = {
    ...tool.args,
    ...(mentionCtx !== null && asString(tool.args["workspaceId"]) === null
      ? { workspaceId: mentionCtx.workspaceId }
      : {}),
    ...(fallbackWs !== null ? { workspaceId: fallbackWs } : {}),
    ...(mentionCtx !== null && tool.name === "search_messages" &&
        asString(tool.args["chatId"]) === null
      ? { chatId: mentionCtx.chatId }
      : {}),
  };

  // --- Escritura: pide confirmación (no ejecuta, no guarda) -----------------------
  if (WRITE_ACTIONS.has(tool.name)) {
    const pending = {
      id: crypto.randomUUID(),
      action: tool.name,
      label: actionLabel(tool.name),
      params: pendingParams(toolArgs, {
        workspaceId: mentionCtx?.workspaceId,
        chatId: mentionCtx?.chatId,
      }),
    };
    return sseReplyStream(null, async (_send, sendPending) => {
      sendPending(pending);
    });
  }

  // --- Lectura: ejecuta con el JWT y responde con los datos -----------------------
  // Razonar sobre datos reales pide el modelo potente.
  const toolResult = await execReadTool(tool.name, toolArgs, token);
  const enriched = `${prompt}\n\n[Datos de ${tool.name}: ${toolResult}]`;
  return sseReplyStream(save, async (send) => {
    await streamFromProvider(context, enriched, send, "smart");
  }, scheduleSummary);
});
