"use client";

/**
 * Agentes personales sobre Supabase (Postgres + RLS) y la Edge Function
 * `agent-connections`.
 *
 * Regla de seguridad: los secretos (`secret_enc`, `inbound_token_hash`,
 * `run_token_hash`) tienen REVOKE a nivel de columna para `authenticated`.
 * Por eso aquí NUNCA se usa `select *` en `agent_connections` ni en
 * `agent_runs`: solo las columnas seguras de abajo. Los secretos viajan
 * únicamente hacia la Edge (guardar) y el token entrante vuelve UNA vez
 * (al generarlo, para copiarlo).
 */

import type { RealtimeChannel } from "@supabase/supabase-js";
import { getSupabaseClient } from "@/lib/supabase/client";
import { edgeHeaders } from "@/lib/edge";
import { Timestamp } from "@/lib/timestamp";
import type { Database, Json } from "@/types/supabase";
import type {
  AgentAllowedCallers,
  AgentConnection,
  AgentEventType,
  AgentProvider,
  AgentRun,
  AgentRunEvent,
  AgentRunKind,
  AgentRunResult,
  AgentRunStatus,
  AgentSpaceGrant,
  AgentStatus,
} from "@/types/agents";

export type Unsubscribe = () => void;

export const AGENT_FUNCTION_PATH = "agent-connections";

/** Columnas seguras de agent_connections (sin secretos). */
const CONNECTION_COLUMNS =
  "id, provider, name, handle, description, avatar_emoji, config, status, last_error, last_used_at, created_at";

const GRANT_COLUMNS =
  "id, connection_id, workspace_id, enabled, admin_disabled, allowed_callers, allowed_user_ids, allow_context, context_messages, allow_dm_context, allow_publish, allow_propose_actions, daily_limit";

/** Columnas seguras de agent_runs (sin run_token_hash). */
const RUN_COLUMNS =
  "id, connection_id, workspace_id, chat_id, requested_by, kind, instruction, status, token_expires_at, deadline_at, result, error, cancel_requested_at, created_at, finished_at";

const EVENT_COLUMNS = "id, run_id, seq, type, text, percent, created_at";

// --- Lectura de valores -------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function toTimestamp(iso: string | null): Timestamp | null {
  if (iso === null) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : Timestamp.fromDate(date);
}

function toTimestampNow(iso: string): Timestamp {
  const date = new Date(iso);
  return Timestamp.fromDate(Number.isNaN(date.getTime()) ? new Date() : date);
}

function asProvider(value: unknown): AgentProvider {
  return value === "grokbot" || value === "hermes" || value === "a2a"
    ? value
    : "generic_webhook";
}

function asStatus(value: unknown): AgentStatus {
  return value === "paused" || value === "error" ? value : "active";
}

function asRunStatus(value: unknown): AgentRunStatus {
  switch (value) {
    case "dispatched":
    case "running":
    case "needs_input":
    case "done":
    case "error":
    case "cancelled":
    case "expired":
      return value;
    default:
      return "queued";
  }
}

function asCallers(value: unknown): AgentAllowedCallers {
  if (value === "space_members" || value === "listed") return value;
  return "owner_only";
}

function parseResult(raw: unknown): AgentRunResult | null {
  if (!isRecord(raw)) return null;
  const resultText = text(raw["text"]);
  if (resultText === "") return null;
  const linksRaw = Array.isArray(raw["links"]) ? raw["links"] : [];
  const actionsRaw = Array.isArray(raw["proposed_actions"])
    ? raw["proposed_actions"]
    : [];
  return {
    text: resultText,
    links: linksRaw
      .filter(isRecord)
      .map((entry) => ({
        title: text(entry["title"]),
        url: text(entry["url"]),
      }))
      .filter((link) => link.url !== ""),
    proposedActions: actionsRaw
      .filter(isRecord)
      .map((entry) => ({
        type: entry["type"],
        title: text(entry["title"]),
        due_at: typeof entry["due_at"] === "string" ? entry["due_at"] : undefined,
        notes: typeof entry["notes"] === "string" ? entry["notes"] : undefined,
        items: Array.isArray(entry["items"])
          ? entry["items"].filter((item): item is string => typeof item === "string")
          : undefined,
      }))
      .filter((action) =>
        (action.type === "create_task" || action.type === "create_event" ||
          action.type === "create_reminder" || action.type === "add_list_items") &&
        action.title !== ""
      ),
  };
}

