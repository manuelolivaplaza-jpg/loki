// =============================================================================
// Push FCM · Edge Function `push-send` (Deno, sin dependencias).
//
// Envía una notificación push por FCM HTTP v1 a los dispositivos de UN
// usuario. La llama el trigger `maybe_push_notification` (pg_net) o un
// Database Webhook sobre `notifications` con el cuerpo:
//
//   { user_id, title, body, link, type? }
//
// `type` es el tipo de notificación (`mention`, `reply`, …): si el usuario
// lo apagó en sus preferencias, no se envía nada (pero la bandeja conserva
// la fila). También acepta el formato de Database Webhook de Supabase:
//
//   { type: "INSERT", record: { user_id, title, body, link, type, ... } }
//
// Secretos (Edge Functions → Secrets):
//   FCM_SERVICE_ACCOUNT: JSON de la cuenta de servicio (sin él: 503).
// El resto lo pone el runtime: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// =============================================================================

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const FCM_SERVICE_ACCOUNT = (Deno.env.get("FCM_SERVICE_ACCOUNT") ?? "").trim();

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, apikey",
};

// Canal de notificaciones Android (lo crea la app al registrarse).
const ANDROID_CHANNEL_ID = "loki_default";

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

type ServiceAccount = {
  project_id: string;
  client_email: string;
  private_key: string;
};

