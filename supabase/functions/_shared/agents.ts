// =============================================================================
// Contrato de agentes personales · compartido por las Edge Functions (Deno).
//
// Sin dependencias externas: solo WebCrypto y fetch (nativos del runtime).
// Se importa con ruta relativa (`../_shared/agents.ts`; ver ecd83f9).
//
// El contrato propio de Loki (ver docs/AGENTES.md):
//   · Tarea saliente: la Edge agent-dispatch manda al agente el pedido mínimo
//     (run_id + run_token); el agente baja la tarea completa desde
//     agent-callback/agent-task con ese token. Nada sensible viaja en claro.
//   · Eventos entrantes: progress, needs_input, result o error.
//   · Estados: queued, dispatched, running, needs_input, done, error,
//     cancelled, expired.
//
// Mapa con estándares abiertos (nombres alineados, sin atarse a una versión):
//   · A2A (Agent2Agent): taskId = run.id, TaskStatus.state ~= run.status,
//     Message con parts ~= context/result.text, Artifact ~= result.links.
//   · MCP (a futuro): proposed_actions usan {type, arguments} como tools/call.
// =============================================================================

// --- Proveedores y estados (los mismos CHECKs de la migración) ----------------

export const AGENT_PROVIDERS: readonly string[] = [
  "generic_webhook",
  "grokbot",
  "hermes",
  "a2a",
] as const;

export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

export function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === "string" &&
    (AGENT_PROVIDERS as readonly string[]).includes(value);
}

export const AGENT_RUN_STATUSES: readonly string[] = [
  "queued",
  "dispatched",
  "running",
  "needs_input",
  "done",
  "error",
  "cancelled",
  "expired",
] as const;

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/** Estados que ya cerraron: el agente debe detenerse (409). */
export function isTerminalStatus(status: string): boolean {
  return status === "done" || status === "error" ||
    status === "cancelled" || status === "expired";
}

export const AGENT_EVENT_TYPES: readonly string[] = [
  "ack",
  "progress",
  "needs_input",
  "result",
  "error",
  "cancelled",
  "expired",
  "dispatch_failed",
] as const;

/** Eventos que un agente externo puede mandar (el resto los pone el servidor). */
export function isInboundEventType(value: unknown): boolean {
  return value === "progress" || value === "needs_input" ||
    value === "result" || value === "error";
}

// --- Límites del contrato (los cumple agent-dispatch y agent-callback) --------

/** Texto de progreso o error: corto, para la tarjeta en vivo. */
export const AGENT_MAX_TEXT = 2000;
/** Resultado final: texto completo en Markdown simple. */
export const AGENT_MAX_RESULT_TEXT = 16 * 1024;
/** Enlaces del resultado (solo https). */
export const AGENT_MAX_LINKS = 10;
/** Eventos por ejecución (servidor + agente). */
export const AGENT_MAX_EVENTS = 30;
/** Progreso: mínimo entre avisos (lo cumple el callback). */
export const AGENT_PROGRESS_MIN_MS = 20_000;
/** Acciones propuestas por resultado. */
export const AGENT_MAX_ACTIONS = 10;
/** Tipos de acción que un agente puede PROPONER (las ejecuta el usuario con
 *  su JWT en la tarjeta de confirmación; el agente nunca escribe directo). */
export const AGENT_ACTION_TYPES: readonly string[] = [
  "create_task",
  "create_event",
  "create_reminder",
  "add_list_items",
] as const;

export function isAgentActionType(value: unknown): boolean {
  return typeof value === "string" &&
    (AGENT_ACTION_TYPES as readonly string[]).includes(value);
}

// --- Tarea saliente (Loki -> agente) ------------------------------------------
// Equivale a un Task de A2A: id = taskId, instruction + context = Message con
// parts, deadline = metadata. El cuerpo del webhook solo lleva lo mínimo
// (run_id + run_token); la tarea completa se baja con el token.

export type AgentTaskDispatch = {
  /** Siempre "loki.agent_task": el agente ignora otro type. */
  type: "loki.agent_task";
  /** Versión del contrato (1 en esta etapa). */
  v: 1;
  run_id: string;
  run_token: string;
  attempt: number;
};

export type AgentContextMessage = {
  author: string;
  text: string;
  at: string;
};

export type AgentTaskFull = {
  run_id: string;
  connection_id: string;
  handle: string;
  instruction: string;
  requested_by: string;
  space: { id: string; name: string };
  chat: { id: string; name: string };
  context_messages: AgentContextMessage[];
  history: Array<{ from: "agent" | "user"; text: string; at: string }>;
  allowed_actions: string[];
  limits: { max_events: number; result_chars: number; max_links: number };
  deadline_at: string | null;
};

