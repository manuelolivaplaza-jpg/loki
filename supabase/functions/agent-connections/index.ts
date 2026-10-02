// =============================================================================
// Agentes personales · Edge Function `agent-connections` (Deno, cero imports
// salvo `../_shared/agents.ts`).
//
// - GET  -> { configured } (¿hay AGENT_TOKEN_KEY? Sin ella no hay secretos).
// - POST -> JSON { action, ... } con el JWT del usuario (se valida contra
//   Auth `/auth/v1/user`, igual que `google-calendar`).
//
// Acciones (todas de dueño; los secretos nunca vuelven al cliente):
//   create        -> {provider, name, handle, description?, avatar_emoji?,
//                    workspace_id?, grant?}: crea la conexión y su primer grant.
//   update        -> {connection_id, name?, handle?, description?,
//                    avatar_emoji?}: edita lo visible (nunca secretos).
//   set-outbound  -> {connection_id, dispatch_url, outbound_secret?}: guarda
//                    la URL en config y la key CIFRADA (AES-GCM + AGENT_TOKEN_KEY).
//   rotate-inbound-> {connection_id}: genera el token entrante, guarda solo su
//                    hash y devuelve el claro UNA sola vez (para copiar).
//   revoke-inbound-> {connection_id}: invalida el token entrante.
//   set-status    -> {connection_id, status}: active|paused (error lo pone la
//                    Edge de despacho, no el cliente).
//   remove        -> {connection_id}: borra (caen grants y ejecuciones).
//
// Secretos (supabase/functions/.env, gitignored): AGENT_TOKEN_KEY (32+ chars).
// Sin ella: 503 { code:'not_configured' } en lo que toque secretos.
// Límite: 30 req/min por IP+JWT (429 amable en español).
//
// Secretos de Supabase (los pone el runtime): SUPABASE_URL,
// SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
// =============================================================================

import {
  cleanHandle,
  decryptSecret,
  encryptSecret,
  isAgentProvider,
  randomToken,
  sha256Hex,
} from "../_shared/agents.ts";

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const AGENT_TOKEN_KEY = Deno.env.get("AGENT_TOKEN_KEY") ?? "";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, apikey",
};

// --- Límite de peticiones (igual que google-calendar) --------------------------

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
  if (rateBuckets.size > 2000) {
    const oldest = rateBuckets.keys().next();
    if (!oldest.done) rateBuckets.delete(oldest.value);
  }
  rateBuckets.set(key, stamps);
  return false;
}

// --- Utilidades ----------------------------------------------------------------

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  if (clean === "" || clean.length > max) return null;
  return clean;
}

async function authUser(
  req: Request,
): Promise<{ uid: string; token: string } | null> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ")
    ? header.slice("bearer ".length).trim()
    : "";
  if (token === "" || SUPABASE_URL === "" || SUPABASE_ANON_KEY === "") {
    return null;
  }
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

