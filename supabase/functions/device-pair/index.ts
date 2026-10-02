// =============================================================================
// Vinculación del compañero de escritorio · Edge Function `device-pair` (Deno,
// sin dependencias externas, solo imports relativos).
//
// POST { code, device_name?, platform?, app_version? } con el JWT del dueño:
//   1. Valida el código corto (un solo uso, 5 min, del mismo usuario).
//   2. Genera un secreto largo (32 bytes) y guarda solo su hash SHA-256.
//   3. Crea el dispositivo + su usuario Auth propio
//      (`device_<id>@devices.loki.internal`, clave = secreto) y el mapeo.
//   4. Marca el código como usado y devuelve { device_id, email, secret }.
//
// El PC entra después con signIn normal (email + secreto) y obtiene
// access_tokens de corta duración: nunca ve la contraseña del dueño ni la
// service_role ni el secreto JWT. Todo lo que lee por Realtime pasa por RLS.
// Revocar (revoke_device) invalida al instante; el latido lo detecta y el
// compañero vuelve a la pantalla de vinculación.
//
// Secretos del runtime: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// SUPABASE_ANON_KEY (para validar el JWT del dueño).
// =============================================================================

import { DEVICE_DEFAULT_ACTIONS } from "../_shared/devices.ts";

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";

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

// Límite: cubo en memoria por IP, 30 req/min (best effort, como loki-chat).
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;
const rateBuckets = new Map<string, number[]>();

function isRateLimited(req: Request): boolean {
  const forwarded = req.headers.get("x-forwarded-for") ?? "";
  const ip = forwarded.split(",")[0]?.trim() || "sin-ip";
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

/** Valida el JWT del dueño contra Auth. */
async function authUser(req: Request): Promise<{ uid: string } | null> {
  const header = req.headers.get("authorization") ?? "";
  const token = header.toLowerCase().startsWith("bearer ")
    ? header.slice("bearer ".length).trim()
    : "";
  if (token === "" || SUPABASE_URL === "" || ANON_KEY === "") return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: ANON_KEY, authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) return null;
    const id = (body as Record<string, unknown>)["id"];
    if (typeof id !== "string" || id === "") return null;
    return { uid: id };
  } catch {
    return null;
  }
}

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function cleanName(value: unknown): string {
  if (typeof value !== "string") return "Mi PC";
  const name = value.trim().slice(0, 60);
  return name === "" ? "Mi PC" : name;
}

function cleanPlatform(value: unknown): string {
  return value === "linux" || value === "macos" || value === "other" ? value as string : "windows";
}

