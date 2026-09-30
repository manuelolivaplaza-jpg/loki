// =============================================================================
// Google Calendar bidireccional · Edge Function `google-calendar` (Deno, cero
// imports).
//
// - GET  -> { configured: clientIdSet } (sin exponer secretos).
// - POST -> JSON { action, ... } con el JWT del usuario (se valida contra
//   Auth `/auth/v1/user`, igual que `loki-chat`).
//
// Acciones:
//   auth-url   -> URL OAuth (scope calendar.events, redirect GOOGLE_REDIRECT_URL)
//   exchange   -> {code}: intercambia el code, cifra el refresh (AES-GCM +
//                GOOGLE_TOKEN_KEY) y guarda la conexión (service_role)
//   status     -> {connected, email, lastPullAt, syncEnabled, calendarId}
//                (sin exponer tokens)
//   disconnect -> borra la conexión
//   pull       -> importa próximos 30 días de Google al workspace ACTUAL
//                (profiles.current_workspace_id); borra de Loki los que Google
//                eliminó (solo external_source = 'google')
//   push       -> {eventId}: crea o actualiza el evento Loki en Google
//   unpush     -> {externalId}: borra el evento en Google (al borrar en Loki)
//
// Secretos (supabase/functions/.env, gitignored): GOOGLE_CLIENT_ID,
// GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URL, GOOGLE_TOKEN_KEY (32+ chars).
// Sin GOOGLE_CLIENT_SECRET: 503 { code: "not_configured" }.
// Límite: 30 req/min por IP+JWT (429 amable en español).
//
// Secretos de Supabase (los pone el runtime): SUPABASE_URL,
// SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY.
// =============================================================================

const SUPABASE_URL = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/+$/, "");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const GOOGLE_CLIENT_ID = (Deno.env.get("GOOGLE_CLIENT_ID") ?? "").trim();
const GOOGLE_CLIENT_SECRET = (Deno.env.get("GOOGLE_CLIENT_SECRET") ?? "").trim();
const GOOGLE_REDIRECT_URL = (Deno.env.get("GOOGLE_REDIRECT_URL") ?? "").trim();
const GOOGLE_TOKEN_KEY = Deno.env.get("GOOGLE_TOKEN_KEY") ?? "";

const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.events";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, apikey",
};

// --- Límite de peticiones (igual que loki-chat) --------------------------------
// Cubo en memoria por IP+JWT: 30 req/min. Al superarlas, 429 amable en
// español. Best effort (el runtime puede reiniciar el mapa entre invocaciones).

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

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

const MAX_CODE = 2000;
const MAX_ID = 200;

function validCode(value: unknown): string | null {
  return typeof value === "string" && value !== "" && value.length <= MAX_CODE
    ? value
    : null;
}

function validId(value: unknown): string | null {
  return typeof value === "string" && value !== "" && value.length <= MAX_ID
    ? value
    : null;
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

/** REST contra Supabase con la service_role (la Edge ya validó al usuario). */
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

// --- Cifrado del refresh_token (AES-GCM + GOOGLE_TOKEN_KEY, WebCrypto) ---------
// Formato guardado: base64(iv de 12 bytes + ciphertext). La clave se deriva
// con SHA-256 del secreto (acepta cualquier texto de 32+ chars).

async function tokenCryptoKey(): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(GOOGLE_TOKEN_KEY),
  );
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  return btoa(binary);
}

function fromBase64(raw: string): Uint8Array | null {
  try {
    const binary = atob(raw);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
}

async function encryptRefresh(plain: string): Promise<string> {
  const key = await tokenCryptoKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      new TextEncoder().encode(plain),
    ),
  );
  const packed = new Uint8Array(iv.length + cipher.length);
  packed.set(iv, 0);
  packed.set(cipher, iv.length);
  return toBase64(packed);
}

async function decryptRefresh(packedB64: string): Promise<string | null> {
  const packed = fromBase64(packedB64);
  if (packed === null || packed.length <= 12) return null;
  try {
    const key = await tokenCryptoKey();
    const iv = packed.slice(0, 12);
    const cipher = packed.slice(12);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as BufferSource },
      key,
      cipher as BufferSource,
    );
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

// --- Tipos de la conexión -------------------------------------------------------