/** Llama a la RPC con el JWT del USUARIO (respeta su RLS y su auth.uid()). */
async function userRpc(
  userToken: string,
  fn: string,
  body: unknown,
): Promise<{ ok: boolean; data: unknown }> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        authorization: `Bearer ${userToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: res.ok, data };
  } catch {
    return { ok: false, data: null };
  }
}

function hasSecrets(): boolean {
  return AGENT_TOKEN_KEY.length >= 32;
}

type SafeConnection = {
  id: string;
  provider: string;
  name: string;
  handle: string;
  description: string;
  avatar_emoji: string;
  has_outbound: boolean;
  has_inbound: boolean;
  status: string;
  last_error: string | null;
  last_used_at: string | null;
};

function toSafe(row: Record<string, unknown>): SafeConnection {
  const config = isRecord(row["config"]) ? row["config"] : {};
  return {
    id: String(row["id"] ?? ""),
    provider: String(row["provider"] ?? ""),
    name: String(row["name"] ?? ""),
    handle: String(row["handle"] ?? ""),
    description: String(row["description"] ?? ""),
    avatar_emoji: typeof row["avatar_emoji"] === "string" &&
        row["avatar_emoji"] !== ""
      ? (row["avatar_emoji"] as string)
      : "🤖",
    has_outbound: typeof row["secret_enc"] === "string" &&
      row["secret_enc"] !== "",
    has_inbound: typeof row["inbound_token_hash"] === "string" &&
      row["inbound_token_hash"] !== "",
    status: String(row["status"] ?? "active"),
    last_error: typeof row["last_error"] === "string"
      ? (row["last_error"] as string)
      : null,
    last_used_at: typeof row["last_used_at"] === "string"
      ? (row["last_used_at"] as string)
      : null,
  };
}

function pickRow(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) {
    const first = data[0];
    return isRecord(first) ? first : null;
  }
  return isRecord(data) ? data : null;
}

async function ownConnection(
  uid: string,
  connectionId: string,
): Promise<Record<string, unknown> | null> {
  if (connectionId === "") return null;
  const res = await svcRest(
    `/agent_connections?id=eq.${encodeURIComponent(connectionId)}&select=*`,
  );
  const row = pickRow(res.data);
  if (row === null || String(row["owner_id"] ?? "") !== uid) return null;
  return row;
}

// --- Acciones ------------------------------------------------------------------

async function actionCreate(
  uid: string,
  userToken: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const provider = body["provider"];
  if (!isAgentProvider(provider)) {
    return json(400, {
      code: "bad_provider",
      message: "Proveedor desconocido. Elige uno de la lista.",
    });
  }
  const name = asText(body["name"], 60);
  if (name === null) {
    return json(400, {
      code: "bad_name",
      message: "Ponle un nombre visible a tu agente (máx. 60 caracteres).",
    });
  }
  const handle = cleanHandle(body["handle"]);
  if (handle === null) {
    return json(400, {
      code: "bad_handle",
      message:
        "Ese handle no vale: minúsculas, números, punto, guion o subrayado (2 a 31 caracteres) y distinto de @Loki.",
    });
  }
  const description = typeof body["description"] === "string"
    ? body["description"].trim().slice(0, 280)
    : "";
  const avatar = asText(body["avatar_emoji"], 8) ?? "🤖";

  const workspaceId = typeof body["workspace_id"] === "string"
    ? body["workspace_id"].trim()
    : "";
  if (workspaceId !== "") {
    const check = await userRpc(userToken, "validate_agent_handle", {
      p_workspace_id: workspaceId,
      p_handle: handle,
      p_ignore_connection_id: null,
    });
    if (!check.ok || check.data !== true) {
      return json(409, {
        code: "handle_taken",
        message:
          "Ese @handle ya está en uso en ese espacio (otro agente o un miembro) o es reservado. Prueba con otro.",
      });
    }
  }

  const created = await svcRest("/agent_connections", {
    method: "POST",
    body: {
      owner_id: uid,
      provider,
      name,
      handle,
      description,
      avatar_emoji: avatar,
      config: {},
      status: "active",
    },
    prefer: "return=representation",
  });
  const row = pickRow(created.data);
  if (!created.ok || row === null) {
    return json(500, {
      code: "create_failed",
      message: "No se pudo crear el agente. Inténtalo de nuevo.",
    });
  }
  const connectionId = String(row["id"] ?? "");

  if (workspaceId !== "") {
    const grant = isRecord(body["grant"]) ? body["grant"] : {};
    await svcRest("/agent_space_grants", {
      method: "POST",
      body: {
        connection_id: connectionId,
        workspace_id: workspaceId,
        enabled: true,
        allowed_callers: grant["allowed_callers"] === "space_members" ||
            grant["allowed_callers"] === "listed"
          ? grant["allowed_callers"]
          : "owner_only",
        allowed_user_ids: Array.isArray(grant["allowed_user_ids"])
          ? (grant["allowed_user_ids"] as unknown[]).filter((entry) =>
            typeof entry === "string"
          ).slice(0, 50)
          : [],
        allow_context: grant["allow_context"] !== false,
        context_messages: typeof grant["context_messages"] === "number" &&
            Number.isFinite(grant["context_messages"])
          ? Math.max(
            0,
            Math.min(50, Math.floor(grant["context_messages"] as number)),
          )
          : 10,
        allow_dm_context: grant["allow_dm_context"] === true,
        allow_publish: grant["allow_publish"] !== false,
        allow_propose_actions: grant["allow_propose_actions"] !== false,
        daily_limit: typeof grant["daily_limit"] === "number" &&
            Number.isFinite(grant["daily_limit"])
          ? Math.max(1, Math.min(500, Math.floor(grant["daily_limit"] as number)))
          : 20,
      },
      prefer: "return=minimal",
    });
  }
  return json(200, { connection: toSafe({ ...row, secret_enc: null }) });
}

async function actionUpdate(
  uid: string,
  userToken: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const connectionId = asText(body["connection_id"], 64) ?? "";
  const row = await ownConnection(uid, connectionId);
  if (row === null) {
    return json(404, {
      code: "not_found",
      message: "Ese agente no existe o no es tuyo.",
    });
  }
  const patch: Record<string, unknown> = {};
  if (body["name"] !== undefined) {
    const name = asText(body["name"], 60);
    if (name === null) {
      return json(400, { code: "bad_name", message: "Nombre inválido." });
    }
    patch["name"] = name;
  }
  if (body["handle"] !== undefined) {
    const handle = cleanHandle(body["handle"]);
    if (handle === null) {
      return json(400, { code: "bad_handle", message: "Handle inválido." });
    }
    patch["handle"] = handle;
  }
  if (body["description"] !== undefined) {
    patch["description"] = typeof body["description"] === "string"
      ? body["description"].trim().slice(0, 280)
      : "";
  }
  if (body["avatar_emoji"] !== undefined) {
    patch["avatar_emoji"] = asText(body["avatar_emoji"], 8) ?? "🤖";
  }
  if (Object.keys(patch).length === 0) {
    return json(200, { connection: toSafe(row) });
  }
  // Si cambia el handle, se revalida en cada espacio habilitado.
  if (typeof patch["handle"] === "string" && patch["handle"] !== row["handle"]) {
    const grants = await svcRest(
      `/agent_space_grants?connection_id=eq.${encodeURIComponent(connectionId)}&select=workspace_id`,
    );
    const rows = Array.isArray(grants.data) ? grants.data : [];
    for (const entry of rows) {
      if (!isRecord(entry)) continue;
      const wsId = String(entry["workspace_id"] ?? "");
      if (wsId === "") continue;
      const check = await userRpc(userToken, "validate_agent_handle", {
        p_workspace_id: wsId,
        p_handle: patch["handle"],
        p_ignore_connection_id: connectionId,
      });
      if (!check.ok || check.data !== true) {
        return json(409, {
          code: "handle_taken",
          message: "Ese @handle choca en uno de tus espacios. Prueba con otro.",
        });
      }
    }
  }
  const updated = await svcRest(
    `/agent_connections?id=eq.${encodeURIComponent(connectionId)}`,
    { method: "PATCH", body: patch, prefer: "return=representation" },
  );
  const next = pickRow(updated.data) ?? { ...row, ...patch };
  return json(200, { connection: toSafe(next) });
}

async function actionSetOutbound(
  uid: string,
  body: Record<string, unknown>,
): Promise<Response> {
  if (!hasSecrets()) {
    return json(503, {
      code: "not_configured",
      message:
        "Agentes sin configurar en este entorno. Pide al administrador que ponga AGENT_TOKEN_KEY.",
    });
  }
  const connectionId = asText(body["connection_id"], 64) ?? "";
  const row = await ownConnection(uid, connectionId);
  if (row === null) {
    return json(404, {
      code: "not_found",
      message: "Ese agente no existe o no es tuyo.",
    });
  }
  const dispatchUrl = typeof body["dispatch_url"] === "string"
    ? body["dispatch_url"].trim()
    : "";
  if (dispatchUrl !== "") {
    if (!/^https:\/\//i.test(dispatchUrl) || dispatchUrl.length > 2000) {
      return json(400, {
        code: "bad_url",
        message: "La URL de disparo debe empezar con https://.",
      });
    }
    try {
      const parsed = new URL(dispatchUrl);
      if (parsed.protocol !== "https:") throw new Error("no https");
    } catch {
      return json(400, {
        code: "bad_url",
        message: "Esa URL no parece válida. Revísala y pégala de nuevo.",
      });
    }
  }
  const secret = typeof body["outbound_secret"] === "string"
    ? body["outbound_secret"]
    : "";
  const prevConfig = isRecord(row["config"]) ? row["config"] : {};
  const nextConfig: Record<string, unknown> = { ...prevConfig };
  if (dispatchUrl !== "") nextConfig["dispatch_url"] = dispatchUrl;
  const patch: Record<string, unknown> = { config: nextConfig };
  if (secret !== "") {
    if (secret.length > 4000) {
      return json(400, {
        code: "bad_secret",
        message: "Ese secreto es demasiado largo.",
      });
    }
    patch["secret_enc"] = await encryptSecret(AGENT_TOKEN_KEY, secret);
  }
  // Para verificar que la clave sigue abriendo lo guardado (misma idea que
  // google-calendar: si AGENT_TOKEN_KEY cambió, lo viejo no se lee).
  if (typeof row["secret_enc"] === "string" && row["secret_enc"] !== "") {
    const probe = await decryptSecret(
      AGENT_TOKEN_KEY,
      row["secret_enc"] as string,
    );
    if (probe === null && secret === "") {
      return json(409, {
        code: "key_changed",
        message:
          "El secreto guardado ya no se puede leer (cambió la clave del servidor). Pega la key de nuevo.",
      });
    }
  }
  await svcRest(
    `/agent_connections?id=eq.${encodeURIComponent(connectionId)}`,
    { method: "PATCH", body: patch, prefer: "return=minimal" },
  );
  return json(200, { ok: true });
}

async function actionRotateInbound(
  uid: string,
  body: Record<string, unknown>,
): Promise<Response> {
  if (!hasSecrets()) {
    return json(503, {
      code: "not_configured",
      message:
        "Agentes sin configurar en este entorno. Pide al administrador que ponga AGENT_TOKEN_KEY.",
    });
  }
  const connectionId = asText(body["connection_id"], 64) ?? "";
  const row = await ownConnection(uid, connectionId);
  if (row === null) {
    return json(404, {
      code: "not_found",
      message: "Ese agente no existe o no es tuyo.",
    });
  }
  // El claro se muestra UNA vez: aquí. Después solo vive su hash.
  const token = randomToken();
  const hash = await sha256Hex(token);
  await svcRest(
    `/agent_connections?id=eq.${encodeURIComponent(connectionId)}`,
    {
      method: "PATCH",
      body: { inbound_token_hash: hash },
      prefer: "return=minimal",
    },
  );
  return json(200, { token });
}

async function actionRevokeInbound(
  uid: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const connectionId = asText(body["connection_id"], 64) ?? "";
  const row = await ownConnection(uid, connectionId);
  if (row === null) {
    return json(404, {
      code: "not_found",
      message: "Ese agente no existe o no es tuyo.",
    });
  }
  await svcRest(
    `/agent_connections?id=eq.${encodeURIComponent(connectionId)}`,
    {
      method: "PATCH",
      body: { inbound_token_hash: null },
      prefer: "return=minimal",
    },
  );
  return json(200, { ok: true });
}

async function actionSetStatus(
  uid: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const connectionId = asText(body["connection_id"], 64) ?? "";
  const row = await ownConnection(uid, connectionId);
  if (row === null) {
    return json(404, {
      code: "not_found",
      message: "Ese agente no existe o no es tuyo.",
    });
  }
  const status = body["status"];
  if (status !== "active" && status !== "paused") {
    return json(400, {
      code: "bad_status",
      message: "Estado inválido (solo activo o pausado).",
    });
  }
  await svcRest(
    `/agent_connections?id=eq.${encodeURIComponent(connectionId)}`,
    { method: "PATCH", body: { status }, prefer: "return=minimal" },
  );
  if (status === "paused") {
    // Pausar invalida los tokens vivos: lo corriendo queda expirable por
    // deadline y lo encolado no se despacha (dispatch valida el estado).
    await svcRest(
      `/agent_runs?connection_id=eq.${encodeURIComponent(connectionId)}&status=in.(queued,dispatched)`,
      {
        method: "PATCH",
        body: { status: "cancelled", error: "Agente pausado por su dueño." },
        prefer: "return=minimal",
      },
    );
  }
  return json(200, { ok: true });
}

async function actionRemove(
  uid: string,
  body: Record<string, unknown>,
): Promise<Response> {
  const connectionId = asText(body["connection_id"], 64) ?? "";
  const row = await ownConnection(uid, connectionId);
  if (row === null) {
    return json(404, {
      code: "not_found",
      message: "Ese agente no existe o no es tuyo.",
    });
  }
  await svcRest(
    `/agent_connections?id=eq.${encodeURIComponent(connectionId)}`,
    { method: "DELETE", prefer: "return=minimal" },
  );
  return json(200, { ok: true });
}

// --- Servidor ------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }
  if (req.method === "GET") {
    return json(200, { configured: hasSecrets() });
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
  const user = await authUser(req);
  if (user === null) {
    return json(401, {
      code: "no_session",
      message: "Tu sesión expiró. Vuelve a iniciar sesión.",
    });
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
  const action = body["action"];
  if (action === "create") return actionCreate(user.uid, user.token, body);
  if (action === "update") return actionUpdate(user.uid, user.token, body);
  if (action === "set-outbound") return actionSetOutbound(user.uid, body);
  if (action === "rotate-inbound") return actionRotateInbound(user.uid, body);
  if (action === "revoke-inbound") return actionRevokeInbound(user.uid, body);
  if (action === "set-status") return actionSetStatus(user.uid, body);
  if (action === "remove") return actionRemove(user.uid, body);
  return json(400, { code: "bad_action", message: "Acción desconocida." });
});
