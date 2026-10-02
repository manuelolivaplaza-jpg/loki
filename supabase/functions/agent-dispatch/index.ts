// =============================================================================
// Agentes personales · Edge Function `agent-dispatch` (Deno, cero imports
// salvo `../_shared/agents.ts`).
//
// La despierta el trigger `notify_agent_dispatch` (pg_net) con la clave
// interna AGENT_DISPATCH_KEY, o un usuario con su JWT (reintento manual).
// Nada queda escuchando: corre solo cuando hay una ejecución encolada.
//
// Pasos: valida conexión activa + grant + cuota diaria, genera el token de la
// ejecución (guarda solo su hash), arma el contexto permitido (mensajes
// recientes solo si el grant lo autoriza; nunca DMs salvo invocación ahí y
// permiso), y llama al adaptador del proveedor con el cuerpo mínimo
// {type:"loki.agent_task", v:1, run_id, run_token, attempt}.
//
// Adaptadores en esta etapa: `generic_webhook` (POST a dispatch_url con
// Bearer del secreto saliente). `grokbot`, `hermes` y `a2a` responden
// 501 {code:'not_implemented'}: los conecta el prompt 13 sin tocar este
// contrato. La orden y el contexto NUNCA viajan en el webhook: el agente los
// baja con el token (o los recibe por el callback del prompt 13).
//
// Secretos (supabase/functions/.env): AGENT_TOKEN_KEY (cifra lo saliente),
// AGENT_DISPATCH_KEY (clave interna del trigger), AGENT_ALLOW_PRIVATE=true
// solo en desarrollo (permite URLs locales).
// =============================================================================

import {
  cleanUrl,
  decryptSecret,
  isAgentProvider,
  isBlockedDispatchHost,
  randomToken,
  sha256Hex,
} from "../_shared/agents.ts";

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const AGENT_TOKEN_KEY = Deno.env.get("AGENT_TOKEN_KEY") ?? "";
const AGENT_DISPATCH_KEY = Deno.env.get("AGENT_DISPATCH_KEY") ?? "";
const ALLOW_PRIVATE = (Deno.env.get("AGENT_ALLOW_PRIVATE") ?? "").toLowerCase() ===
  "true";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, apikey",
};

const DISPATCH_TIMEOUT_MS = 10_000;
const DEFAULT_DEADLINE_MIN = 15;
const MAX_CONTEXT_CHARS = 2000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function svcHeaders(): Record<string, string> {
  return {
    apikey: SERVICE_KEY,
    authorization: `Bearer ${SERVICE_KEY}`,
    "content-type": "application/json",
  };
}

async function svcRest(
  path: string,
  init?: { method?: string; body?: unknown; prefer?: string },
): Promise<{ ok: boolean; status: number; data: unknown }> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
      method: init?.method ?? "GET",
      headers: {
        ...svcHeaders(),
        Prefer: init?.prefer ?? "return=representation",
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

function pickRow(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) {
    const first = data[0];
    return isRecord(first) ? first : null;
  }
  return isRecord(data) ? data : null;
}

async function authUserId(req: Request): Promise<string | null> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ")
    ? header.slice("bearer ".length).trim()
    : "";
  if (token === "" || token === AGENT_DISPATCH_KEY) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: SUPABASE_ANON_KEY, authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!isRecord(body)) return null;
    const id = body["id"];
    return typeof id === "string" && id !== "" ? id : null;
  } catch {
    return null;
  }
}

function isInternal(req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ")
    ? header.slice("bearer ".length).trim()
    : "";
  return AGENT_DISPATCH_KEY !== "" && token === AGENT_DISPATCH_KEY;
}

async function appendEvent(
  runId: string,
  type: string,
  text: string,
): Promise<void> {
  const existing = await svcRest(
    `/agent_run_events?run_id=eq.${encodeURIComponent(runId)}&select=seq&order=seq.desc&limit=1`,
  );
  const rows = Array.isArray(existing.data) ? existing.data : [];
  const last = rows.length > 0 && isRecord(rows[0]) &&
      typeof rows[0]["seq"] === "number"
    ? (rows[0]["seq"] as number)
    : -1;
  await svcRest("/agent_run_events", {
    method: "POST",
    body: { run_id: runId, seq: last + 1, type, text: text.slice(0, 2000) },
    prefer: "return=minimal",
  });
}