// --- Eventos entrantes (agente -> Loki) ---------------------------------------

export type AgentLink = { title: string; url: string };

export type AgentProposedAction = {
  type: string;
  title: string;
  due_at?: string;
  notes?: string;
  items?: string[];
};

export type AgentEventIn = {
  event_id: string;
  type: "progress" | "needs_input" | "result" | "error";
  text?: string;
  percent?: number;
  question?: string;
  links?: AgentLink[];
  proposed_actions?: AgentProposedAction[];
};

// --- Validación (sin lanzar; devuelve el motivo en español) -------------------

export function cleanHandle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const clean = raw.trim().replace(/^@+/, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{1,30}$/.test(clean)) return null;
  if (
    clean === "loki" || clean === "loki-ia" || clean === "lokia" ||
    clean === "admin" || clean === "sistema" || clean === "system"
  ) {
    return null;
  }
  return clean;
}

export function cleanUrl(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const clean = raw.trim();
  if (clean === "" || clean.length > 2000) return null;
  if (!/^https:\/\//i.test(clean)) return null;
  try {
    const parsed = new URL(clean);
    if (parsed.protocol !== "https:") return null;
    return clean;
  } catch {
    return null;
  }
}

/**
 * Totem contra SSRF: la Edge nunca llama a localhost ni a redes privadas,
 * salvo AGENT_ALLOW_PRIVATE=true (desarrollo con túnel local).
 */
export function isBlockedDispatchHost(hostname: string, allowPrivate: boolean): boolean {
  if (allowPrivate) return false;
  const host = hostname.trim().toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host === "[::1]" || host === "::1") return true;
  // IPv4 privadas / reservadas.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0 || a >= 224) return true;
    return false;
  }
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  return false;
}

export function sanitizeLinks(raw: unknown): AgentLink[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentLink[] = [];
  for (const entry of raw) {
    if (out.length >= AGENT_MAX_LINKS) break;
    if (typeof entry !== "object" || entry === null) continue;
    const link = entry as Record<string, unknown>;
    const url = typeof link["url"] === "string" ? link["url"].trim() : "";
    if (!/^https:\/\//i.test(url) || url.length > 2000) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") continue;
    } catch {
      continue;
    }
    const title = typeof link["title"] === "string"
      ? link["title"].trim().slice(0, 120)
      : url.slice(0, 120);
    out.push({ title: title === "" ? url.slice(0, 120) : title, url });
  }
  return out;
}

export function sanitizeActions(raw: unknown): AgentProposedAction[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentProposedAction[] = [];
  for (const entry of raw) {
    if (out.length >= AGENT_MAX_ACTIONS) break;
    if (typeof entry !== "object" || entry === null) continue;
    const action = entry as Record<string, unknown>;
    if (!isAgentActionType(action["type"])) continue;
    const title = typeof action["title"] === "string"
      ? action["title"].trim().slice(0, 200)
      : "";
    if (title === "") continue;
    const clean: AgentProposedAction = { type: action["type"] as string, title };
    if (typeof action["due_at"] === "string" && action["due_at"].length <= 64) {
      clean.due_at = action["due_at"];
    }
    if (typeof action["notes"] === "string") {
      clean.notes = action["notes"].slice(0, 1000);
    }
    if (Array.isArray(action["items"])) {
      clean.items = action["items"]
        .filter((item): item is string =>
          typeof item === "string" && item.trim() !== "")
        .map((item) => item.trim().slice(0, 200))
        .slice(0, 20);
    }
    out.push(clean);
  }
  return out;
}

// --- Criptografía (mismo enfoque que google-calendar) -------------------------
// secret_enc: AES-GCM con clave derivada (SHA-256) de AGENT_TOKEN_KEY.
// Formato: base64(iv de 12 bytes + ciphertext).
// inbound_token_hash / run_token_hash: SHA-256 hex (comparación constante).