type ConnectionRow = Database["public"]["Tables"]["agent_connections"]["Row"];
type GrantRow = Database["public"]["Tables"]["agent_space_grants"]["Row"];
type RunRow = Database["public"]["Tables"]["agent_runs"]["Row"];
type EventRow = Database["public"]["Tables"]["agent_run_events"]["Row"];

function dispatchUrlOf(config: Json): string {
  if (!isRecord(config)) return "";
  return typeof config["dispatch_url"] === "string" ? config["dispatch_url"] : "";
}

export function toAgentConnection(row: ConnectionRow): AgentConnection {
  return {
    id: row.id,
    provider: asProvider(row.provider),
    name: row.name,
    handle: row.handle,
    description: row.description,
    avatarEmoji: row.avatar_emoji,
    dispatchUrl: dispatchUrlOf(row.config),
    // La presencia se infiere sin leer el valor: por RLS directa la columna
    // revocada llega ausente (undefined); la Edge no la manda (manda el
    // booleano por otro lado, ver parseConnection).
    hasOutbound: typeof row.secret_enc === "string" && row.secret_enc !== "",
    hasInbound: typeof row.inbound_token_hash === "string" &&
      row.inbound_token_hash !== "",
    status: asStatus(row.status),
    lastError: row.last_error,
    lastUsedAt: toTimestamp(row.last_used_at),
  };
}

function toGrant(row: GrantRow): AgentSpaceGrant {
  return {
    id: row.id,
    connectionId: row.connection_id,
    workspaceId: row.workspace_id,
    enabled: row.enabled,
    adminDisabled: row.admin_disabled,
    allowedCallers: asCallers(row.allowed_callers),
    allowedUserIds: [...row.allowed_user_ids],
    allowContext: row.allow_context,
    contextMessages: row.context_messages,
    allowDmContext: row.allow_dm_context,
    allowPublish: row.allow_publish,
    allowProposeActions: row.allow_propose_actions,
    dailyLimit: row.daily_limit,
  };
}

function toRun(row: RunRow): AgentRun {
  return {
    id: row.id,
    connectionId: row.connection_id,
    workspaceId: row.workspace_id,
    chatId: row.chat_id,
    requestedBy: row.requested_by,
    kind: row.kind === "ping" ? "ping" : "task",
    instruction: row.instruction,
    status: asRunStatus(row.status),
    tokenExpiresAt: toTimestamp(row.token_expires_at),
    deadlineAt: toTimestamp(row.deadline_at),
    result: row.result === null ? null : parseResult(row.result),
    error: row.error,
    cancelRequestedAt: toTimestamp(row.cancel_requested_at),
    createdAt: toTimestampNow(row.created_at),
    finishedAt: toTimestamp(row.finished_at),
  };
}

function toEvent(row: EventRow): AgentRunEvent {
  const type = row.type;
  return {
    id: row.id,
    runId: row.run_id,
    seq: row.seq,
    type: type === "progress" || type === "needs_input" || type === "result" ||
        type === "error" || type === "cancelled" || type === "expired" ||
        type === "dispatch_failed" || type === "ack"
      ? type
      : "progress",
    text: row.text,
    percent: row.percent,
    createdAt: toTimestampNow(row.created_at),
  };
}

// --- Errores ------------------------------------------------------------------

/** Error con mensaje ya en español para pintar en la UI. */
export class AgentError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AgentError";
    this.code = code;
  }
}

function rowError(error: unknown, fallback: string): string {
  if (
    isRecord(error) && typeof error["code"] === "string" &&
    (error["code"] === "42501" || error["code"] === "42502")
  ) {
    return "No tienes permiso para eso.";
  }
  const raw = isRecord(error) && typeof error["message"] === "string"
    ? error["message"].trim()
    : "";
  if (raw !== "" && raw.length <= 200 && !raw.includes("SQLSTATE")) return raw;
  return fallback;
}

// --- Lectura (RLS directa, columnas seguras) -----------------------------------

