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
  "escritura: el sistema pide confirmación antes de ejecutar. " +
  "Sin proyecto explícito usa la Bandeja (omite projectId: el sistema la " +
  "resuelve). Si el pedido trae 2+ cosas usa propose_plan con una acción " +
  "por cosa. Para '¿qué me perdí?' usa get_unread y resume en puntos. " +
  "Resuelve personas contra los miembros (pide user_id por nombre " +
  "solo si es único; si hay dos iguales, dilo y no adivines) y fechas con " +
  "la herramienta tal cual te las dicen en ISO (mañana, el viernes, etc.).";

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
    description: "Crea una tarea en un proyecto (sin proyecto usa la Bandeja). Requiere confirmación.",
    parameters: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        projectId: { type: "string", description: "Opcional: sin él va a la Bandeja" },
        title: { type: "string" },
        dueAt: { type: "string", description: "ISO 8601" },
        notes: { type: "string" },
        assigneeIds: { type: "array", items: { type: "string" }, description: "uids responsables" },
      },
      required: ["workspaceId", "title"],
    },
  },
  {
    name: "update_task",
    description: "Edita una tarea existente (título, fecha, responsables, estado, proyecto). Requiere confirmación.",
    parameters: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        taskId: { type: "string" },
        title: { type: "string" },
        dueAt: { type: "string", description: "ISO 8601" },
        notes: { type: "string" },
        status: { type: "string", enum: ["todo", "doing", "done"] },
        projectId: { type: "string" },
        assigneeIds: { type: "array", items: { type: "string" } },
      },
      required: ["workspaceId", "taskId"],
    },
  },
  {
    name: "update_event",
    description: "Edita o mueve un evento existente (título, fechas, ubicación). Requiere confirmación.",
    parameters: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        eventId: { type: "string" },
        title: { type: "string" },
        startsAt: { type: "string", description: "ISO 8601" },
        endsAt: { type: "string", description: "ISO 8601" },
        location: { type: "string" },
      },
      required: ["workspaceId", "eventId"],
    },
  },
  {
    name: "create_post",
    description: "Publica un aviso en Publicaciones del espacio. Requiere confirmación.",
    parameters: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        text: { type: "string" },
      },
      required: ["workspaceId", "text"],
    },
  },
  {
    name: "create_list_item",
    description: "Agrega un ítem a una lista (punto de extensión: las listas llegan después).",
    parameters: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        list: { type: "string" },
        item: { type: "string" },
      },
      required: ["workspaceId", "item"],
    },
  },
  {
    name: "propose_plan",
    description:
      "Plan de varias acciones de escritura (evento + tarea + recordatorio…). Úsala cuando el pedido trae 2+ cosas. Requiere confirmación única.",
    parameters: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["create_event", "create_task", "create_reminder", "create_post", "complete_task"],
              },
              title: { type: "string" },
              startsAt: { type: "string" },
              projectId: { type: "string" },
              taskId: { type: "string" },
              remindAt: { type: "string" },
              text: { type: "string" },
              assigneeIds: { type: "array", items: { type: "string" } },
            },
            required: ["action"],
          },
        },
      },
      required: ["actions"],
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
    name: "get_unread",
    description: "Últimos mensajes no leídos de un chat (para '¿qué me perdí?').",
    parameters: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        chatId: { type: "string" },
        limit: { type: "number", description: "Máximo 1-40, default 20" },
      },
      required: ["workspaceId", "chatId"],
    },
  },
  {
    name: "create_reminder",
    description: "Crea un recordatorio (tarea con hora de aviso, para mí o para alguien con assigneeIds; sin proyecto va a la Bandeja). Requiere confirmación.",
    parameters: {
      type: "object",
      properties: {
        workspaceId: { type: "string" },
        projectId: { type: "string", description: "Opcional: sin él va a la Bandeja" },
        taskId: { type: "string", description: "Si existe, solo le pone el aviso" },
        title: { type: "string" },
        remindAt: { type: "string", description: "ISO 8601" },
        assigneeIds: { type: "array", items: { type: "string" }, description: "uids a avisar" },
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
  "update_task",
  "update_event",
  "create_post",
  "create_list_item",
  "propose_plan",
]);

const ACTION_LABELS: Record<string, string> = {
  create_event: "Crear evento",
  create_task: "Crear tarea",
  complete_task: "Completar tarea",
  create_reminder: "Crear recordatorio",
  update_task: "Editar tarea",
  update_event: "Editar evento",
  create_post: "Publicar aviso",
  create_list_item: "Agregar a la lista",
  propose_plan: "Plan de acciones",
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
  if (name === "get_unread") {
    const chatId = asString(args["chatId"]);
    if (chatId === null) return "Falta el chat para consultar.";
    const rawLimit = args["limit"];
    const limit = typeof rawLimit === "number" && rawLimit >= 1 && rawLimit <= 40
      ? Math.floor(rawLimit)
      : 20;
    const res = await userRest(
      `/messages?workspace_id=eq.${ws}&chat_id=eq.${encodeURIComponent(chatId)}` +
        `&thread_parent_id=is.null&deleted=is.false&select=author_name,text,created_at` +
        `&order=created_at.desc&limit=${limit}`,
      jwt,
    );
    if (!res.ok || !Array.isArray(res.data)) return "No pude leer ese chat.";
    const rows = (res.data as Record<string, unknown>[]).reverse().map((m) => ({
      autor: String(m["author_name"] ?? ""),
      texto: String(m["text"] ?? "").slice(0, 300),
    }));
    return JSON.stringify({ no_leidos: rows });
  }
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

type SpaceMember = { uid: string; name: string };

/** Miembros del espacio (display_name) con el JWT: para resolver "a Pedro". */
async function listSpaceMembers(workspaceId: string, jwt: string): Promise<SpaceMember[]> {
  const res = await userRest(
    `/workspace_members?workspace_id=eq.${encodeURIComponent(workspaceId)}&select=user_id,display_name&limit=100`,
    jwt,
  );
  if (!res.ok || !Array.isArray(res.data)) return [];
  const out: SpaceMember[] = [];
  for (const row of res.data) {
    if (!isRecord(row)) continue;
    const uid = asString(row["user_id"]);
    const name = asString(row["display_name"]) ?? "Miembro";
    if (uid !== null) out.push({ uid, name });
  }
  return out;
}

function normName(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
}

/**
 * Resuelve "a Pedro" entre los miembros: match por nombre completo o primer
 * nombre. Devuelve el uid, la lista ambigua, o null si nadie coincide.
 */
function resolvePerson(
  query: string,
  members: SpaceMember[],
  selfUid: string,
): { uid: string } | { ambiguous: SpaceMember[] } | null {
  const q = normName(query);
  if (q === "") return null;
  const matches = members.filter((m) => {
    const full = normName(m.name);
    const first = full.split(/\s+/)[0] ?? "";
    return full === q || full.replace(/\s+/g, "") === q.replace(/\s+/g, "") || first === q;
  }).filter((m) => m.uid !== selfUid);
  if (matches.length === 1) return { uid: matches[0]?.uid ?? "" };
  if (matches.length > 1) return { ambiguous: matches };
  return null;
}

/** Bandeja del espacio vía RPC (con el JWT: exige membresía). */
async function ensureInbox(workspaceId: string, jwt: string): Promise<string | null> {
  const res = await userRest("/rpc/ensure_inbox_project", jwt, {
    method: "POST",
    body: { p_workspace_id: workspaceId },
  });
  if (!res.ok || typeof res.data !== "string" || res.data === "") return null;
  return res.data;
}

/**
 * Anti-spam de avisos a terceros: tope 10/hora por destinatario. Devuelve
 * true si se puede avisar.
 */
async function allowThirdPartyPing(
  workspaceId: string,
  actorId: string,
  targetId: string,
): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/log_loki_action`, {
      method: "POST",
      headers: svcHeaders(),
      body: JSON.stringify({
        p_workspace_id: workspaceId,
        p_actor_id: actorId,
        p_target_id: targetId,
        p_action: "remind_other",
        p_limit_hour: 10,
      }),
    });
    if (!res.ok) return true;
    const body: unknown = await res.json();
    return body === true;
  } catch {
    return true;
  }
}

type Precheck = { ok: boolean; message: string };

/**
 * Revisa ANTES de confirmar si la acción pasaría la RLS (editar evento
 * ajeno, tarea de otro, etc.). La tarjeta muestra el aviso y no deja
 * confirmar lo bloqueado.
 */
async function precheckAction(
  action: string,
  params: Record<string, unknown>,
  ctx: { uid: string; jwt: string },
): Promise<Precheck> {
  const ok: Precheck = { ok: true, message: "" };
  const workspaceId = paramStr(params, "workspaceId");
  if (action === "update_event") {
    const eventId = paramStr(params, "eventId");
    if (workspaceId === null || eventId === null) {
      return { ok: false, message: "Falta el evento a editar." };
    }
    const res = await userRest(
      `/events?id=eq.${encodeURIComponent(eventId)}&select=id,created_by&limit=1`,
      ctx.jwt,
    );
    const row = Array.isArray(res.data) && isRecord(res.data[0]) ? res.data[0] : null;
    if (row === null) return { ok: false, message: "Ese evento ya no existe." };
    if (row["created_by"] !== ctx.uid) {
      const admin = await userRest(
        `/workspace_members?workspace_id=eq.${encodeURIComponent(workspaceId)}&user_id=eq.${ctx.uid}&select=role&limit=1`,
        ctx.jwt,
      );
      const role = Array.isArray(admin.data) && isRecord(admin.data[0])
        ? asString(admin.data[0]["role"])
        : null;
      if (role !== "owner" && role !== "admin") {
        return { ok: false, message: "Solo quien creó el evento o un admin puede editarlo." };
      }
    }
    return ok;
  }
  if (action === "update_task" || action === "complete_task") {
    const taskId = paramStr(params, "taskId") ?? paramStr(params, "task_id");
    if (taskId !== null && workspaceId !== null) {
      const res = await userRest(
        `/tasks?id=eq.${encodeURIComponent(taskId)}&select=id&limit=1`,
        ctx.jwt,
      );
      const exists = Array.isArray(res.data) && res.data.length > 0;
      if (!exists) return { ok: false, message: "Esa tarea ya no existe." };
    }
    return ok;
  }
  return ok;
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
  if (/(que me perdi|ponme al dia|resumen de (este|el) chat|que paso aqui|que ha pasado)/.test(lower)) {
    return { name: "get_unread", args: {} };
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

export type UndoItem = {
  kind: "task" | "event" | "post";
  id: string;
  label: string;
  workspaceId: string;
  projectId?: string;
};

/**
 * Ejecuta una acción de escritura confirmada con el JWT (RLS del usuario).
 * Devuelve el texto final en español para el stream, más lo creado (links y
 * deshacer). Todo escribe con el JWT: nunca con service_role.
 */
async function execConfirmedAction(
  action: string,
  params: Record<string, unknown>,
  ctx: { uid: string; jwt: string; workspaceId?: string },
): Promise<{ ok: boolean; text: string; links: string[]; undo: UndoItem[] }> {
  const done = (
    text: string,
    links: string[] = [],
    undo: UndoItem[] = [],
  ): { ok: boolean; text: string; links: string[]; undo: UndoItem[] } => ({
    ok: true,
    text,
    links,
    undo,
  });
  const fail = (
    text: string,
  ): { ok: boolean; text: string; links: string[]; undo: UndoItem[] } => ({
    ok: false,
    text,
    links: [],
    undo: [],
  });
  const workspaceId = paramStr(params, "workspaceId") ?? ctx.workspaceId ?? null;

  if (action === "create_event") {
    const title = paramStr(params, "title");
    const startsAt = paramStr(params, "startsAt") ?? paramStr(params, "starts_at");
    if (workspaceId === null || title === null || startsAt === null) {
      return fail("Me faltan datos para crear el evento (título y fecha). Dímelos y lo creo.");
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
    if (!res.ok || !isRecord(res.data)) {
      return fail("No pude crear el evento. Revisa la fecha e inténtalo de nuevo.");
    }
    const id = asString(res.data["id"]) ?? "";
    return done(
      `Listo: creé el evento “${title.slice(0, 100)}”.`,
      [`/calendario`],
      id === "" ? [] : [{ kind: "event", id, label: title.slice(0, 100), workspaceId }],
    );
  }

  // Proyecto destino: el dicho o la Bandeja (nunca "me falta el proyecto").
  async function targetProject(projectId: string | null): Promise<string | null> {
    if (projectId !== null) return projectId;
    if (workspaceId === null) return null;
    return ensureInbox(workspaceId, ctx.jwt);
  }

  if (action === "create_task") {
    const title = paramStr(params, "title");
    if (workspaceId === null || title === null) {
      return fail("Me faltan datos para crear la tarea (título). Dímelo y la creo.");
    }
    const projectId = await targetProject(
      paramStr(params, "projectId") ?? paramStr(params, "project_id"),
    );
    if (projectId === null) {
      return fail("No pude abrir la Bandeja del espacio. Inténtalo de nuevo.");
    }
    const dueAt = paramStr(params, "dueAt") ?? paramStr(params, "due_at");
    const assignees = params["assigneeIds"] ?? params["assignee_ids"];
    const res = await userRest("/tasks", ctx.jwt, {
      method: "POST",
      body: {
        workspace_id: workspaceId,
        project_id: projectId,
        title: title.slice(0, 200),
        notes: paramStr(params, "notes") ?? "",
        ...(dueAt !== null ? { due_at: dueAt } : {}),
        ...(Array.isArray(assignees) ? { assignee_ids: assignees.filter((a) => typeof a === "string") } : {}),
        created_by: ctx.uid,
      },
    });
    if (!res.ok || !isRecord(res.data)) {
      return fail("No pude crear la tarea. Revisa el proyecto e inténtalo de nuevo.");
    }
    const id = asString(res.data["id"]) ?? "";
    const link = `/proyectos?project=${encodeURIComponent(projectId)}&task=${encodeURIComponent(id)}`;
    return done(
      `Listo: creé la tarea “${title.slice(0, 100)}”.`,
      [link],
      id === "" ? [] : [{ kind: "task", id, label: title.slice(0, 100), workspaceId, projectId }],
    );
  }

  if (action === "complete_task") {
    const taskId = paramStr(params, "taskId") ?? paramStr(params, "task_id");
    if (taskId === null) {
      return fail("No sé qué tarea completar. Dime cuál y la marco.");
    }
    const res = await userRest(`/tasks?id=eq.${encodeURIComponent(taskId)}`, ctx.jwt, {
      method: "PATCH",
      body: { status: "done", completed_at: new Date().toISOString() },
    });
    if (!res.ok) return fail("No pude completar la tarea. Inténtalo de nuevo.");
    return done("Listo: marqué la tarea como hecha.");
  }

  if (action === "update_task") {
    const taskId = paramStr(params, "taskId") ?? paramStr(params, "task_id");
    if (workspaceId === null || taskId === null) {
      return fail("No sé qué tarea editar. Dime cuál y qué cambiar.");
    }
    const patch: Record<string, unknown> = {};
    const title = paramStr(params, "title");
    const dueAt = paramStr(params, "dueAt") ?? paramStr(params, "due_at");
    const notes = paramStr(params, "notes");
    const status = paramStr(params, "status");
    const projectId = paramStr(params, "projectId") ?? paramStr(params, "project_id");
    const assignees = params["assigneeIds"] ?? params["assignee_ids"];
    if (title !== null) patch["title"] = title.slice(0, 200);
    if (dueAt !== null) patch["due_at"] = dueAt;
    if (notes !== null) patch["notes"] = notes;
    if (status !== null && (status === "todo" || status === "doing" || status === "done")) {
      patch["status"] = status;
      if (status === "done") patch["completed_at"] = new Date().toISOString();
    }
    if (projectId !== null) patch["project_id"] = projectId;
    if (Array.isArray(assignees)) {
      patch["assignee_ids"] = assignees.filter((a) => typeof a === "string");
    }
    if (Object.keys(patch).length === 0) {
      return fail("Dime qué cambiar de la tarea (título, fecha, responsables o estado).");
    }
    const res = await userRest(`/tasks?id=eq.${encodeURIComponent(taskId)}`, ctx.jwt, {
      method: "PATCH",
      body: patch,
    });
    if (!res.ok) return fail("No pude editar la tarea. Revisa que sea tuya o pide a un admin.");
    return done("Listo: actualicé la tarea.");
  }

  if (action === "update_event") {
    const eventId = paramStr(params, "eventId") ?? paramStr(params, "event_id");
    if (workspaceId === null || eventId === null) {
      return fail("No sé qué evento editar. Dime cuál y qué cambiar.");
    }
    const patch: Record<string, unknown> = {};
    const title = paramStr(params, "title");
    const startsAt = paramStr(params, "startsAt") ?? paramStr(params, "starts_at");
    const endsAt = paramStr(params, "endsAt") ?? paramStr(params, "ends_at");
    const location = paramStr(params, "location");
    if (title !== null) patch["title"] = title.slice(0, 120);
    if (startsAt !== null) patch["starts_at"] = startsAt;
    if (endsAt !== null) patch["ends_at"] = endsAt;
    if (location !== null) patch["location"] = location;
    if (Object.keys(patch).length === 0) {
      return fail("Dime qué cambiar del evento (título, fecha u hora).");
    }
    const res = await userRest(`/events?id=eq.${encodeURIComponent(eventId)}`, ctx.jwt, {
      method: "PATCH",
      body: patch,
    });
    if (!res.ok) return fail("No pude editar el evento. Solo su creador o un admin puede.");
    return done("Listo: actualicé el evento.", [`/calendario`]);
  }

  if (action === "create_post") {
    const text = paramStr(params, "text") ?? paramStr(params, "title");
    if (workspaceId === null || text === null) {
      return fail("Dime el texto del aviso y lo publico.");
    }
    // El chat 'posts' existe en todo espacio (ensure_posts_chat lo garantiza).
    await userRest("/rpc/ensure_posts_chat", ctx.jwt, {
      method: "POST",
      body: { p_workspace_id: workspaceId },
    }).catch(() => undefined);
    const res = await userRest("/messages", ctx.jwt, {
      method: "POST",
      body: {
        workspace_id: workspaceId,
        chat_id: "posts",
        author_id: ctx.uid,
        author_name: "",
        text: text.slice(0, 4000),
        type: "post",
      },
    });
    if (!res.ok || !isRecord(res.data)) {
      return fail("No pude publicar el aviso. Inténtalo de nuevo.");
    }
    const id = asString(res.data["id"]) ?? "";
    return done(
      "Listo: lo publiqué en Publicaciones.",
      [`/chat/publicaciones`],
      id === "" ? [] : [{ kind: "post", id, label: text.slice(0, 100), workspaceId }],
    );
  }

  if (action === "create_list_item") {
    // Punto de extensión: las listas compartidas llegan después.
    return fail("Las listas compartidas aún no están listas. Por ahora lo anoto como tarea si quieres.");
  }

  if (action === "create_reminder") {
    const remindAt = paramStr(params, "remindAt") ?? paramStr(params, "remind_at");
    if (remindAt === null) {
      return fail("Me falta la hora del recordatorio. Dímela y lo dejo listo.");
    }
    const taskId = paramStr(params, "taskId") ?? paramStr(params, "task_id");
    if (taskId !== null) {
      const res = await userRest(`/tasks?id=eq.${encodeURIComponent(taskId)}`, ctx.jwt, {
        method: "PATCH",
        body: { reminder_at: remindAt },
      });
      if (!res.ok) return fail("No pude dejar el recordatorio. Inténtalo de nuevo.");
      return done("Listo: dejé el recordatorio en la tarea.");
    }
    const title = paramStr(params, "title") ?? "Recordatorio";
    const projectId = await targetProject(
      paramStr(params, "projectId") ?? paramStr(params, "project_id"),
    );
    if (workspaceId === null || projectId === null) {
      return fail("No pude abrir la Bandeja del espacio. Inténtalo de nuevo.");
    }
    const rawAssignees = params["assigneeIds"] ?? params["assignee_ids"];
    const assignees: string[] = Array.isArray(rawAssignees)
      ? rawAssignees.filter((a): a is string => typeof a === "string")
      : [];
    // Anti-spam: avisos a terceros con tope por hora.
    for (const target of assignees) {
      if (target !== ctx.uid) {
        const allowed = await allowThirdPartyPing(workspaceId, ctx.uid, target);
        if (!allowed) {
          return fail("Ya le mandaste varios avisos a esa persona en la última hora. Espera un poco.");
        }
      }
    }
    const res = await userRest("/tasks", ctx.jwt, {
      method: "POST",
      body: {
        workspace_id: workspaceId,
        project_id: projectId,
        title: title.slice(0, 200),
        reminder_at: remindAt,
        ...(assignees.length > 0 ? { assignee_ids: assignees } : {}),
        created_by: ctx.uid,
      },
    });
    if (!res.ok || !isRecord(res.data)) {
      return fail("No pude crear el recordatorio. Inténtalo de nuevo.");
    }
    const id = asString(res.data["id"]) ?? "";
    const link = `/proyectos?project=${encodeURIComponent(projectId)}&task=${encodeURIComponent(id)}`;
    const who = assignees.length > 0 && !assignees.includes(ctx.uid)
      ? " Le avisaré."
      : " Te avisaré.";
    return done(
      `Listo: agendé “${title.slice(0, 100)}”.${who}`,
      [link],
      id === "" ? [] : [{ kind: "task", id, label: title.slice(0, 100), workspaceId, projectId }],
    );
  }

  return fail("Esa acción no está soportada.");
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

type ConfirmActionItem = {
  action: string;
  params: Record<string, unknown>;
  include?: boolean;
};

type ConfirmPayload = {
  id: string;
  action: string;
  params: Record<string, unknown>;
  ok: boolean;
  /** Plan multi-acción: solo se ejecutan las incluidas. */
  actions?: ConfirmActionItem[];
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
  }
  | { mode: "suggest"; text: string; confirm?: undefined; threadParentId?: undefined };

function parseConfirm(raw: unknown): ConfirmPayload | undefined {
  if (!isRecord(raw)) return undefined;
  const id = validId(raw["id"]);
  const action = validId(raw["action"]);
  if (id === null || action === null) return undefined;
  const params = isRecord(raw["params"]) ? raw["params"] : {};
  // Las confirmaciones no arrastran textos largos: tope de seguridad.
  if (JSON.stringify(params).length > 8000) return undefined;
  let actions: ConfirmActionItem[] | undefined;
  if (Array.isArray(raw["actions"])) {
    const items: ConfirmActionItem[] = [];
    for (const item of raw["actions"]) {
      if (!isRecord(item)) continue;
      const a = validId(item["action"]);
      if (a === null) continue;
      const p = isRecord(item["params"]) ? item["params"] : {};
      if (JSON.stringify(p).length > 4000) continue;
      items.push({ action: a, params: p, include: item["include"] !== false });
    }
    if (items.length > 0 && items.length <= 10) actions = items;
  }
  return { id, action, params, ok: raw["ok"] === true, ...(actions !== undefined ? { actions } : {}) };
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
  if (mode === "suggest") {
    return { mode: "suggest", text };
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
  run: (
    send: (delta: string) => void,
    sendPending: (pending: unknown) => void,
    sendCreated: (created: unknown) => void,
  ) => Promise<void>,
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
      const sendCreated = (created: unknown): void => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ created })}\n\n`));
      };
      try {
        await run(send, sendPending, sendCreated);
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
  // Sin clave el modelo no anda, pero la confirmación (REST con el JWT) y la
  // vía determinista (código, no IA) sí: el chequeo va después de ellas.
  // Comportamiento exacto sin LLM_API_KEY:
  //   - comandos simples con fecha clara -> tarjeta de confirmación igual;
  //   - confirmar ejecuta igual (no usa modelo);
  //   - lo demás -> 503 "Loki IA sin configurar".
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

  // --- Modo suggest: título + fecha para convertir un mensaje ---------------
  // Sin streaming ni guardado: el modelo barato propone, el usuario decide.
  // Nunca automático. Consume cuota normal del espacio del usuario.
  if (input.mode === "suggest") {
    if (!isConfigured()) {
      return json(503, {
        code: "not_configured",
        message: "Loki IA sin configurar. Pide al administrador que configure el proveedor.",
      });
    }
    const wsId = await defaultWorkspaceId(uid, token);
    const quota = await reserveQuota(wsId, uid, Math.max(1, Math.ceil(input.text.length / 250)));
    if (!quota.allowed) {
      return json(429, {
        code: "limit",
        message: quota.reason.startsWith("space")
          ? "Este espacio llegó a su límite de IA de hoy."
          : "Llegaste al límite diario de Loki IA. Vuelve mañana.",
      });
    }
    try {
      const raw = await completeText([
        {
          role: "system",
          content: "Devuelves SOLO un JSON {\"title\": string (máx 80, lo esencial del texto), \"dateISO\": string ISO 8601 o null si no hay fecha clara}. Sin adornos ni markdown.",
        },
        { role: "user", content: input.text.slice(0, 1000) },
      ]);
      const parsed: unknown = JSON.parse(raw.replace(/^```json|```$/g, "").trim());
      const title = isRecord(parsed) && typeof parsed["title"] === "string"
        ? parsed["title"].slice(0, 80)
        : "";
      const dateISO = isRecord(parsed) && typeof parsed["dateISO"] === "string" &&
          !Number.isNaN(Date.parse(parsed["dateISO"]))
        ? parsed["dateISO"]
        : null;
      return json(200, { title, dateISO });
    } catch {
      return json(502, { code: "provider_error" });
    }
  }

  // --- Segundo POST: confirmación de una acción pendiente -----------------------
  // No usa el modelo: funciona incluso sin proveedor configurado.
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
    return sseReplyStream(save, async (send, _sendPending, sendCreated) => {
      if (!confirm.ok) {
        send("Entendido, lo dejé sin hacer.");
        return;
      }
      // Plan multi-acción: se ejecutan las incluidas, en orden.
      const items = confirm.actions !== undefined && confirm.actions.length > 0
        ? confirm.actions.filter((item) => item.include !== false)
        : [{ action: confirm.action, params: confirm.params, include: true }];
      if (items.length === 0) {
        send("Entendido, lo dejé sin hacer.");
        return;
      }
      const texts: string[] = [];
      const links: string[] = [];
      const undo: UndoItem[] = [];
      for (const item of items) {
        if (!WRITE_ACTIONS.has(item.action)) continue;
        const merged = {
          ...item.params,
          ...(workspaceId !== undefined && asString(item.params["workspaceId"]) === null
            ? { workspaceId }
            : {}),
        };
        const result = await execConfirmedAction(item.action, merged, {
          uid,
          jwt: token,
          workspaceId,
        });
        texts.push(result.text);
        for (const link of result.links) {
          if (!links.includes(link)) links.push(link);
        }
        for (const u of result.undo) undo.push(u);
        if (!result.ok) break;
      }
      const full = texts.join("\n");
      const withLinks = links.length > 0 ? `${full}\n${links.map((l) => `Ver: ${l}`).join("\n")}` : full;
      send(withLinks);
      if (links.length > 0 || undo.length > 0) {
        sendCreated({ links, undo });
      }
    });
  }

  // --- Vía determinista (sin modelo): verbo + fecha clara en español ---------
  // Si el analizador está seguro (p. ej. "recuérdame mañana a las 9 sacar
  // la basura"), se arma la herramienta directo y no se gasta cuota ni LLM.
  // Funciona sin proveedor configurado: es código, no IA.
  {
    const quick = analyzeIntent(input.text);
    if (
      quick !== null && quick.confident && quick.dateISO !== null &&
      (quick.action === "remind" || quick.action === "create_event")
    ) {
      let wsForTool: string | undefined;
      if (input.mode === "mention") {
        const member = await isMember(input.workspaceId, uid);
        if (!member) return json(403, { code: "forbidden" });
        wsForTool = input.workspaceId;
      }
      // "Recuérdale a Sofi…": se resuelve contra los miembros del espacio.
      let assigneeIds: string[] | undefined;
      let assigneeChoices: SpaceMember[] | undefined;
      if (quick.action === "remind" && quick.mentions.length > 0) {
        const wsId = wsForTool ?? await defaultWorkspaceId(uid, token);
        if (wsId !== null) {
          wsForTool = wsId;
          const members = await listSpaceMembers(wsId, token);
          for (const mention of quick.mentions) {
            const hit = resolvePerson(mention, members, uid);
            if (hit !== null && "uid" in hit) {
              assigneeIds = [...(assigneeIds ?? []), hit.uid];
            } else if (hit !== null && "ambiguous" in hit) {
              assigneeChoices = hit.ambiguous;
            }
          }
        }
      }
      const tool = quick.action === "remind"
        ? {
          name: "create_reminder",
          args: {
            title: quick.title,
            remindAt: quick.dateISO,
            ...(assigneeIds !== undefined && assigneeIds.length > 0 ? { assigneeIds } : {}),
          },
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
          workspaceId: wsForTool,
          chatId: input.mode === "mention" ? input.chatId : undefined,
        }),
        // Ambigüedad ("dos Pedros"): la tarjeta pide elegir en vez de adivinar.
        ...(assigneeChoices !== undefined && assigneeChoices.length > 0
          ? { assigneeChoices }
          : {}),
      };
      return sseReplyStream(null, async (_send, sendPending) => {
        sendPending(pending);
      });
    }
  }

  if (!isConfigured()) {
    return json(503, {
      code: "not_configured",
      message: "Loki IA sin configurar. Pide al administrador que configure el proveedor.",
    });
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
    ...(mentionCtx !== null && (tool.name === "search_messages" || tool.name === "get_unread") &&
        asString(tool.args["chatId"]) === null
      ? { chatId: mentionCtx.chatId }
      : {}),
  };

  // --- Escritura: pide confirmación (no ejecuta, no guarda) -----------------------
  if (WRITE_ACTIONS.has(tool.name)) {
    // Plan de varias acciones: una tarjeta, casilla por acción.
    if (tool.name === "propose_plan") {
      const rawActions = Array.isArray(toolArgs["actions"]) ? toolArgs["actions"] : [];
      const items: {
        action: string;
        label: string;
        params: Record<string, unknown>;
        include: boolean;
        warning?: string;
      }[] = [];
      for (const raw of rawActions.slice(0, 10)) {
        if (!isRecord(raw)) continue;
        const name = asString(raw["action"]);
        if (name === null || !WRITE_ACTIONS.has(name) || name === "propose_plan") continue;
        const params = pendingParams(
          isRecord(raw) ? raw as Record<string, unknown> : {},
          { workspaceId: mentionCtx?.workspaceId, chatId: mentionCtx?.chatId },
        );
        const check = await precheckAction(name, params, { uid, jwt: token });
        items.push({
          action: name,
          label: actionLabel(name),
          params,
          include: check.ok,
          ...(check.ok ? {} : { warning: check.message }),
        });
      }
      if (items.length === 0) {
        return sseReplyStream(save, async (send) => {
          send("No pude armar el plan con esos datos. Dímelo con más detalle.");
        });
      }
      // El plan gasta por acción: se reserva el extra (la primera ya se cobró).
      const extra = await reserveQuota(
        mentionCtx?.workspaceId ?? fallbackWs,
        uid,
        quotaUnits * (items.length - 1),
      );
      if (!extra.allowed) {
        return json(429, {
          code: "limit",
          message: "Este espacio llegó a su límite de IA de hoy.",
        });
      }
      const pending = {
        id: crypto.randomUUID(),
        action: "propose_plan",
        label: "Plan de acciones",
        params: pendingParams(toolArgs, {
          workspaceId: mentionCtx?.workspaceId,
          chatId: mentionCtx?.chatId,
        }),
        actions: items,
      };
      return sseReplyStream(null, async (_send, sendPending) => {
        sendPending(pending);
      });
    }
    const singleParams = pendingParams(toolArgs, {
      workspaceId: mentionCtx?.workspaceId,
      chatId: mentionCtx?.chatId,
    });
    // Si no pasaría el permiso (p. ej. editar evento ajeno), la tarjeta lo
    // diría: mejor decirlo directo sin ofrecer nada.
    const check = await precheckAction(tool.name, singleParams, { uid, jwt: token });
    if (!check.ok) {
      return sseReplyStream(save, async (send) => {
        send(check.message);
      });
    }
    const pending = {
      id: crypto.randomUUID(),
      action: tool.name,
      label: actionLabel(tool.name),
      params: singleParams,
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