export async function agentCryptoKey(keyMaterial: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(keyMaterial),
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

export async function encryptSecret(
  keyMaterial: string,
  plain: string,
): Promise<string> {
  const key = await agentCryptoKey(keyMaterial);
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

export async function decryptSecret(
  keyMaterial: string,
  packedB64: string,
): Promise<string | null> {
  const packed = fromBase64(packedB64);
  if (packed === null || packed.length <= 12) return null;
  try {
    const key = await agentCryptoKey(keyMaterial);
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

export async function sha256Hex(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(raw),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Comparación en tiempo constante (hashes hex). */
export function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length || a === "") return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** Token aleatorio (32 bytes, base64url): el claro se muestra UNA vez. */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}

// --- Firma saliente + URLs públicas (prompt 13) --------------------------------
// El webhook genérico va FIRMADO (HMAC-SHA256 del cuerpo con el secreto
// saliente): el agente verifica `X-Loki-Signature` (hex) y `X-Loki-Timestamp`
// para saber que el pedido viene de Loki. Se conserva además el Bearer por
// compatibilidad con agentes ya conectados en la etapa anterior.

/** HMAC-SHA256 hex (WebCrypto, sin dependencias). */
export async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(data),
  );
  return Array.from(new Uint8Array(sig))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Base pública de Functions tal como la ve el agente (sin barra final). */
export function publicFunctionsBase(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const clean = raw.trim().replace(/\/+$/, "");
  if (clean === "" || clean.length > 2000) return null;
  if (!/^https:\/\//i.test(clean)) return null;
  try {
    const parsed = new URL(clean);
    if (parsed.protocol !== "https:") return null;
    return clean;
  } catch {
    return null;
  }
}

/** URL de retorno que el agente llama con el run_token (Bearer). */
export function callbackUrlOf(publicBase: string | null): string | null {
  if (publicBase === null) return null;
  return `${publicBase}/agent-callback`;
}

/** URL donde el agente baja la tarea completa con su token. */
export function taskUrlOf(publicBase: string | null): string | null {
  if (publicBase === null) return null;
  return `${publicBase}/agent-task`;
}

// --- Adaptadores por proveedor (todo configurable, nada hardcodeado) -----------
// Estado de verificación (02-10-2026, sin acceso a docs oficiales desde este
// entorno; ver docs/AGENTES.md):
//   · generic_webhook: referencia, implementado y verificado contra el contrato
//     propio de docs/AGENTES.md.
//   · grokbot: disparo por webhook de rutina con la tarea + callback + token en
//     el cuerpo. NO verificado que Grok Bot tenga canal oficial de retorno: se
//     usa el fallback (la rutina hace POST a agent-callback según sus
//     instrucciones). URL, cabeceras y nombres de campo configurables.
//   · hermes: sin API oficial verificada: usa el webhook genérico o A2A según
//     `config.mode` ("webhook"|"a2a"). Ver docs/AGENTES.md qué verificar.
//   · a2a: mapea la tarea de Loki a Task A2A y los estados a TaskStatus.state
//     según la spec (ver tabla en docs/AGENTES.md). El retorno viaja por
//     agent-callback salvo que la conexión configure callback A2A propio.

export type A2ATaskSend = {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: Record<string, unknown>;
};

/** Loki → A2A: la tarea equivale a un Task (id = taskId). */
export function lokiTaskToA2A(task: AgentTaskFull, extra: {
  callbackUrl: string | null;
  runToken: string;
}): A2ATaskSend {
  const parts: Array<Record<string, unknown>> = [
    { type: "text", text: task.instruction },
  ];
  for (const msg of task.context_messages) {
    parts.push({
      type: "text",
      text: `${msg.author}: ${msg.text}`,
    });
  }
  return {
    jsonrpc: "2.0",
    id: task.run_id,
    method: "tasks/send",
    params: {
      id: task.run_id,
      message: { role: "user", parts },
      metadata: {
        loki_run_id: task.run_id,
        loki_callback_url: extra.callbackUrl,
        loki_run_token: extra.runToken,
        loki_deadline_at: task.deadline_at,
        loki_allowed_actions: task.allowed_actions,
      },
    },
  };
}

/** A2A → Loki: TaskStatus.state al estado que entiende el chat. */
export function a2AStateToLoki(state: unknown): string {
  switch (String(state ?? "")) {
    case "completed":
      return "done";
    case "failed":
      return "error";
    case "canceled":
      return "cancelled";
    case "input-required":
      return "needs_input";
    case "working":
    case "submitted":
      return "running";
    default:
      return "running";
  }
}

/** Cuerpo de disparo para rutinas tipo Grok Bot: tarea + retorno configurable. */
export function grokbotDispatchBody(task: AgentTaskFull, extra: {
  runToken: string;
  attempt: number;
  callbackUrl: string | null;
  taskUrl: string | null;
  handle: string;
}): Record<string, unknown> {
  return {
    type: "loki.agent_task",
    v: 1,
    run_id: task.run_id,
    run_token: extra.runToken,
    attempt: extra.attempt,
    handle: extra.handle,
    instruction: task.instruction,
    context_messages: task.context_messages,
    history: task.history,
    allowed_actions: task.allowed_actions,
    limits: task.limits,
    deadline_at: task.deadline_at,
    callback_url: extra.callbackUrl,
    task_url: extra.taskUrl,
  };
}
