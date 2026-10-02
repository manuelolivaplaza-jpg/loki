// =============================================================================
// Agentes personales · Edge Function `agent-task` (Deno, cero imports salvo
// `../_shared/agents.ts`).
//
// El AGENTE baja la tarea completa con su token: GET con
// `Authorization: Bearer <run_token>` (+ `X-Loki-Token` si la conexión tiene
// token entrante). `verify_jwt = false` en supabase/config.toml porque el
// agente es un tercero sin JWT de Supabase.
//
// Responde el contrato de docs/AGENTES.md (instruction, context_messages,
// history, allowed_actions, limits, deadline_at). Al bajarla por primera vez
// marca running (el agente despertó de verdad) con un evento `ack`.
//
// Todo lo que se entrega ya pasó por los permisos del grant en
// agent-dispatch (contexto recortado, sin DMs salvo permiso).
// =============================================================================

import {
  sameHash,
  sha256Hex,
  type AgentTaskFull,
} from "../_shared/agents.ts";

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers":
    "authorization, content-type, apikey, x-loki-token",
};

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
  if (req.method !== "GET" && req.method !== "POST") {
    return json(405, { code: "method_not_allowed" });
  }

  let runId = "";
  if (req.method === "GET") {
    const url = new URL(req.url);
    runId = (url.searchParams.get("run_id") ?? "").trim();
  } else {
    let body: unknown = null;
    try {
      body = await req.json();
    } catch {
      body = null;
    }
    if (isRecord(body) && typeof body["run_id"] === "string") {
      runId = body["run_id"].trim();
    }
  }
  if (runId === "") {
    return json(400, { code: "bad_request", message: "Falta run_id." });
  }

  const runRes = await svcRest(
    `/agent_runs?id=eq.${encodeURIComponent(runId)}&select=*`,
  );
  const run = pickRow(runRes.data);
  if (run === null) return json(404, { code: "not_found" });
  const status = String(run["status"] ?? "");
  if (
    status === "done" || status === "error" || status === "cancelled" ||
    status === "expired"
  ) {
    return json(409, { code: "run_closed", status });
  }

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

  const connRes = await svcRest(
    `/agent_connections?id=eq.${encodeURIComponent(String(run["connection_id"] ?? ""))}&select=*`,
  );
  const conn = pickRow(connRes.data);
  if (conn === null || conn["status"] !== "active") {
    return json(409, { code: "agent_paused", status: "cancelled" });
  }
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

  const grantRes = await svcRest(
    `/agent_space_grants?connection_id=eq.${encodeURIComponent(String(conn["id"] ?? ""))}&workspace_id=eq.${encodeURIComponent(String(run["workspace_id"] ?? ""))}&select=allow_propose_actions`,
  );
  const grant = pickRow(grantRes.data);
  const mayPropose = grant === null || grant["allow_propose_actions"] !== false;

  const contextRaw = Array.isArray(run["context"]) ? run["context"] : [];
  const contextMessages = contextRaw.filter(isRecord).map((entry) => ({
    author: String(entry["author"] ?? "").slice(0, 60),
    text: String(entry["text"] ?? "").slice(0, 500),
    at: String(entry["at"] ?? ""),
  }));
  const historyRaw = Array.isArray(run["history"]) ? run["history"] : [];
  const history = historyRaw.filter(isRecord).map((entry) => ({
    from: entry["from"] === "user" ? "user" as const : "agent" as const,
    text: String(entry["text"] ?? "").slice(0, 4000),
    at: String(entry["at"] ?? ""),
  }));

  const task: AgentTaskFull = {
    run_id: runId,
    connection_id: String(conn["id"] ?? ""),
    handle: typeof conn["handle"] === "string" ? (conn["handle"] as string) : "bot",
    instruction: String(run["instruction"] ?? "").slice(0, 4000),
    requested_by: typeof run["requested_by"] === "string"
      ? (run["requested_by"] as string)
      : "",
    space: {
      id: String(run["workspace_id"] ?? ""),
      name: "",
    },
    chat: { id: String(run["chat_id"] ?? ""), name: "" },
    context_messages: contextMessages,
    history,
    allowed_actions: mayPropose
      ? ["create_task", "create_event", "create_reminder", "add_list_items"]
      : [],
    limits: { max_events: 30, result_chars: 16384, max_links: 10 },
    deadline_at: typeof run["deadline_at"] === "string"
      ? (run["deadline_at"] as string)
      : null,
  };

  // Primera bajada = el agente despertó de verdad.
  if (status === "queued" || status === "dispatched") {
    await svcRest(`/agent_runs?id=eq.${encodeURIComponent(runId)}`, {
      method: "PATCH",
      body: { status: "running" },
      prefer: "return=minimal",
    });
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
      body: { run_id: runId, seq: last + 1, type: "ack", text: "El agente bajó la tarea." },
      prefer: "return=minimal",
    });
  }

  return json(200, { task });
});
