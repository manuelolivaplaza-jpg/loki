// =============================================================================
// Agentes personales · Edge Function `agent-callback` (Deno, cero imports
// salvo `../_shared/agents.ts`).
//
// La llama el AGENTE (un tercero sin JWT de Supabase): por eso lleva
// `verify_jwt = false` en supabase/config.toml. Toda la autenticación es
// propia: Bearer <run_token> de la ejecución + (si la conexión tiene token
// entrante) cabecera X-Loki-Token con el token largo de la conexión.
//
// POST { run_id?, event_id, type, text?, percent?, question?, links?,
//        proposed_actions? } (run_id también vale en X-Loki-Run).
//   · type: progress | needs_input | result | error (lo demás lo pone Loki).
//   · event_id repetido -> 200 {duplicate:true} sin duplicar.
//   · ejecución terminal o inexistente -> 409 {status} (el agente se detiene).
//   · token vencido o inválido -> 401/410.
//
// Límites (contrato, ver docs/AGENTES.md): 30 eventos por ejecución, 1
// progreso cada 20 s, resultado de máx. 16 KB y 10 enlaces https, 60 req/min
// por conexión (429 en español). Con result: estado done + resultado
// guardado (las proposed_actions las confirma el usuario con su JWT en la
// tarjeta; el agente nunca escribe directo). El hilo, el mensaje en el chat
// y la push los arma el prompt 13 sobre estas filas.
//
// Todo lo que llega se guarda como texto (safe-text en la UI, nunca se
// ejecuta).
// =============================================================================

import {
  AGENT_MAX_EVENTS,
  AGENT_MAX_RESULT_TEXT,
  AGENT_MAX_TEXT,
  AGENT_PROGRESS_MIN_MS,
  isInboundEventType,
  isTerminalStatus,
  sameHash,
  sanitizeActions,
  sanitizeLinks,
  sha256Hex,
} from "../_shared/agents.ts";

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers":
    "authorization, content-type, apikey, x-loki-run, x-loki-token",
};