/** Mis agentes (soy el dueño). */
export async function listMyAgents(uid: string): Promise<AgentConnection[]> {
  const { data, error } = await getSupabaseClient()
    .from("agent_connections")
    .select(CONNECTION_COLUMNS)
    .eq("owner_id", uid)
    .order("created_at", { ascending: true });
  if (error !== null) throw new Error(rowError(error, "No se pudieron cargar tus agentes."));
  return ((data ?? []) as unknown as ConnectionRow[]).map(toAgentConnection);
}

/** Grants de una conexión (dueño). */
export async function listGrants(connectionId: string): Promise<AgentSpaceGrant[]> {
  const { data, error } = await getSupabaseClient()
    .from("agent_space_grants")
    .select(GRANT_COLUMNS)
    .eq("connection_id", connectionId);
  if (error !== null) throw new Error(rowError(error, "No se pudieron cargar los espacios."));
  return ((data ?? []) as unknown as GrantRow[]).map(toGrant);
}

/** Agentes habilitados en un espacio (vista "Agentes en este espacio"). */
export async function listSpaceAgents(workspaceId: string): Promise<
  { connection: Pick<AgentConnection, "id" | "name" | "handle" | "avatarEmoji" | "status" | "description">; ownerId: string; grant: AgentSpaceGrant }[]
> {
  const client = getSupabaseClient();
  const { data: grants, error } = await client
    .from("agent_space_grants")
    .select(GRANT_COLUMNS)
    .eq("workspace_id", workspaceId);
  if (error !== null) {
    throw new Error(rowError(error, "No se pudieron cargar los agentes del espacio."));
  }
  const rows = ((grants ?? []) as unknown as GrantRow[]).map(toGrant);
  if (rows.length === 0) return [];
  // La conexión ajena no es legible por RLS: se resuelve por separado y lo
  // que no se ve se omite (no se filtra nada sensible).
  const out: {
    connection: Pick<AgentConnection, "id" | "name" | "handle" | "avatarEmoji" | "status" | "description">;
    ownerId: string;
    grant: AgentSpaceGrant;
  }[] = [];
  for (const grant of rows) {
    const { data: conn } = await client
      .from("agent_connections")
      .select("id, owner_id, name, handle, description, avatar_emoji, status")
      .eq("id", grant.connectionId)
      .maybeSingle();
    if (conn === null) continue;
    const row = conn as unknown as ConnectionRow & { owner_id: string };
    out.push({
      connection: {
        id: row.id,
        name: row.name,
        handle: row.handle,
        avatarEmoji: row.avatar_emoji,
        status: asStatus(row.status),
        description: row.description,
      },
      ownerId: String((row as unknown as Record<string, unknown>)["owner_id"] ?? ""),
      grant,
    });
  }
  return out;
}

/** Historial de eventos de una ejecución (progreso en vivo). */
export async function listRunEvents(runId: string): Promise<AgentRunEvent[]> {
  const { data, error } = await getSupabaseClient()
    .from("agent_run_events")
    .select(EVENT_COLUMNS)
    .eq("run_id", runId)
    .order("seq", { ascending: true });
  if (error !== null) throw new Error(rowError(error, "No se pudo cargar el progreso."));
  return ((data ?? []) as unknown as EventRow[]).map(toEvent);
}

// --- Edge Function agent-connections (secretos) --------------------------------

function functionUrl(path: string): string | null {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim();
  if (base === "") return null;
  return `${base.replace(/\/+$/, "")}/functions/v1/${path}`;
}

async function authToken(): Promise<string> {
  const { data } = await getSupabaseClient().auth.getSession();
  const token = data.session?.access_token ?? "";
  if (token === "") {
    throw new AgentError("no_session", "Tu sesión expiró. Vuelve a iniciar sesión.");
  }
  return token;
}

function friendlyError(status: number, body: unknown): AgentError {
  const code = isRecord(body) && typeof body["code"] === "string"
    ? (body["code"] as string)
    : "failed";
  const serverMessage = isRecord(body) && typeof body["message"] === "string"
    ? (body["message"] as string)
    : null;
  if (status === 503 || code === "not_configured") {
    return new AgentError(
      code,
      serverMessage ?? "Agentes sin configurar en este entorno.",
    );
  }
  if (status === 429) {
    return new AgentError(code, serverMessage ?? "Demasiadas peticiones. Espera un minuto e inténtalo de nuevo.");
  }
  if (status === 401) {
    return new AgentError("no_session", "Tu sesión expiró. Vuelve a iniciar sesión.");
  }
  return new AgentError(code, serverMessage ?? "No se pudo guardar el agente. Inténtalo de nuevo.");
}