function cleanVersion(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 32);
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
      message: "Demasiados intentos. Espera un minuto e inténtalo de nuevo.",
    });
  }
  if (SUPABASE_URL === "" || SERVICE_KEY === "" || ANON_KEY === "") {
    return json(503, { code: "not_configured" });
  }
  const me = await authUser(req);
  if (me === null) {
    return json(401, { code: "unauthorized", message: "Hay que iniciar sesión." });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { code: "bad_request" });
  }
  const raw = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const code = typeof raw["code"] === "string" ? raw["code"].trim().toUpperCase() : "";
  if (!/^[A-Z2-9]{6}$/.test(code)) {
    return json(400, { code: "bad_request", message: "Ese código no es válido." });
  }

  // 1. Código del mismo dueño, sin usar y vigente.
  const codeRes = await fetch(
    `${SUPABASE_URL}/rest/v1/device_pair_codes?code=eq.${code}&select=id,owner_id,device_name,expires_at,used_at&limit=1`,
    { headers: svcHeaders() },
  ).catch(() => null);
  if (codeRes === null || !codeRes.ok) {
    return json(502, { code: "lookup_failed" });
  }
  const rows = (await codeRes.json()) as Record<string, unknown>[];
  const row = rows[0];
  if (row === undefined) {
    return json(404, { code: "invalid_code", message: "Ese código no existe." });
  }
  if (row["owner_id"] !== me.uid) {
    return json(403, { code: "invalid_code", message: "Ese código no es tuyo." });
  }
  if (row["used_at"] !== null && row["used_at"] !== undefined) {
    return json(410, { code: "used_code", message: "Ese código ya se usó." });
  }
  if (typeof row["expires_at"] !== "string" || new Date(row["expires_at"]).getTime() <= Date.now()) {
    return json(410, { code: "expired_code", message: "Ese código venció. Genera otro." });
  }

  // 2. Secreto largo (el claro viaja una sola vez) + su hash.
  const secret = randomSecret();
  const hash = await sha256Hex(secret);
  const name = cleanName(raw["device_name"] ?? row["device_name"]);
  const platform = cleanPlatform(raw["platform"]);
  const appVersion = cleanVersion(raw["app_version"]);

  // 3. Fila del dispositivo.
  const devRes = await fetch(`${SUPABASE_URL}/rest/v1/user_devices`, {
    method: "POST",
    headers: { ...svcHeaders(), Prefer: "return=representation" },
    body: JSON.stringify({
      owner_id: me.uid,
      name,
      platform,
      app_version: appVersion,
      credential_hash: hash,
      allowed_actions: [...DEVICE_DEFAULT_ACTIONS],
      readable_dirs: [],
      can_send_files: true,
      allow_arbitrary: false,
    }),
  }).catch(() => null);
  if (devRes === null || !devRes.ok) {
    return json(502, { code: "pair_failed", message: "No se pudo vincular. Inténtalo de nuevo." });
  }
  const devRows = (await devRes.json()) as Record<string, unknown>[];
  const deviceId = devRows[0]?.["id"];
  if (typeof deviceId !== "string" || deviceId === "") {
    return json(502, { code: "pair_failed" });
  }
  const email = `device_${deviceId.replace(/-/g, "").slice(0, 12)}@devices.loki.internal`;

  // 4. Usuario Auth propio del dispositivo (clave = secreto).
  const userRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: svcHeaders(),
    body: JSON.stringify({
      email,
      password: secret,
      email_confirm: true,
      user_metadata: { kind: "loki_device", device_id: deviceId, owner_id: me.uid },
    }),
  }).catch(() => null);
  if (userRes === null || !userRes.ok) {
    // Revierte la fila para no dejar un dispositivo a medias.
    await fetch(`${SUPABASE_URL}/rest/v1/user_devices?id=eq.${deviceId}`, {
      method: "DELETE",
      headers: svcHeaders(),
    }).catch(() => null);
    return json(502, { code: "pair_failed", message: "No se pudo crear la credencial. Inténtalo de nuevo." });
  }
  const created = (await userRes.json()) as Record<string, unknown>;
  const authUserId = created["id"];
  if (typeof authUserId !== "string" || authUserId === "") {
    await fetch(`${SUPABASE_URL}/rest/v1/user_devices?id=eq.${deviceId}`, {
      method: "DELETE",
      headers: svcHeaders(),
    }).catch(() => null);
    return json(502, { code: "pair_failed" });
  }

  // 5. Mapeo + código usado + auditoría (best effort, en orden).
  await fetch(`${SUPABASE_URL}/rest/v1/device_auth_users`, {
    method: "POST",
    headers: svcHeaders(),
    body: JSON.stringify({ device_id: deviceId, auth_user_id: authUserId }),
  }).catch(() => null);
  await fetch(`${SUPABASE_URL}/rest/v1/device_pair_codes?id=eq.${row["id"]}`, {
    method: "PATCH",
    headers: svcHeaders(),
    body: JSON.stringify({ used_at: new Date().toISOString() }),
  }).catch(() => null);
  await fetch(`${SUPABASE_URL}/rest/v1/device_audit_log`, {
    method: "POST",
    headers: svcHeaders(),
    body: JSON.stringify({
      device_id: deviceId,
      owner_id: me.uid,
      actor_id: me.uid,
      action: "paired",
      detail: `PC vinculado: ${name.slice(0, 80)}.`,
    }),
  }).catch(() => null);

  return json(200, { device_id: deviceId, email, secret });
});
