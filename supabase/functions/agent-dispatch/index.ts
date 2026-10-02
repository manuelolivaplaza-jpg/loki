// =============================================================================
// Agentes personales · Edge Function `agent-dispatch` (Deno, cero imports
// salvo `../_shared/agents.ts`).
//
// La despierta el trigger `notify_agent_dispatch` (pg_net) con la clave
// interna AGENT_DISPATCH_KEY, un usuario con su JWT (reintento manual) o la
// RPC `agent_continue_run` (continuación tras needs_input). Nada queda
// escuchando: corre solo cuando hay una ejecución encolada o continuada.
//
// Pasos: valida conexión activa + grant + cuotas (por agente/espacio, por
// usuario y por espacio), genera el token de la ejecución (guarda solo su
// hash), arma el contexto permitido (mensajes recientes solo si el grant lo
// autoriza; nunca DMs salvo invocación ahí y permiso), y llama al adaptador
// del proveedor. Después marca dispatched y termina.
//
// Adaptadores (todo configurable desde la conexión, nada hardcodeado):
//   · generic_webhook (referencia): POST mínimo firmado con HMAC-SHA256
//     (`X-Loki-Signature` + `X-Loki-Timestamp`) + Bearer por compatibilidad.
//     La tarea completa se baja con el token en `agent-task`.
//   · grokbot: disparo de rutina por webhook con la tarea, la URL de
//     agent-callback y el token en el cuerpo (fallback: la rutina hace POST al
//     callback según sus instrucciones; no verificado canal oficial de
//     retorno). URL, cabeceras y campos extra configurables.
//   · hermes: sin API oficial verificada: `config.mode="a2a"` usa el camino
//     A2A; si no, el webhook genérico. Ver docs/AGENTES.md qué verificar.
//   · a2a: mapea la tarea de Loki a Task A2A (tasks/send) con metadata de
//     retorno a agent-callback. Ver mapa en docs/AGENTES.md.
//
// Secretos (supabase/functions/.env): AGENT_TOKEN_KEY (cifra lo saliente),
// AGENT_DISPATCH_KEY (clave interna del trigger), AGENT_ALLOW_PRIVATE=true
// solo en desarrollo (permite URLs locales), AGENT_PUBLIC_FUNCTIONS_URL (base
// https que el agente usa para el callback y la tarea).
// =============================================================================

import {
  a2AStateToLoki,
  callbackUrlOf,
  cleanUrl,
  decryptSecret,
  grokbotDispatchBody,
  hmacSha256Hex,
  isAgentProvider,
  isBlockedDispatchHost,
  lokiTaskToA2A,
  publicFunctionsBase,
  randomToken,
  sha256Hex,
  taskUrlOf,
  type AgentTaskFull,
} from "../_shared/agents.ts";

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const AGENT_TOKEN_KEY = Deno.env.get("AGENT_TOKEN_KEY") ?? "";
const AGENT_DISPATCH_KEY = Deno.env.get("AGENT_DISPATCH_KEY") ?? "";
const PUBLIC_BASE = publicFunctionsBase(Deno.env.get("AGENT_PUBLIC_FUNCTIONS_URL") ?? "");
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
// Topes diarios visibles (además del daily_limit del grant, que se muestra en
// Uso de IA): por usuario y por espacio, para que un bot no acapare el chat.
const USER_DAILY_LIMIT = 30;
const SPACE_DAILY_LIMIT = 100;

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
  if (connectionId !== "") {
    await svcRest(
      `/agent_connections?id=eq.${encodeURIComponent(connectionId)}`,
      {
        method: "PATCH",
        body: { status: "error", last_error: message.slice(0, 280) },
        prefer: "return=minimal",
      },
    );
  }
  return json(502, { code: "dispatch_failed", message });
}

/** Quita menciones a otros agentes de la instrucción (anti-bucles). */
function stripAgentMentions(instruction: string, handles: string[]): string {
  let out = instruction;
  for (const handle of handles) {
    if (handle === "") continue;
    const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`@${escaped}\\b`, "gi"), "@mención");
  }
  return out.slice(0, 4000);
}