type GcalConnection = {
  user_id: string;
  refresh_token: string;
  access_token: string;
  expires_at: string | null;
  google_email: string;
  calendar_id: string;
  sync_enabled: boolean;
  last_pull_at: string | null;
};

function toConnection(value: unknown): GcalConnection | null {
  if (!isRecord(value)) return null;
  const userId = asString(value["user_id"]);
  const refresh = typeof value["refresh_token"] === "string" ? value["refresh_token"] : null;
  if (userId === null || refresh === null || refresh === "") return null;
  return {
    user_id: userId,
    refresh_token: refresh,
    access_token: typeof value["access_token"] === "string" ? value["access_token"] : "",
    expires_at: typeof value["expires_at"] === "string" ? value["expires_at"] : null,
    google_email: typeof value["google_email"] === "string" ? value["google_email"] : "",
    calendar_id: typeof value["calendar_id"] === "string" && value["calendar_id"] !== ""
      ? value["calendar_id"]
      : "primary",
    sync_enabled: value["sync_enabled"] !== false,
    last_pull_at: typeof value["last_pull_at"] === "string" ? value["last_pull_at"] : null,
  };
}

async function loadConnection(uid: string): Promise<GcalConnection | null> {
  const res = await svcRest(
    `/calendar_connections?user_id=eq.${encodeURIComponent(uid)}&select=user_id,refresh_token,access_token,expires_at,google_email,calendar_id,sync_enabled,last_pull_at&limit=1`,
  );
  if (!res.ok || !Array.isArray(res.data)) return null;
  const first: unknown = res.data[0];
  return first === undefined ? null : toConnection(first);
}

// --- Google OAuth / Calendar ----------------------------------------------------

function googleConfigured(): boolean {
  return GOOGLE_CLIENT_ID !== "" && GOOGLE_CLIENT_SECRET !== "" && GOOGLE_TOKEN_KEY.length >= 32;
}

function buildAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URL,
    response_type: "code",
    scope: GOOGLE_SCOPE,
    access_type: "offline",
    prompt: "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

type TokenReply = {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number;
};

async function exchangeCode(code: string): Promise<TokenReply | null> {
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        code,
        redirect_uri: GOOGLE_REDIRECT_URL,
        grant_type: "authorization_code",
      }).toString(),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!isRecord(body)) return null;
    const access = asString(body["access_token"]);
    if (access === null) return null;
    const refresh = typeof body["refresh_token"] === "string" ? body["refresh_token"] : null;
    const expiresIn = typeof body["expires_in"] === "number" ? body["expires_in"] : 3600;
    return { accessToken: access, refreshToken: refresh, expiresIn };
  } catch {
    return null;
  }
}

async function refreshAccess(refreshToken: string): Promise<TokenReply | null> {
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!isRecord(body)) return null;
    const access = asString(body["access_token"]);
    if (access === null) return null;
    const refresh = typeof body["refresh_token"] === "string" ? body["refresh_token"] : null;
    const expiresIn = typeof body["expires_in"] === "number" ? body["expires_in"] : 3600;
    return { accessToken: access, refreshToken: refresh, expiresIn };
  } catch {
    return null;
  }
}

async function googleEmail(accessToken: string): Promise<string> {
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return "";
    const body: unknown = await res.json();
    if (!isRecord(body)) return "";
    return typeof body["email"] === "string" ? body["email"] : "";
  } catch {
    return "";
  }
}

/** Access token vigente; lo refresca y persiste si venció (margen 60 s). */
async function freshAccessToken(conn: GcalConnection): Promise<string | null> {
  const skewMs = 60_000;
  if (conn.access_token !== "" && conn.expires_at !== null) {
    const left = new Date(conn.expires_at).getTime() - Date.now();
    if (Number.isFinite(left) && left > skewMs) return conn.access_token;
  }
  if (conn.access_token !== "" && conn.expires_at === null) return conn.access_token;
  const refresh = await decryptRefresh(conn.refresh_token);
  if (refresh === null) return null;
  const reply = await refreshAccess(refresh);
  if (reply === null) return null;
  const expiresAt = new Date(Date.now() + Math.max(60, reply.expiresIn) * 1000).toISOString();
  const patch: Record<string, string> = {
    access_token: reply.accessToken,
    expires_at: expiresAt,
  };
  if (reply.refreshToken !== null && reply.refreshToken !== "") {
    patch["refresh_token"] = await encryptRefresh(reply.refreshToken);
  }
  await svcRest(
    `/calendar_connections?user_id=eq.${encodeURIComponent(conn.user_id)}`,
    { method: "PATCH", body: patch, prefer: "return=minimal" },
  );
  return reply.accessToken;
}