async function callAgentConnections(
  action: string,
  extra: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const url = functionUrl(AGENT_FUNCTION_PATH);
  if (url === null) throw new AgentError("no_config", "Falta la configuración de Supabase.");
  const token = await authToken();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: edgeHeaders(token),
      body: JSON.stringify({ action, ...extra }),
    });
  } catch {
    throw new AgentError("network", "Error de red. Revisa tu conexión e inténtalo de nuevo.");
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) throw friendlyError(res.status, body);
  return isRecord(body) ? body : {};
}

function parseConnection(raw: unknown): AgentConnection {
  if (!isRecord(raw)) throw new AgentError("bad_response", "Respuesta inválida del servidor.");
  return {
    id: text(raw["id"]),
    provider: asProvider(raw["provider"]),
    name: text(raw["name"]),
    handle: text(raw["handle"]),
    description: text(raw["description"]),
    avatarEmoji: text(raw["avatar_emoji"], "🤖"),
    dispatchUrl: "",
    hasOutbound: raw["has_outbound"] === true,
    hasInbound: raw["has_inbound"] === true,
    status: asStatus(raw["status"]),
    lastError: textOrNull(raw["last_error"]),
    lastUsedAt: toTimestamp(textOrNull(raw["last_used_at"])),
  };
}

export type AgentGrantInput = {
  workspaceId: string;
  allowedCallers?: AgentAllowedCallers;
  allowedUserIds?: string[];
  allowContext?: boolean;
  contextMessages?: number;
  allowDmContext?: boolean;
  allowPublish?: boolean;
  allowProposeActions?: boolean;
  dailyLimit?: number;
};

/** Crea la conexión (con su primer grant opcional). */
export async function createAgent(input: {
  provider: AgentProvider;
  name: string;
  handle: string;
  description?: string;
  avatarEmoji?: string;
  workspaceId?: string;
  grant?: Omit<AgentGrantInput, "workspaceId">;
}): Promise<AgentConnection> {
  const body = await callAgentConnections("create", {
    provider: input.provider,
    name: input.name,
    handle: input.handle,
    description: input.description ?? "",
    avatar_emoji: input.avatarEmoji ?? "🤖",
    workspace_id: input.workspaceId ?? "",
    grant: {
      allowed_callers: input.grant?.allowedCallers ?? "owner_only",
      allowed_user_ids: input.grant?.allowedUserIds ?? [],
      allow_context: input.grant?.allowContext ?? true,
      context_messages: input.grant?.contextMessages ?? 10,
      allow_dm_context: input.grant?.allowDmContext ?? false,
      allow_publish: input.grant?.allowPublish ?? true,
      allow_propose_actions: input.grant?.allowProposeActions ?? true,
      daily_limit: input.grant?.dailyLimit ?? 20,
    },
  });
  const connection = parseConnection(body["connection"]);
  // La Edge no devuelve la URL (vive en config): se relee por RLS directa.
  const full = await getSupabaseClient()
    .from("agent_connections")
    .select(CONNECTION_COLUMNS)
    .eq("id", connection.id)
    .maybeSingle();
  if (full.data !== null) {
    return toAgentConnection(full.data as unknown as ConnectionRow);
  }
  return connection;
}

/** Edita nombre, handle, descripción o emoji (nunca secretos). */
export async function updateAgent(
  connectionId: string,
  patch: { name?: string; handle?: string; description?: string; avatarEmoji?: string },
): Promise<AgentConnection> {
  const body = await callAgentConnections("update", {
    connection_id: connectionId,
    name: patch.name,
    handle: patch.handle,
    description: patch.description,
    avatar_emoji: patch.avatarEmoji,
  });
  return parseConnection(body["connection"]);
}

/** Guarda la URL de disparo y el secreto saliente (cifrado en el servidor). */
export async function setAgentOutbound(
  connectionId: string,
  input: { dispatchUrl?: string; outboundSecret?: string },
): Promise<void> {
  await callAgentConnections("set-outbound", {
    connection_id: connectionId,
    dispatch_url: input.dispatchUrl ?? "",
    outbound_secret: input.outboundSecret ?? "",
  });
}

/**
 * Genera el token entrante y devuelve el claro UNA sola vez (para copiar).
 * Regenerarlo invalida el anterior.
 */