async function postSigned(
  url: string,
  body: unknown,
  secret: string | null,
  extraHeaders: Record<string, string>,
): Promise<number> {
  const raw = JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...extraHeaders,
  };
  if (secret !== null && secret !== "") {
    const stamp = String(Date.now());
    headers["authorization"] = `Bearer ${secret}`;
    try {
      headers["x-loki-signature"] = await hmacSha256Hex(secret, `${stamp}.${raw}`);
      headers["x-loki-timestamp"] = stamp;
    } catch {
      // Sin firma igual se intenta el envío con Bearer.
    }
  }
  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: raw,
      signal: AbortSignal.timeout(DISPATCH_TIMEOUT_MS),
    });
    try {
      await res.text();
    } catch {
      // Sin cuerpo: igual vale el código de estado.
    }
    return res.status;
  } catch {
    return 0;
  }
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
  const record = isRecord(body) ? body : {};
  const runId = typeof record["run_id"] === "string" ? record["run_id"].trim() : "";
  const action = typeof record["action"] === "string" ? record["action"].trim() : "";
  if (runId === "") {
    return json(400, { code: "bad_request", message: "Falta run_id." });
  }

  const runRes = await svcRest(
    `/agent_runs?id=eq.${encodeURIComponent(runId)}&select=*`,
  );
  const run = pickRow(runRes.data);
  if (run === null) return json(404, { code: "not_found" });

  // Cancelación best-effort: avisa al proveedor si configuró cancel_url.
  if (action === "cancel") {
    const connRes = await svcRest(
      `/agent_connections?id=eq.${encodeURIComponent(String(run["connection_id"] ?? ""))}&select=*`,
    );
    const conn = pickRow(connRes.data);
    const config = conn !== null && isRecord(conn["config"]) ? conn["config"] : {};
    const cancelUrl = cleanUrl(config["cancel_url"]);
    if (cancelUrl !== null) {
      try {
        const parsed = new URL(cancelUrl);
        if (!isBlockedDispatchHost(parsed.hostname, ALLOW_PRIVATE)) {
          await fetch(cancelUrl, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ run_id: runId, status: "cancelled" }),
            signal: AbortSignal.timeout(5000),
          }).catch(() => undefined);
        }
      } catch {
        // Best-effort: el 409 del callback ya detiene al agente.
      }
    }
    await appendEvent(runId, "cancelled", "Ejecución cancelada.");
    return json(200, { ok: true, status: "cancelled" });
  }

  const isContinue = action === "continue" ||
    (internal && (run["status"] === "running" || run["status"] === "needs_input"));
  if (!isContinue && run["status"] !== "queued") {
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

  // Cuotas visibles (grant + usuario + espacio). SQL barato, sin LLM.
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayIso = dayStart.toISOString();
  if (!isContinue) {
    const dailyLimit = typeof grant?.["daily_limit"] === "number"
      ? (grant["daily_limit"] as number)
      : 20;
    const usedRes = await svcRest(
      `/agent_runs?connection_id=eq.${encodeURIComponent(connectionId)}&workspace_id=eq.${encodeURIComponent(wsId)}&created_at=gte.${encodeURIComponent(dayIso)}&select=id`,
    );
    const used = Array.isArray(usedRes.data) ? usedRes.data.length : 0;
    if (used >= dailyLimit) {
      return failRun(
        runId,
        connectionId,
        "Este agente llegó a su tope diario en este espacio. Inténtalo mañana.",
      );
    }
    if (requestedBy !== "") {
      const userRes = await svcRest(
        `/agent_runs?workspace_id=eq.${encodeURIComponent(wsId)}&requested_by=eq.${encodeURIComponent(requestedBy)}&created_at=gte.${encodeURIComponent(dayIso)}&select=id`,
      );
      const userUsed = Array.isArray(userRes.data) ? userRes.data.length : 0;
      if (userUsed >= USER_DAILY_LIMIT) {
        return failRun(
          runId,
          connectionId,
          "Llegaste a tu tope diario de invocaciones en este espacio. Inténtalo mañana.",
        );
      }
    }
    const spaceRes = await svcRest(
      `/agent_runs?workspace_id=eq.${encodeURIComponent(wsId)}&created_at=gte.${encodeURIComponent(dayIso)}&select=id`,
    );
    const spaceUsed = Array.isArray(spaceRes.data) ? spaceRes.data.length : 0;
    if (spaceUsed >= SPACE_DAILY_LIMIT) {
      return failRun(
        runId,
        connectionId,
        "Este espacio llegó a su tope diario de invocaciones. Inténtalo mañana.",
      );
    }
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
  const extraHeaders: Record<string, string> = {};
  if (isRecord(config["headers"])) {
    for (const [key, value] of Object.entries(config["headers"])) {
      if (typeof value === "string" && value !== "" && key.length <= 64) {
        extraHeaders[key.toLowerCase()] = value.slice(0, 500);
      }
    }
  }
  delete extraHeaders["authorization"];

  // Token de la ejecución: el claro viaja SOLO al agente; aquí queda su hash.
  // En continuaciones se reutiliza el token vivo (si sigue vigente).
  let runToken = "";
  let tokenHash = typeof run["run_token_hash"] === "string"
    ? (run["run_token_hash"] as string)
    : "";
  let tokenExpires = typeof run["token_expires_at"] === "string"
    ? String(run["token_expires_at"])
    : "";
  const tokenAlive = tokenHash !== "" && tokenExpires !== "" &&
    Date.parse(tokenExpires) > Date.now() + 60_000;
  const deadline = new Date(Date.now() + DEFAULT_DEADLINE_MIN * 60_000);
  const tokenExpiresDate = new Date(deadline.getTime() + 10 * 60_000);
  if (!isContinue || !tokenAlive) {
    runToken = randomToken();
    tokenHash = await sha256Hex(runToken);
    tokenExpires = tokenExpiresDate.toISOString();
  }

  // Contexto mínimo: últimos mensajes si el grant lo autoriza. Nada de DMs
  // salvo invocación dentro de ese DM con permiso explícito.
  const context: Array<{ author: string; text: string; at: string }> = [];
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
  // Anti-bucles: la instrucción nunca arrastra menciones a otros agentes.
  const handlesRes = await svcRest(
    `/agent_connections?select=handle&limit=100`,
  );
  const handles = Array.isArray(handlesRes.data)
    ? handlesRes.data.filter(isRecord).map((row) =>
      typeof row["handle"] === "string" ? (row["handle"] as string) : ""
    ).filter((h) => h !== "")
    : [];
  const rawInstruction = run["kind"] === "ping"
    ? "Ping de prueba de Loki: responde con un evento result con el texto «Conexión lista»."
    : String(run["instruction"] ?? "").slice(0, 4000);
  const instruction = stripAgentMentions(rawInstruction, handles);
  if (run["kind"] !== "ping" && instruction.trim() === "") {
    return failRun(runId, connectionId, "La instrucción quedó vacía al quitar menciones.");
  }

  const history = Array.isArray(run["history"]) ? run["history"] : [];
  const attempt = typeof run["attempts"] === "number" ? run["attempts"] as number : 0;

  await svcRest(
    `/agent_runs?id=eq.${encodeURIComponent(runId)}`,
    {
      method: "PATCH",
      body: {
        run_token_hash: tokenHash,
        token_expires_at: tokenExpires,
        deadline_at: isContinue && typeof run["deadline_at"] === "string"
          ? run["deadline_at"]
          : deadline.toISOString(),
        context,
        instruction,
      },
      prefer: "return=minimal",
    },
  );

  // Secreto saliente (para HMAC/Bearer). Si cambió la clave del servidor, se
  // avisa en vez de mandar un pedido sin firmar.
  let outboundSecret: string | null = null;
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
    outboundSecret = secret;
  }

  const handle = typeof conn["handle"] === "string" ? (conn["handle"] as string) : "bot";
  const connectionName = typeof conn["name"] === "string" && conn["name"] !== ""
    ? (conn["name"] as string)
    : handle;
  const callbackUrl = callbackUrlOf(PUBLIC_BASE);
  const taskUrl = taskUrlOf(PUBLIC_BASE);
  const fullTask: AgentTaskFull = {
    run_id: runId,
    connection_id: connectionId,
    handle,
    instruction,
    requested_by: requestedBy,
    space: { id: wsId, name: "" },
    chat: { id: String(run["chat_id"] ?? ""), name: "" },
    context_messages: context,
    history: history.filter(isRecord).map((entry) => ({
      from: entry["from"] === "user" ? "user" as const : "agent" as const,
      text: String(entry["text"] ?? "").slice(0, 4000),
      at: String(entry["at"] ?? ""),
    })),
    allowed_actions: grant === null || grant["allow_propose_actions"] !== false
      ? ["create_task", "create_event", "create_reminder", "add_list_items"]
      : [],
    limits: { max_events: 30, result_chars: 16384, max_links: 10 },
    deadline_at: isContinue && typeof run["deadline_at"] === "string"
      ? String(run["deadline_at"])
      : deadline.toISOString(),
  };

  let payload: unknown;
  if (provider === "grokbot") {
    // Rutina por webhook: tarea + retorno en el cuerpo (el callback lo hace
    // la propia rutina según sus instrucciones; ver docs/AGENTES.md).
    payload = {
      ...grokbotDispatchBody(fullTask, {
        runToken: tokenAlive && runToken === "" ? "" : runToken,
        attempt: attempt + 1,
        callbackUrl,
        taskUrl,
        handle,
      }),
      space_name: connectionName,
    };
    // Si el token se reutilizó (continuación), el claro no está en memoria:
    // se genera uno nuevo para no mandar vacío.
    const bodyRecord = payload as Record<string, unknown>;
    if (bodyRecord["run_token"] === "") {
      const fresh = randomToken();
      bodyRecord["run_token"] = fresh;
      await svcRest(`/agent_runs?id=eq.${encodeURIComponent(runId)}`, {
        method: "PATCH",
        body: {
          run_token_hash: await sha256Hex(fresh),
          token_expires_at: tokenExpiresDate.toISOString(),
        },
        prefer: "return=minimal",
      });
    }
  } else if (provider === "a2a" || (provider === "hermes" && config["mode"] === "a2a")) {
    payload = lokiTaskToA2A(fullTask, {
      callbackUrl,
      runToken: tokenAlive && runToken === "" ? "" : runToken,
    });
    const params = (payload as { params: Record<string, unknown> }).params;
    if (params["metadata"] !== undefined && isRecord(params["metadata"])) {
      (params["metadata"] as Record<string, unknown>)["loki_provider"] = provider;
    }
    void a2AStateToLoki;
  } else {
    // generic_webhook (referencia) y hermes en modo webhook: pedido mínimo
    // firmado; la tarea completa se baja con el token en agent-task.
    payload = {
      type: "loki.agent_task",
      v: 1,
      run_id: runId,
      run_token: tokenAlive && runToken === "" ? "" : runToken,
      attempt: attempt + 1,
      ...(callbackUrl !== null ? { callback_url: callbackUrl } : {}),
      ...(taskUrl !== null ? { task_url: taskUrl } : {}),
    };
    const minimal = payload as Record<string, unknown>;
    if (minimal["run_token"] === "") {
      const fresh = randomToken();
      minimal["run_token"] = fresh;
      await svcRest(`/agent_runs?id=eq.${encodeURIComponent(runId)}`, {
        method: "PATCH",
        body: {
          run_token_hash: await sha256Hex(fresh),
          token_expires_at: tokenExpiresDate.toISOString(),
        },
        prefer: "return=minimal",
      });
    }
  }

  const status = await postSigned(dispatchUrl, payload, outboundSecret, extraHeaders);

  if (status >= 200 && status < 300) {
    await svcRest(
      `/agent_runs?id=eq.${encodeURIComponent(runId)}`,
      {
        method: "PATCH",
        body: isContinue ? {} : { status: "dispatched" },
        prefer: "return=minimal",
      },
    );
    if (!isContinue) {
      await appendEvent(runId, "ack", "Pedido enviado al agente.");
    } else {
      await appendEvent(runId, "progress", "Respuesta enviada al agente.");
    }
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
    return json(200, { ok: true, status: isContinue ? "running" : "dispatched" });
  }
  if (isContinue) {
    await appendEvent(runId, "progress", "No se pudo reenviar al agente; reinténtalo.");
    return json(502, {
      code: "dispatch_failed",
      message: "No se pudo reenviar la respuesta al agente.",
    });
  }
  const reason = status === 0
    ? "No se pudo llegar a la URL de disparo (red o tiempo agotado). Revisa la URL en Mis agentes."
    : `La URL de disparo respondió ${status}. Revisa la URL y el secreto en Mis agentes.`;
  return failRun(runId, connectionId, reason);
});