const CALLBACK_RATE_MAX = 60;
const CALLBACK_RATE_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, number[]>();

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRateLimited(key: string): boolean {
  const now = Date.now();
  const stamps = (rateBuckets.get(key) ?? []).filter(
    (stamp) => now - stamp < CALLBACK_RATE_WINDOW_MS,
  );
  if (stamps.length >= CALLBACK_RATE_MAX) {
    rateBuckets.set(key, stamps);
    return true;
  }
  stamps.push(now);
  if (rateBuckets.size > 2000) {
    const oldest = rateBuckets.keys().next();
    if (!oldest.done) rateBuckets.delete(oldest.value);
  }
  rateBuckets.set(key, stamps);
  return false;
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

function bearerToken(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  return header.toLowerCase().startsWith("bearer ")
    ? header.slice("bearer ".length).trim()
    : "";
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

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }
  if (!isRecord(body)) {
    return json(400, { code: "bad_request", message: "Pedido inválido." });
  }

  const headerRun = (req.headers.get("x-loki-run") ?? "").trim();
  const runId = typeof body["run_id"] === "string" &&
      body["run_id"].trim() !== ""
    ? (body["run_id"] as string).trim()
    : headerRun;
  if (runId === "") {
    return json(400, { code: "bad_request", message: "Falta run_id." });
  }

  const runRes = await svcRest(
    `/agent_runs?id=eq.${encodeURIComponent(runId)}&select=*`,
  );
  const run = pickRow(runRes.data);
  if (run === null) {
    return json(409, { code: "unknown_run", status: "cancelled" });
  }
  const status = String(run["status"] ?? "");
  if (isTerminalStatus(status)) {
    return json(409, { code: "run_closed", status });
  }
  if (
    typeof run["cancel_requested_at"] === "string" &&
    run["cancel_requested_at"] !== ""
  ) {
    await svcRest(`/agent_runs?id=eq.${encodeURIComponent(runId)}`, {
      method: "PATCH",
      body: { status: "cancelled" },
      prefer: "return=minimal",
    });
    return json(409, { code: "run_closed", status: "cancelled" });
  }

  // Token de la ejecución (hash en tiempo constante + vigencia).
  const token = bearerToken(req);
  if (token === "" || typeof run["run_token_hash"] !== "string") {
    return json(401, { code: "bad_token" });
  }
  const presented = await sha256Hex(token);
  if (!sameHash(presented, run["run_token_hash"] as string)) {
    return json(401, { code: "bad_token" });
  }
  if (
    typeof run["token_expires_at"] === "string" &&
    Date.parse(run["token_expires_at"] as string) < Date.now()
  ) {
    return json(410, { code: "token_expired", status });
  }

  // Conexión + segundo factor opcional (token largo de la conexión).
  const connRes = await svcRest(
    `/agent_connections?id=eq.${encodeURIComponent(String(run["connection_id"] ?? ""))}&select=*`,
  );
  const conn = pickRow(connRes.data);
  if (conn === null || conn["status"] !== "active") {
    return json(409, { code: "agent_paused", status: "cancelled" });
  }
  const connectionId = String(conn["id"] ?? "");
  if (
    typeof conn["inbound_token_hash"] === "string" &&
    conn["inbound_token_hash"] !== ""
  ) {
    const longToken = (req.headers.get("x-loki-token") ?? "").trim();
    if (longToken === "") {
      return json(401, { code: "missing_agent_token" });
    }
    const longHash = await sha256Hex(longToken);
    if (!sameHash(longHash, conn["inbound_token_hash"] as string)) {
      return json(401, { code: "bad_agent_token" });
    }
  }

  if (isRateLimited(connectionId)) {
    return json(429, {
      code: "rate_limited",
      message: "Demasiados eventos. Baja el ritmo e inténtalo de nuevo.",
    });
  }

  const eventId = typeof body["event_id"] === "string"
    ? body["event_id"].trim().slice(0, 64)
    : "";
  if (eventId === "") {
    return json(400, { code: "bad_event", message: "Falta event_id." });
  }
  if (!isInboundEventType(body["type"])) {
    return json(400, { code: "bad_event", message: "Tipo de evento inválido." });
  }
  const type = body["type"] as string;

  // Idempotencia: event_id repetido no duplica.
  const dupe = await svcRest(
    `/agent_run_events?run_id=eq.${encodeURIComponent(runId)}&client_event_id=eq.${encodeURIComponent(eventId)}&select=id`,
  );
  if (Array.isArray(dupe.data) && dupe.data.length > 0) {
    return json(200, { duplicate: true, status });
  }

  const existing = await svcRest(
    `/agent_run_events?run_id=eq.${encodeURIComponent(runId)}&select=seq,type,created_at&order=seq.desc&limit=${AGENT_MAX_EVENTS + 1}`,
  );
  const events = Array.isArray(existing.data) ? existing.data : [];
  if (events.length >= AGENT_MAX_EVENTS) {
    return json(429, {
      code: "too_many_events",
      message: "Esta ejecución ya mandó demasiados eventos.",
    });
  }
  const nextSeq = events.reduce((max: number, entry: unknown) => {
    if (!isRecord(entry) || typeof entry["seq"] !== "number") return max;
    return Math.max(max, entry["seq"] as number);
  }, -1) + 1;

  if (type === "progress") {
    const latest = events.find((entry): entry is Record<string, unknown> =>
      isRecord(entry) && entry["type"] === "progress");
    if (
      latest !== undefined && typeof latest["created_at"] === "string" &&
      Date.now() - Date.parse(latest["created_at"] as string) <
        AGENT_PROGRESS_MIN_MS
    ) {
      return json(429, {
        code: "too_fast",
        message: "Un aviso de progreso cada 20 segundos como máximo.",
      });
    }
  }

  const text = typeof body["text"] === "string"
    ? body["text"].slice(0, type === "result" ? AGENT_MAX_RESULT_TEXT : AGENT_MAX_TEXT)
    : "";
  const percent = typeof body["percent"] === "number" &&
      Number.isFinite(body["percent"])
    ? Math.max(0, Math.min(100, Math.floor(body["percent"])))
    : null;
  const question = typeof body["question"] === "string"
    ? body["question"].trim().slice(0, AGENT_MAX_TEXT)
    : "";
  if (type === "needs_input" && question === "") {
    return json(400, {
      code: "bad_event",
      message: "La aclaración necesita una pregunta.",
    });
  }
  if ((type === "result" || type === "error") && text === "") {
    return json(400, {
      code: "bad_event",
      message: "El resultado necesita un texto.",
    });
  }

  // Grant para filtrar acciones propuestas (sin publish => sin propuestas).
  const grantRes = await svcRest(
    `/agent_space_grants?connection_id=eq.${encodeURIComponent(connectionId)}&workspace_id=eq.${encodeURIComponent(String(run["workspace_id"] ?? ""))}&select=allow_propose_actions`,
  );
  const grant = pickRow(grantRes.data);
  const mayPropose = grant === null || grant["allow_propose_actions"] !== false;
  const links = type === "result" ? body["links"] : [];
  const actions = type === "result" && mayPropose ? body["proposed_actions"] : [];
  const payload: Record<string, unknown> = {};
  if (type === "progress" && percent !== null) payload["percent"] = percent;
  if (type === "needs_input") payload["question"] = question;
  if (type === "result") {
    payload["links"] = sanitizeLinks(links);
    payload["proposed_actions"] = sanitizeActions(actions);
  }

  const inserted = await svcRest("/agent_run_events", {
    method: "POST",
    body: {
      run_id: runId,
      seq: nextSeq,
      type,
      text: type === "needs_input" ? question : text,
      percent,
      client_event_id: eventId,
      payload,
    },
    prefer: "return=minimal",
  });
  if (!inserted.ok) {
    // Carrera con otro evento del mismo seq: el agente reintenta con el
    // MISMO event_id y recibe duplicate.
    return json(409, { code: "retry_same_event", status });
  }

  const patch: Record<string, unknown> = {};
  if (type === "progress" && (status === "queued" || status === "dispatched")) {
    patch["status"] = "running";
  }
  if (type === "needs_input") patch["status"] = "needs_input";
  if (type === "result") {
    patch["status"] = "done";
    patch["result"] = { text, links: payload["links"], proposed_actions: payload["proposed_actions"] };
    patch["finished_at"] = new Date().toISOString();
    patch["run_token_hash"] = null;
  }
  if (type === "error") {
    patch["status"] = "error";
    patch["error"] = text.slice(0, 500);
    patch["finished_at"] = new Date().toISOString();
    patch["run_token_hash"] = null;
  }
  if (Object.keys(patch).length > 0) {
    await svcRest(`/agent_runs?id=eq.${encodeURIComponent(runId)}`, {
      method: "PATCH",
      body: patch,
      prefer: "return=minimal",
    });
  }
  if (type === "result" || type === "error") {
    await svcRest(
      `/agent_connections?id=eq.${encodeURIComponent(connectionId)}`,
      {
        method: "PATCH",
        body: { last_used_at: new Date().toISOString() },
        prefer: "return=minimal",
      },
    );
  }
  return json(200, {
    ok: true,
    status: String(
      (patch["status"] as string | undefined) ?? status,
    ),
  });
});