export async function rotateAgentInbound(connectionId: string): Promise<string> {
  const body = await callAgentConnections("rotate-inbound", { connection_id: connectionId });
  const token = typeof body["token"] === "string" ? body["token"] : "";
  if (token === "") throw new AgentError("bad_response", "El servidor no devolvió el token.");
  return token;
}

/** Invalida el token entrante. */
export async function revokeAgentInbound(connectionId: string): Promise<void> {
  await callAgentConnections("revoke-inbound", { connection_id: connectionId });
}

/** Pausa o reactiva (pausar invalida los tokens vivos). */
export async function setAgentStatus(connectionId: string, status: AgentStatus): Promise<void> {
  if (status === "error") throw new AgentError("bad_status", "Ese estado lo pone el sistema, no tú.");
  await callAgentConnections("set-status", { connection_id: connectionId, status });
}

/** Borra la conexión (caen sus grants y ejecuciones). */
export async function deleteAgent(connectionId: string): Promise<void> {
  await callAgentConnections("remove", { connection_id: connectionId });
}

/** ¿La Edge tiene clave para secretos? (Si no, la UI muestra "sin configurar"). */
export async function agentsConfigured(): Promise<boolean | null> {
  const url = functionUrl(AGENT_FUNCTION_PATH);
  if (url === null) return null;
  try {
    const res = await fetch(url, { method: "GET", headers: { apikey: "anon" } });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!isRecord(body) || typeof body["configured"] !== "boolean") return null;
    return body["configured"];
  } catch {
    return null;
  }
}

// --- Grants (RLS directa, el dueño) --------------------------------------------

export async function addAgentGrant(input: AgentGrantInput & { connectionId: string }): Promise<void> {
  const { error } = await getSupabaseClient().from("agent_space_grants").insert({
    connection_id: input.connectionId,
    workspace_id: input.workspaceId,
    allowed_callers: input.allowedCallers ?? "owner_only",
    allowed_user_ids: input.allowedUserIds ?? [],
    allow_context: input.allowContext ?? true,
    context_messages: input.contextMessages ?? 10,
    allow_dm_context: input.allowDmContext ?? false,
    allow_publish: input.allowPublish ?? true,
    allow_propose_actions: input.allowProposeActions ?? true,
    daily_limit: input.dailyLimit ?? 20,
  });
  if (error !== null) throw new Error(rowError(error, "No se pudo habilitar el espacio."));
}

export async function updateAgentGrant(
  grantId: string,
  patch: Partial<Omit<AgentSpaceGrant, "id" | "connectionId" | "workspaceId" | "adminDisabled">>,
): Promise<void> {
  const data: Database["public"]["Tables"]["agent_space_grants"]["Update"] = {};
  if (patch.enabled !== undefined) data["enabled"] = patch.enabled;
  if (patch.allowedCallers !== undefined) data["allowed_callers"] = patch.allowedCallers;
  if (patch.allowedUserIds !== undefined) data["allowed_user_ids"] = patch.allowedUserIds;
  if (patch.allowContext !== undefined) data["allow_context"] = patch.allowContext;
  if (patch.contextMessages !== undefined) {
    data["context_messages"] = Math.max(0, Math.min(50, Math.floor(patch.contextMessages)));
  }
  if (patch.allowDmContext !== undefined) data["allow_dm_context"] = patch.allowDmContext;
  if (patch.allowPublish !== undefined) data["allow_publish"] = patch.allowPublish;
  if (patch.allowProposeActions !== undefined) data["allow_propose_actions"] = patch.allowProposeActions;
  if (patch.dailyLimit !== undefined) {
    data["daily_limit"] = Math.max(1, Math.min(500, Math.floor(patch.dailyLimit)));
  }
  if (Object.keys(data).length === 0) return;
  const { error } = await getSupabaseClient()
    .from("agent_space_grants")
    .update(data)
    .eq("id", grantId);
  if (error !== null) throw new Error(rowError(error, "No se pudo guardar el permiso."));
}

export async function removeAgentGrant(grantId: string): Promise<void> {
  const { error } = await getSupabaseClient()
    .from("agent_space_grants")
    .delete()
    .eq("id", grantId);
  if (error !== null) throw new Error(rowError(error, "No se pudo quitar el espacio."));
}