async function failRun(
  runId: string,
  connectionId: string,
  message: string,
): Promise<Response> {
  await svcRest(
    `/agent_runs?id=eq.${encodeURIComponent(runId)}`,
    {
      method: "PATCH",
      body: { status: "error", error: message.slice(0, 500) },
      prefer: "return=minimal",
    },
  );
  await appendEvent(runId, "dispatch_failed", message);
  await svcRest(
    `/agent_connections?id=eq.${encodeURIComponent(connectionId)}`,
    {
      method: "PATCH",
      body: { status: "error", last_error: message.slice(0, 280) },
      prefer: "return=minimal",
    },
  );
  return json(502, { code: "dispatch_failed", message });
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }
  if (req.method === "GET") {
    return json(200, { ok: true });
  }
  if (req.method !== "POST") {
    return json(405, { code: "method_not_allowed" });
  }

  const internal = isInternal(req);
  let callerUid: string | null = null;
  if (!internal) {
    callerUid = await authUserId(req);
    if (callerUid === null) return json(401, { code: "unauthorized" });
  }

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  const runId = isRecord(body) && typeof body["run_id"] === "string"
    ? body["run_id"].trim()
    : "";
  if (runId === "") {
    return json(400, { code: "bad_request", message: "Falta run_id." });
  }

  const runRes = await svcRest(
    `/agent_runs?id=eq.${encodeURIComponent(runId)}&select=*`,
  );
  const run = pickRow(runRes.data);
  if (run === null) return json(404, { code: "not_found" });
  if (run["status"] !== "queued") {
    return json(200, { ok: true, status: String(run["status"] ?? "") });
  }

  const connectionRes = await svcRest(
    `/agent_connections?id=eq.${encodeURIComponent(String(run["connection_id"] ?? ""))}&select=*`,
  );
  const conn = pickRow(connectionRes.data);
  if (conn === null) {
    return failRun(runId, "", "El agente ya no existe.");
  }
  const connectionId = String(conn["id"] ?? "");
  const provider = String(conn["provider"] ?? "");
  if (!isAgentProvider(provider)) {
    return failRun(runId, connectionId, "Proveedor del agente desconocido.");
  }

  const ownerId = String(conn["owner_id"] ?? "");
  const requestedBy = typeof run["requested_by"] === "string"
    ? (run["requested_by"] as string)
    : "";
  if (!internal && callerUid !== requestedBy && callerUid !== ownerId) {
    return json(403, {
      code: "forbidden",
      message: "Solo quien pidió la ejecución o el dueño pueden reintentarla.",
    });
  }

  // Solo el dueño puede probar (kind ping): es su secreto y su plan.
  if (run["kind"] === "ping" && requestedBy !== ownerId) {
    return failRun(runId, connectionId, "Solo el dueño puede probar la conexión.");
  }

  if (conn["status"] !== "active") {
    return failRun(runId, connectionId, "El agente está pausado o en error.");
  }

  const wsId = String(run["workspace_id"] ?? "");
  const grantRes = await svcRest(
    `/agent_space_grants?connection_id=eq.${encodeURIComponent(connectionId)}&workspace_id=eq.${encodeURIComponent(wsId)}&select=*`,
  );
  const grant = pickRow(grantRes.data);
  if (run["kind"] !== "ping") {
    if (grant === null || grant["enabled"] !== true || grant["admin_disabled"] === true) {
      return failRun(
        runId,
        connectionId,
        "El agente no está habilitado en este espacio.",
      );
    }
  }

  // Cuota diaria del grant (SQL barato, sin LLM).
  const dailyLimit = typeof grant?.["daily_limit"] === "number"
    ? (grant["daily_limit"] as number)
    : 20;
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const usedRes = await svcRest(
    `/agent_runs?connection_id=eq.${encodeURIComponent(connectionId)}&workspace_id=eq.${encodeURIComponent(wsId)}&created_at=gte.${encodeURIComponent(dayStart.toISOString())}&select=id`,
  );
  const used = Array.isArray(usedRes.data) ? usedRes.data.length : 0;
  if (used > dailyLimit) {
    return failRun(
      runId,
      connectionId,
      "Este agente llegó a su tope diario en este espacio. Inténtalo mañana.",
    );
  }

  if (!isAgentProvider(provider) || provider !== "generic_webhook") {
    return failRun(
      runId,
      connectionId,
      `El adaptador ${provider} se conecta en el prompt 13; por ahora usa generic_webhook.`,
    );
  }

  if (AGENT_TOKEN_KEY.length < 32) {
    return json(503, {
      code: "not_configured",
      message: "Agentes sin configurar en este entorno (falta AGENT_TOKEN_KEY).",
    });
  }
  const config = isRecord(conn["config"]) ? conn["config"] : {};
  const dispatchUrl = cleanUrl(config["dispatch_url"]);
  if (dispatchUrl === null) {
    return failRun(
      runId,
      connectionId,
      "Falta la URL de disparo del agente. Complétala en Mis agentes.",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(dispatchUrl);
  } catch {
    return failRun(runId, connectionId, "La URL de disparo no es válida.");
  }
  if (isBlockedDispatchHost(parsed.hostname, ALLOW_PRIVATE)) {
    return failRun(
      runId,
      connectionId,
      "La URL de disparo apunta a una dirección interna (bloqueada por seguridad).",
    );
  }

  // Token de la ejecución: el claro viaja SOLO al agente; aquí queda su hash.
  const runToken = randomToken();
  const tokenHash = await sha256Hex(runToken);
  const deadline = new Date(Date.now() + DEFAULT_DEADLINE_MIN * 60_000);
  const tokenExpires = new Date(deadline.getTime() + 10 * 60_000);

  // Contexto mínimo: últimos mensajes si el grant lo autoriza. Nada de DMs
  // salvo invocación dentro de ese DM con permiso explícito.
  let context: Array<{ author: string; text: string; at: string }> = [];
  const allowContext = grant === null ? true : grant["allow_context"] !== false;
  const contextN = grant !== null && typeof grant["context_messages"] === "number"
    ? Math.max(0, Math.min(50, grant["context_messages"] as number))
    : 10;
  if (allowContext && contextN > 0 && run["kind"] !== "ping") {
    const chatRes = await svcRest(
      `/chats?workspace_id=eq.${encodeURIComponent(wsId)}&id=eq.${encodeURIComponent(String(run["chat_id"] ?? ""))}&select=type`,
    );
    const chatRow = pickRow(chatRes.data);
    const chatType = chatRow !== null ? String(chatRow["type"] ?? "") : "";
    const allowDm = grant !== null && grant["allow_dm_context"] === true;
    if (chatType !== "dm" || allowDm) {
      const msgs = await svcRest(
        `/messages?workspace_id=eq.${encodeURIComponent(wsId)}&chat_id=eq.${encodeURIComponent(String(run["chat_id"] ?? ""))}&deleted=eq.false&select=author_name,text,created_at&order=created_at.desc&limit=${contextN}`,
      );
      if (Array.isArray(msgs.data)) {
        let chars = 0;
        for (const entry of [...msgs.data].reverse()) {
          if (!isRecord(entry)) continue;
          const text = String(entry["text"] ?? "").slice(0, 500);
          if (text === "") continue;
          if (chars + text.length > MAX_CONTEXT_CHARS) break;
          chars += text.length;
          context.push({
            author: String(entry["author_name"] ?? "").slice(0, 60),
            text,
            at: String(entry["created_at"] ?? ""),
          });
        }
      }
    }
  }
  const instruction = run["kind"] === "ping"
    ? "Ping de prueba de Loki: responde con un evento result con el texto «Conexión lista»."
    : String(run["instruction"] ?? "").slice(0, 4000);

  await svcRest(
    `/agent_runs?id=eq.${encodeURIComponent(runId)}`,
    {
      method: "PATCH",
      body: {
        run_token_hash: tokenHash,
        token_expires_at: tokenExpires.toISOString(),
        deadline_at: deadline.toISOString(),
        context,
        instruction,
      },
      prefer: "return=minimal",
    },
  );

  // Adaptador generic_webhook: cuerpo mínimo + Bearer del secreto saliente.
  // La orden y el contexto NUNCA van en el webhook: el agente los baja con
  // el token (prompt 13: agent-task) o trabaja solo con el pedido mínimo.
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (typeof conn["secret_enc"] === "string" && conn["secret_enc"] !== "") {
    const secret = await decryptSecret(
      AGENT_TOKEN_KEY,
      conn["secret_enc"] as string,
    );
    if (secret === null) {
      return failRun(
        runId,
        connectionId,
        "El secreto del agente ya no se puede leer (cambió la clave del servidor). Pégalo de nuevo en Mis agentes.",
      );
    }
    headers["authorization"] = `Bearer ${secret}`;
  }
  let status = 0;
  try {
    const res = await fetch(dispatchUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "loki.agent_task",
        v: 1,
        run_id: runId,
        run_token: runToken,
        attempt: 0,
      }),
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });
    status = res.status;
    // Se consume el cuerpo para no dejar la conexión colgada; no se exige forma.
    try {
      await res.text();
    } catch {
      // Sin cuerpo: igual vale el código de estado.
    }
  } catch {
    status = 0;
  }

  if (status >= 200 && status < 300) {
    await svcRest(
      `/agent_runs?id=eq.${encodeURIComponent(runId)}`,
      {
        method: "PATCH",
        body: { status: "dispatched" },
        prefer: "return=minimal",
      },
    );
    await appendEvent(runId, "ack", "Pedido enviado al agente.");
    await svcRest(
      `/agent_connections?id=eq.${encodeURIComponent(connectionId)}`,
      {
        method: "PATCH",
        body: {
          status: "active",
          last_error: null,
          last_used_at: new Date().toISOString(),
        },
        prefer: "return=minimal",
      },
    );
    return json(200, { ok: true, status: "dispatched" });
  }
  const reason = status === 0
    ? "No se pudo llegar a la URL de disparo (red o tiempo agotado). Revisa la URL en Mis agentes."
    : `La URL de disparo respondió ${status}. Revisa la URL y el secreto en Mis agentes.`;
  return failRun(runId, connectionId, reason);
});
