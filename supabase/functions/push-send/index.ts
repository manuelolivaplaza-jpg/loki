// =============================================================================
// Push FCM · Edge Function `push-send` (Deno, sin dependencias).
//
// Envía una notificación push por FCM HTTP v1 cuando hay un mensaje nuevo.
// Desactivada por defecto: no hay ningún trigger ni webhook que la llame;
// cuando Manu la habilite será vía `pg_net` o webhook sobre mensajes nuevos
// con el cuerpo { workspace_id, chat_id, message_id }.
//
// Secretos (`supabase/functions/.env`, gitignored):
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

type PushRequest = { workspace_id: string; chat_id: string; message_id: string };

const MAX_ID = 200;

// --- Límite de peticiones (T35): cubo en memoria por IP, 30 req/min,
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

function validPushId(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= MAX_ID;
}

function parseRequest(body: unknown): PushRequest | null {
  if (typeof body !== "object" || body === null) return null;
  const raw = body as Record<string, unknown>;
  if (
    !validPushId(raw["workspace_id"]) ||
    !validPushId(raw["chat_id"]) ||
    !validPushId(raw["message_id"])
  ) {
    return null;
  }
  return {
    workspace_id: raw["workspace_id"],
    chat_id: raw["chat_id"],
    message_id: raw["message_id"],
  };
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
  const input = parseRequest(body);
  if (input === null) {
    return json(400, { code: "bad_request" });
  }

  // Mensaje + autor (service role: la función es backend).
  const msgRes = await fetch(
    `${SUPABASE_URL}/rest/v1/messages?id=eq.${input.message_id}&select=author_id,author_name,text,workspace_id,chat_id&limit=1`,
    { headers: svcHeaders() },
  ).catch(() => null);
  if (msgRes === null || !msgRes.ok) {
    return json(502, { code: "lookup_failed" });
  }
  const msgs = (await msgRes.json()) as {
    author_id: string | null;
    author_name: string;
    text: string;
  }[];
  const msg = msgs[0];
  if (msg === undefined || msg.text.trim() === "") {
    return json(200, { sent: 0 });
  }

  // Tokens de los miembros del espacio menos el autor.
  const membersRes = await fetch(
    `${SUPABASE_URL}/rest/v1/workspace_members?workspace_id=eq.${input.workspace_id}&select=user_id`,
    { headers: svcHeaders() },
  ).catch(() => null);
  if (membersRes === null || !membersRes.ok) {
    return json(502, { code: "lookup_failed" });
  }
  const members = (await membersRes.json()) as { user_id: string }[];
  const targets = members
    .map((m) => m.user_id)
    .filter((uid) => uid !== msg.author_id);
  if (targets.length === 0) {
    return json(200, { sent: 0 });
  }
  const tokensRes = await fetch(
    `${SUPABASE_URL}/rest/v1/push_tokens?user_id=in.(${targets.join(",")})&select=token`,
    { headers: svcHeaders() },
  ).catch(() => null);
  if (tokensRes === null || !tokensRes.ok) {
    return json(502, { code: "lookup_failed" });
  }
  const tokens = (await tokensRes.json()) as { token: string }[];
  if (tokens.length === 0) {
    return json(200, { sent: 0 });
  }

  let accessToken: string;
  try {
    accessToken = await fcmAccessToken(account);
  } catch {
    return json(502, { code: "fcm_auth_failed" });
  }
  const preview =
    msg.text.length > 120 ? `${msg.text.slice(0, 120)}…` : msg.text;
  let sent = 0;
  for (const { token } of tokens) {
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
              notification: { title: msg.author_name, body: preview },
              data: {
                workspace_id: input.workspace_id,
                chat_id: input.chat_id,
                message_id: input.message_id,
              },
            },
          }),
        },
      );
      if (res.ok) sent += 1;
    } catch {
      // Un token roto no frena al resto.
    }
  }
  return json(200, { sent });
});