/** Gobernanza: un admin desactiva (o reactiva) un agente en su espacio. */
export async function setGrantAdminDisabled(grantId: string, disabled: boolean): Promise<void> {
  const { error } = await getSupabaseClient().rpc("set_agent_grant_admin_disabled", {
    p_grant_id: grantId,
    p_disabled: disabled,
  });
  if (error !== null) throw new Error(rowError(error, "No se pudo cambiar el estado."));
}

// --- Ejecuciones ---------------------------------------------------------------

/**
 * Chat por defecto del espacio para "Probar conexión" (el primer grupo o
 * canal de publicaciones). Si no hay, "general": el despacho igual funciona
 * (contexto vacío) y la tarjeta muestra el progreso.
 */
export async function fetchDefaultChatId(workspaceId: string): Promise<string> {
  const { data } = await getSupabaseClient()
    .from("chats")
    .select("id")
    .eq("workspace_id", workspaceId)
    .in("type", ["group", "posts"])
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (data !== null) {
    const row = data as unknown as { id: string };
    if (typeof row.id === "string" && row.id !== "") return row.id;
  }
  return "general";
}

/**
 * Crea una ejecución de prueba (kind ping): el trigger despierta a
 * agent-dispatch y la tarjeta muestra el progreso en vivo por Realtime.
 */
export async function startAgentPing(input: {
  connectionId: string;
  workspaceId: string;
  chatId: string;
  uid: string;
}): Promise<AgentRun> {
  const idempotencyKey = `ping:${input.connectionId}:${Date.now()}`;
  const { data, error } = await getSupabaseClient()
    .from("agent_runs")
    .insert({
      connection_id: input.connectionId,
      workspace_id: input.workspaceId,
      chat_id: input.chatId,
      requested_by: input.uid,
      kind: "ping",
      instruction: "",
      idempotency_key: idempotencyKey,
    })
    .select(RUN_COLUMNS)
    .single();
  if (error !== null || data === null) {
    throw new Error(rowError(error, "No se pudo iniciar la prueba."));
  }
  return toRun(data as unknown as RunRow);
}

/** Lee una ejecución (para refrescar tras Realtime). */
export async function fetchAgentRun(runId: string): Promise<AgentRun | null> {
  const { data } = await getSupabaseClient()
    .from("agent_runs")
    .select(RUN_COLUMNS)
    .eq("id", runId)
    .maybeSingle();
  if (data === null) return null;
  return toRun(data as unknown as RunRow);
}

/** Pide cancelar (quien la pidió o el dueño). */
export async function cancelAgentRun(runId: string): Promise<boolean> {
  const { data, error } = await getSupabaseClient().rpc("request_agent_run_cancel", {
    p_run_id: runId,
  });
  if (error !== null) throw new Error(rowError(error, "No se pudo cancelar."));
  return data === true;
}

// --- Realtime ------------------------------------------------------------------

/** Progreso en vivo de una ejecución (eventos + estado), sin consultar en bucle. */
export function listenAgentRun(runId: string, onChange: () => void): Unsubscribe {
  const supabase = getSupabaseClient();
  let channel: RealtimeChannel;
  try {
    channel = supabase.channel(`loki:agent-run:${runId}`);
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "agent_runs", filter: `id=eq.${runId}` },
      onChange,
    );
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "agent_run_events", filter: `run_id=eq.${runId}` },
      onChange,
    );
    channel.subscribe();
  } catch {
    return () => undefined;
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    void supabase.removeChannel(channel);
  };
}

/** Cambios en mis conexiones (estado, último uso) sin consultar en bucle. */
export function listenMyAgents(uid: string, onChange: () => void): Unsubscribe {
  const supabase = getSupabaseClient();
  let channel: RealtimeChannel;
  try {
    channel = supabase.channel(`loki:agents:${uid}`);
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "agent_connections", filter: `owner_id=eq.${uid}` },
      onChange,
    );
    channel.subscribe();
  } catch {
    return () => undefined;
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    void supabase.removeChannel(channel);
  };
}

export type {
  AgentAllowedCallers,
  AgentConnection,
  AgentEventType,
  AgentProvider,
  AgentRun,
  AgentRunEvent,
  AgentRunKind,
  AgentRunResult,
  AgentRunStatus,
  AgentSpaceGrant,
  AgentStatus,
};