function parseServiceAccount(): ServiceAccount | null {
  if (FCM_SERVICE_ACCOUNT === "") return null;
  try {
    const raw = JSON.parse(FCM_SERVICE_ACCOUNT) as Record<string, unknown>;
    if (
      typeof raw["project_id"] !== "string" ||
      typeof raw["client_email"] !== "string" ||
      typeof raw["private_key"] !== "string"
    ) {
      return null;
    }
    return {
      project_id: raw["project_id"],
      client_email: raw["client_email"],
      private_key: raw["private_key"],
    };
  } catch {
    return null;
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** Access token OAuth2 para FCM HTTP v1 (JWT RS256 firmado con la cuenta). */
async function fcmAccessToken(account: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
  );
  const claims = base64UrlEncode(
    new TextEncoder().encode(
      JSON.stringify({
        iss: account.client_email,
        scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      }),
    ),
  );
  const unsigned = `${header}.${claims}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(account.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(unsigned),
    ),
  );
  const assertion = `${unsigned}.${base64UrlEncode(signature)}`;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }).toString(),
  });
  if (!res.ok) throw new Error(`OAuth2 FCM: HTTP ${res.status}`);
  const body = (await res.json()) as { access_token?: string };
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new Error("OAuth2 FCM sin access_token");
  }
  return body.access_token;
}

// --- Límite de peticiones: cubo en memoria por IP, 30 req/min,
// 429 amable en español. Best effort como en `loki-chat`.
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

type PushTarget = {
  userId: string;
  title: string;
  body: string;
  link: string;
  type: string;
};

const UUID_RE = /^[0-9a-fA-F-]{36}$/;

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function cleanLink(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/")) return "/notificaciones";
  return value.slice(0, 300);
}

/**
 * Normaliza el cuerpo: directo `{user_id, title, body, link, type?}` o
 * webhook de base de datos `{type:"INSERT", record:{...}}`. El modo
 * antiguo `{workspace_id, chat_id, message_id}` ya no lo llama nadie y se
 * rechaza con `bad_request` para no enviar pushes a ciegas.
 */
function parseTarget(body: unknown): PushTarget | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as Record<string, unknown>;
  const record = raw["record"];
  const source: Record<string, unknown> =
    typeof record === "object" && record !== null
      ? (record as Record<string, unknown>)
      : raw;
  const userId = source["user_id"];
  if (typeof userId !== "string" || !UUID_RE.test(userId)) return null;
  const title = cleanText(source["title"], 80);
  const text = cleanText(source["body"], 160);
  if (title === "" || text === "") return null;
  const type = typeof source["type"] === "string" && source["type"] !== ""
    ? source["type"]
    : "mention";
  return { userId, title, body: text, link: cleanLink(source["link"]), type };
}

/** Clave de preferencias para cada tipo de notificación. */
function prefKeyFor(type: string): string | null {
  switch (type) {
    case "mention": return "mention";
    case "reply": return "reply";
    case "reaction": return "reaction";
    case "task_assigned": return "task_assigned";
    case "task_due": return "task_due";
    case "event_reminder": return "event_reminder";
    case "invite": return "invite";
    case "ai_alert": return "ai_alert";
    default: return null;
  }
}

function fcmErrorCode(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) return "";
  const error = (payload as Record<string, unknown>)["error"];
  if (typeof error !== "object" || error === null) return "";
  const details = (error as Record<string, unknown>)["details"];
  if (!Array.isArray(details)) return "";
  for (const detail of details) {
    if (typeof detail !== "object" || detail === null) continue;
    const code = (detail as Record<string, unknown>)["errorCode"];
    if (typeof code === "string") return code;
  }
  return "";
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
  const account = parseServiceAccount();
  if (account === null || SUPABASE_URL === "" || SERVICE_KEY === "") {
    return json(503, { code: "not_configured" });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { code: "bad_request" });
  }
  const target = parseTarget(body);
  if (target === null) {
    return json(400, { code: "bad_request" });
  }

  // Preferencias: tipo apagado → no molestar (la bandeja conserva la fila).
  const prefKey = prefKeyFor(target.type);
  if (prefKey !== null) {
    const prefsRes = await fetch(
      `${SUPABASE_URL}/rest/v1/notification_prefs?user_id=eq.${target.userId}&select=${prefKey}&limit=1`,
      { headers: svcHeaders() },
    ).catch(() => null);
    if (prefsRes !== null && prefsRes.ok) {
      const rows = (await prefsRes.json()) as Record<string, unknown>[];
      const row = rows[0];
      if (row !== undefined && row[prefKey] === false) {
        return json(200, { sent: 0, skipped: "prefs" });
      }
    }
  }

  // Tokens del destinatario (web + Android/iOS comparten la tabla).
  const tokensRes = await fetch(
    `${SUPABASE_URL}/rest/v1/push_tokens?user_id=eq.${target.userId}&select=token`,
    { headers: svcHeaders() },
  ).catch(() => null);
  if (tokensRes === null || !tokensRes.ok) {
    return json(502, { code: "lookup_failed" });
  }
  const tokens = (await tokensRes.json()) as { token: string }[];
  const uniq = [...new Set(tokens.map((t) => t.token).filter((t) => t !== ""))];
  if (uniq.length === 0) {
    return json(200, { sent: 0, skipped: "no_tokens" });
  }

  let accessToken: string;
  try {
    accessToken = await fcmAccessToken(account);
  } catch {
    return json(502, { code: "fcm_auth_failed" });
  }

  let sent = 0;
  const dead: string[] = [];
  for (const token of uniq) {
    try {
      const res = await fetch(
        `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            message: {
              token,
              notification: { title: target.title, body: target.body },
              data: {
                link: target.link,
                type: target.type,
                title: target.title,
                body: target.body,
              },
              android: {
                priority: "HIGH",
                notification: {
                  channel_id: ANDROID_CHANNEL_ID,
                  sound: "default",
                  click_action: "FLUTTER_NOTIFICATION_CLICK",
                },
              },
              apns: { payload: { aps: { sound: "default" } } },
            },
          }),
        },
      );
      if (res.ok) {
        sent += 1;
      } else {
        const code = fcmErrorCode(await res.json().catch(() => null));
        if (code === "UNREGISTERED" || code === "SENDER_ID_MISMATCH") {
          dead.push(token);
        }
      }
    } catch {
      // Un token roto no frena al resto.
    }
  }

  // Limpieza: los tokens muertos se borran para no intentarlo más.
  for (const token of dead) {
    await fetch(
      `${SUPABASE_URL}/rest/v1/push_tokens?user_id=eq.${target.userId}&token=eq.${encodeURIComponent(token)}`,
      { method: "DELETE", headers: svcHeaders() },
    ).catch(() => null);
  }

  return json(200, { sent, cleaned: dead.length });
});