function gcalFetch(accessToken: string, path: string, init?: { method?: string; body?: unknown }): Promise<Response> {
  const calendarPath = path.startsWith("/") ? path : `/${path}`;
  return fetch(`https://www.googleapis.com/calendar/v3${calendarPath}`, {
    method: init?.method ?? "GET",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

// --- Eventos Google <-> Loki ------------------------------------------------------

type GoogleItem = {
  id: string;
  status: string;
  summary: string;
  description: string;
  location: string;
  start: string | null;
  end: string | null;
};

function gcalDate(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const dateTime = value["dateTime"];
  if (typeof dateTime === "string" && dateTime !== "") return dateTime;
  const date = value["date"];
  if (typeof date === "string" && date !== "") return `${date}T00:00:00.000Z`;
  return null;
}

function toGoogleItem(value: unknown): GoogleItem | null {
  if (!isRecord(value)) return null;
  const id = asString(value["id"]);
  if (id === null) return null;
  return {
    id,
    status: typeof value["status"] === "string" ? value["status"] : "confirmed",
    summary: typeof value["summary"] === "string" ? value["summary"] : "",
    description: typeof value["description"] === "string" ? value["description"] : "",
    location: typeof value["location"] === "string" ? value["location"] : "",
    start: gcalDate(value["start"]),
    end: gcalDate(value["end"]),
  };
}

type LokiEventRow = {
  id: string;
  workspace_id: string;
  title: string;
  description: string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  location: string;
  external_id: string | null;
  external_source: string | null;
};

function toLokiRow(value: unknown): LokiEventRow | null {
  if (!isRecord(value)) return null;
  const id = asString(value["id"]);
  const ws = asString(value["workspace_id"]);
  const title = typeof value["title"] === "string" ? value["title"] : null;
  const startsAt = typeof value["starts_at"] === "string" ? value["starts_at"] : null;
  const endsAt = typeof value["ends_at"] === "string" ? value["ends_at"] : null;
  if (id === null || ws === null || title === null || startsAt === null || endsAt === null) return null;
  return {
    id,
    workspace_id: ws,
    title,
    description: typeof value["description"] === "string" ? value["description"] : "",
    starts_at: startsAt,
    ends_at: endsAt,
    all_day: value["all_day"] === true,
    location: typeof value["location"] === "string" ? value["location"] : "",
    external_id: typeof value["external_id"] === "string" ? value["external_id"] : null,
    external_source: typeof value["external_source"] === "string" ? value["external_source"] : null,
  };
}

async function currentWorkspaceId(uid: string): Promise<string | null> {
  const res = await svcRest(
    `/profiles?id=eq.${encodeURIComponent(uid)}&select=current_workspace_id&limit=1`,
  );
  if (!res.ok || !Array.isArray(res.data)) return null;
  const first: unknown = res.data[0];
  if (!isRecord(first)) return null;
  const ws = first["current_workspace_id"];
  return typeof ws === "string" && ws !== "" ? ws : null;
}

async function isMember(wsId: string, uid: string): Promise<boolean> {
  const res = await svcRest(
    `/workspace_members?workspace_id=eq.${encodeURIComponent(wsId)}&user_id=eq.${encodeURIComponent(uid)}&select=user_id&limit=1`,
  );
  if (!res.ok || !Array.isArray(res.data)) return false;
  return (res.data as unknown[]).length > 0;
}

function googleBody(row: LokiEventRow): Record<string, unknown> {
  return {
    summary: row.title.slice(0, 120),
    description: row.description,
    location: row.location,
    start: { dateTime: new Date(row.starts_at).toISOString() },
    end: { dateTime: new Date(row.ends_at).toISOString() },
  };
}

// --- Handler ----------------------------------------------------------------------

const ACTIONS: ReadonlySet<string> = new Set([
  "auth-url",
  "exchange",
  "status",
  "disconnect",
  "pull",
  "push",
  "unpush",
]);

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }
  if (req.method === "GET") {
    return json(200, { configured: GOOGLE_CLIENT_ID !== "" });
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
  // Sin secreto de Google no hay OAuth posible: se avisa sin romper nada.
  if (!googleConfigured()) {
    return json(503, {
      code: "not_configured",
      message: "Google Calendar sin configurar. Pide al administrador que ponga los secretos de Google.",
    });
  }
  const auth = await authUser(req);
  if (auth === null) {
    return json(401, { code: "unauthorized" });
  }
  const { uid } = auth;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json(400, { code: "bad_request" });
  }
  if (!isRecord(body)) {
    return json(400, { code: "bad_request" });
  }
  const action = asString(body["action"]);
  if (action === null || !ACTIONS.has(action)) {
    return json(400, { code: "bad_request" });
  }

  // --- auth-url: URL de consentimiento OAuth ------------------------------------
  if (action === "auth-url") {
    if (GOOGLE_REDIRECT_URL === "") {
      return json(503, {
        code: "not_configured",
        message: "Falta la URL de retorno de Google. Pide al administrador que la configure.",
      });
    }
    return json(200, { url: buildAuthUrl() });
  }

  // --- exchange: code -> tokens cifrados + conexión ------------------------------
  if (action === "exchange") {
    const code = validCode(body["code"]);
    if (code === null) {
      return json(400, { code: "bad_request" });
    }
    const reply = await exchangeCode(code);
    if (reply === null) {
      return json(502, {
        code: "exchange_failed",
        message: "Google no aceptó el código. Vuelve a conectar.",
      });
    }
    if (reply.refreshToken === null || reply.refreshToken === "") {
      return json(502, {
        code: "no_refresh",
        message: "Google no devolvió permiso permanente. Desconecta en tu cuenta de Google y vuelve a conectar.",
      });
    }
    const email = await googleEmail(reply.accessToken);
    const expiresAt = new Date(Date.now() + Math.max(60, reply.expiresIn) * 1000).toISOString();
    const encrypted = await encryptRefresh(reply.refreshToken);
    const upsert = await svcRest("/calendar_connections", {
      method: "POST",
      prefer: "resolution=merge-duplicates,return=minimal",
      body: {
        user_id: uid,
        provider: "google",
        refresh_token: encrypted,
        access_token: reply.accessToken,
        expires_at: expiresAt,
        google_email: email,
        calendar_id: "primary",
        sync_enabled: true,
      },
    });
    if (!upsert.ok) {
      return json(502, {
        code: "save_failed",
        message: "No se pudo guardar la conexión. Inténtalo de nuevo.",
      });
    }
    return json(200, { connected: true, email });
  }

  // --- status: estado sin exponer tokens ------------------------------------------
  if (action === "status") {
    const conn = await loadConnection(uid);
    if (conn === null) {
      return json(200, { connected: false, email: "", lastPullAt: null, syncEnabled: false, calendarId: "primary" });
    }
    return json(200, {
      connected: true,
      email: conn.google_email,
      lastPullAt: conn.last_pull_at,
      syncEnabled: conn.sync_enabled,
      calendarId: conn.calendar_id,
    });
  }

  // --- disconnect: borra la fila ----------------------------------------------------
  if (action === "disconnect") {
    await svcRest(
      `/calendar_connections?user_id=eq.${encodeURIComponent(uid)}`,
      { method: "DELETE", prefer: "return=minimal" },
    );
    return json(200, { connected: false });
  }

  // --- pull: Google -> Loki (workspace actual) --------------------------------------
  if (action === "pull") {
    const conn = await loadConnection(uid);
    if (conn === null) {
      return json(404, {
        code: "not_connected",
        message: "No hay conexión con Google. Conecta tu calendario primero.",
      });
    }
    const wsId = await currentWorkspaceId(uid);
    if (wsId === null || !(await isMember(wsId, uid))) {
      return json(403, {
        code: "no_workspace",
        message: "No tienes un espacio activo para sincronizar.",
      });
    }
    const access = await freshAccessToken(conn);
    if (access === null) {
      return json(502, {
        code: "refresh_failed",
        message: "No se pudo renovar el acceso a Google. Vuelve a conectar.",
      });
    }
    const timeMin = new Date().toISOString();
    const timeMax = new Date(Date.now() + 30 * 86_400_000).toISOString();
    let gres: Response;
    try {
      gres = await gcalFetch(
        access,
        `/calendars/${encodeURIComponent(conn.calendar_id)}/events?${new URLSearchParams({
          timeMin,
          timeMax,
          singleEvents: "true",
          orderBy: "startTime",
          maxResults: "250",
        }).toString()}`,
      );
    } catch {
      return json(502, {
        code: "google_error",
        message: "Google no respondió. Inténtalo de nuevo.",
      });
    }
    if (!gres.ok) {
      return json(502, {
        code: "google_error",
        message: "Google no devolvió tus eventos. Inténtalo de nuevo.",
      });
    }
    const gbody: unknown = await gres.json().catch(() => null);
    const itemsRaw: unknown = isRecord(gbody) && Array.isArray(gbody["items"]) ? gbody["items"] : [];
    const googleItems = (itemsRaw as unknown[])
      .map(toGoogleItem)
      .filter((item): item is GoogleItem => item !== null && item.status !== "cancelled" && item.start !== null && item.end !== null);

    // Espejo actual en Loki (solo los venidos de Google).
    const existing = await svcRest(
      `/events?workspace_id=eq.${encodeURIComponent(wsId)}&external_source=eq.google&select=id,workspace_id,title,description,starts_at,ends_at,all_day,location,external_id,external_source&limit=500`,
    );
    const byExternal = new Map<string, LokiEventRow>();
    if (existing.ok && Array.isArray(existing.data)) {
      for (const raw of existing.data as unknown[]) {
        const row = toLokiRow(raw);
        if (row !== null && row.external_id !== null) byExternal.set(row.external_id, row);
      }
    }
    const seen = new Set<string>();
    let imported = 0;
    let updated = 0;
    for (const item of googleItems) {
      seen.add(item.id);
      const current = byExternal.get(item.id);
      const startsAt = new Date(item.start as string).toISOString();
      const endsAt = new Date(item.end as string).toISOString();
      if (current !== undefined) {
        const same = current.title === item.summary.slice(0, 120) &&
          current.description === item.description &&
          current.location === item.location &&
          new Date(current.starts_at).toISOString() === startsAt &&
          new Date(current.ends_at).toISOString() === endsAt;
        if (same) continue;
        const upd = await svcRest(
          `/events?id=eq.${encodeURIComponent(current.id)}`,
          {
            method: "PATCH",
            prefer: "return=minimal",
            body: {
              title: item.summary === "" ? "(Sin título)" : item.summary.slice(0, 120),
              description: item.description,
              location: item.location,
              starts_at: startsAt,
              ends_at: endsAt,
            },
          },
        );
        if (upd.ok) updated += 1;
      } else {
        const ins = await svcRest("/events", {
          method: "POST",
          prefer: "return=minimal",
          body: {
            workspace_id: wsId,
            title: item.summary === "" ? "(Sin título)" : item.summary.slice(0, 120),
            description: item.description,
            starts_at: startsAt,
            ends_at: endsAt,
            all_day: false,
            location: item.location,
            created_by: uid,
            external_id: item.id,
            external_source: "google",
          },
        });
        if (ins.ok) imported += 1;
      }
    }
    // Borrados en Google: salen de Loki (solo los que vinieron de Google).
    let removed = 0;
    for (const [externalId, row] of byExternal) {
      if (seen.has(externalId)) continue;
      const del = await svcRest(
        `/events?id=eq.${encodeURIComponent(row.id)}`,
        { method: "DELETE", prefer: "return=minimal" },
      );
      if (del.ok) removed += 1;
    }
    await svcRest(
      `/calendar_connections?user_id=eq.${encodeURIComponent(uid)}`,
      { method: "PATCH", prefer: "return=minimal", body: { last_pull_at: new Date().toISOString() } },
    );
    return json(200, { imported, updated, removed });
  }

  // --- push: Loki -> Google (crear o actualizar) ------------------------------------
  if (action === "push") {
    const eventId = validId(body["eventId"]);
    if (eventId === null) {
      return json(400, { code: "bad_request" });
    }
    const conn = await loadConnection(uid);
    if (conn === null) {
      return json(404, {
        code: "not_connected",
        message: "No hay conexión con Google.",
      });
    }
    const found = await svcRest(
      `/events?id=eq.${encodeURIComponent(eventId)}&select=id,workspace_id,title,description,starts_at,ends_at,all_day,location,external_id,external_source&limit=1`,
    );
    if (!found.ok || !Array.isArray(found.data)) {
      return json(502, {
        code: "event_error",
        message: "No se pudo leer el evento.",
      });
    }
    const first: unknown = (found.data as unknown[])[0];
    const row = first === undefined ? null : toLokiRow(first);
    if (row === null) {
      return json(404, {
        code: "event_missing",
        message: "Ese evento ya no existe.",
      });
    }
    if (!(await isMember(row.workspace_id, uid))) {
      return json(403, { code: "forbidden" });
    }
    const access = await freshAccessToken(conn);
    if (access === null) {
      return json(502, {
        code: "refresh_failed",
        message: "No se pudo renovar el acceso a Google. Vuelve a conectar.",
      });
    }
    const cal = encodeURIComponent(conn.calendar_id);
    if (row.external_id === null) {
      let created: Response;
      try {
        created = await gcalFetch(access, `/calendars/${cal}/events`, {
          method: "POST",
          body: googleBody(row),
        });
      } catch {
        return json(502, {
          code: "google_error",
          message: "Google no respondió. Inténtalo de nuevo.",
        });
      }
      if (!created.ok) {
        return json(502, {
          code: "google_error",
          message: "Google no aceptó el evento. Inténtalo de nuevo.",
        });
      }
      const createdBody: unknown = await created.json().catch(() => null);
      const googleId = isRecord(createdBody) ? asString(createdBody["id"]) : null;
      if (googleId === null) {
        return json(502, {
          code: "google_error",
          message: "Google no devolvió el evento creado.",
        });
      }
      await svcRest(
        `/events?id=eq.${encodeURIComponent(row.id)}`,
        {
          method: "PATCH",
          prefer: "return=minimal",
          body: { external_id: googleId, external_source: "google" },
        },
      );
      return json(200, { externalId: googleId });
    }
    try {
      const res = await gcalFetch(access, `/calendars/${cal}/events/${encodeURIComponent(row.external_id)}`, {
        method: "PATCH",
        body: googleBody(row),
      });
      if (!res.ok && res.status !== 404) {
        return json(502, {
          code: "google_error",
          message: "Google no aceptó los cambios. Inténtalo de nuevo.",
        });
      }
      // Si Google ya no lo tiene, se recrea y se reengancha el espejo.
      if (res.status === 404) {
        const recreated = await gcalFetch(access, `/calendars/${cal}/events`, {
          method: "POST",
          body: googleBody(row),
        });
        if (!recreated.ok) {
          return json(502, {
            code: "google_error",
            message: "Google no aceptó el evento. Inténtalo de nuevo.",
          });
        }
        const recreatedBody: unknown = await recreated.json().catch(() => null);
        const googleId = isRecord(recreatedBody) ? asString(recreatedBody["id"]) : null;
        if (googleId !== null) {
          await svcRest(
            `/events?id=eq.${encodeURIComponent(row.id)}`,
            {
              method: "PATCH",
              prefer: "return=minimal",
              body: { external_id: googleId, external_source: "google" },
            },
          );
          return json(200, { externalId: googleId });
        }
      }
    } catch {
      return json(502, {
        code: "google_error",
        message: "Google no respondió. Inténtalo de nuevo.",
      });
    }
    return json(200, { externalId: row.external_id });
  }

  // --- unpush: borra en Google al borrar en Loki --------------------------------------
  if (action === "unpush") {
    const externalId = validId(body["externalId"]);
    if (externalId === null) {
      return json(400, { code: "bad_request" });
    }
    const conn = await loadConnection(uid);
    if (conn === null) {
      return json(200, { removed: false });
    }
    const access = await freshAccessToken(conn);
    if (access === null) {
      return json(200, { removed: false });
    }
    try {
      const res = await gcalFetch(
        access,
        `/calendars/${encodeURIComponent(conn.calendar_id)}/events/${encodeURIComponent(externalId)}`,
        { method: "DELETE" },
      );
      // 404/410 = ya no está en Google: objetivo cumplido.
      return json(200, { removed: res.ok || res.status === 404 || res.status === 410 });
    } catch {
      return json(200, { removed: false });
    }
  }

  return json(400, { code: "bad_request" });
});
