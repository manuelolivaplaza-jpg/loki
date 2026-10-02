"use client";

/**
 * Dispositivos (compañero de escritorio) sobre Supabase.
 *
 * Todo el ciclo pasa por RPC (el cliente nunca escribe directo): crear código,
 * pedir, confirmar, revocar y ajustar. El secreto largo solo lo ve el PC una
 * vez (lo entrega la Edge `device-pair`); aquí nunca aparece.
 */

import { Timestamp } from "@/lib/timestamp";
import { getSupabaseClient } from "@/lib/supabase/client";
import { isDeviceAction } from "@/lib/devices/catalog";
import type {
  DeviceAction,
  DeviceAuditDoc,
  DeviceCommandDoc,
  DeviceCommandStatus,
  DeviceDoc,
  DevicePlatform,
  DeviceSettingsPatch,
} from "@/types/devices";
import type { Json } from "@/types/supabase";

export type Unsubscribe = () => void;

function toTimestamp(iso: string | null): Timestamp | null {
  if (iso === null) return null;
  const date = new Date(iso);
  return Timestamp.fromDate(Number.isNaN(date.getTime()) ? new Date() : date);
}

function mustTimestamp(iso: string): Timestamp {
  const date = new Date(iso);
  return Timestamp.fromDate(Number.isNaN(date.getTime()) ? new Date() : date);
}

type DeviceRow = {
  id: string;
  owner_id: string;
  name: string;
  platform: string;
  app_version: string;
  allowed_actions: string[];
  readable_dirs: string[];
  can_send_files: boolean;
  allow_arbitrary: boolean;
  revoked_at: string | null;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
};

const DEVICE_COLUMNS =
  "id, owner_id, name, platform, app_version, allowed_actions, readable_dirs, can_send_files, allow_arbitrary, revoked_at, last_seen_at, created_at, updated_at";

function toDevice(row: DeviceRow): DeviceDoc {
  const platform: DevicePlatform =
    row.platform === "linux" || row.platform === "macos" || row.platform === "other"
      ? row.platform
      : "windows";
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    platform,
    appVersion: row.app_version,
    allowedActions: (row.allowed_actions ?? []).filter(isDeviceAction),
    readableDirs: row.readable_dirs ?? [],
    canSendFiles: row.can_send_files,
    allowArbitrary: row.allow_arbitrary,
    revokedAt: toTimestamp(row.revoked_at),
    lastSeenAt: toTimestamp(row.last_seen_at),
    createdAt: mustTimestamp(row.created_at),
    updatedAt: mustTimestamp(row.updated_at),
  };
}

export async function listDevices(): Promise<DeviceDoc[]> {
  const { data, error } = await getSupabaseClient()
    .from("user_devices")
    .select(DEVICE_COLUMNS)
    .order("created_at", { ascending: true });
  if (error !== null) {
    throw new Error("No se pudieron cargar tus PCs.");
  }
  return ((data ?? []) as DeviceRow[]).map(toDevice);
}

export async function fetchDevice(id: string): Promise<DeviceDoc | null> {
  const { data, error } = await getSupabaseClient()
    .from("user_devices")
    .select(DEVICE_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error !== null || data === null) return null;
  return toDevice(data as DeviceRow);
}

/** Crea un código corto de vinculación (un solo uso, 5 min). */
export async function createPairCode(name: string): Promise<string> {
  const { data, error } = await getSupabaseClient().rpc("create_device_pair_code", {
    p_name: name.slice(0, 60),
  });
  if (error !== null || typeof data !== "string" || data === "") {
    throw new Error("No se pudo generar el código. Inténtalo de nuevo.");
  }
  return data;
}

export async function revokeDevice(id: string): Promise<void> {
  const { error } = await getSupabaseClient().rpc("revoke_device", {
    p_device_id: id,
  });
  if (error !== null) {
    throw new Error("No se pudo revocar el PC.");
  }
}

export async function saveDeviceSettings(
  id: string,
  patch: DeviceSettingsPatch,
): Promise<void> {
  const { error } = await getSupabaseClient().rpc("update_device_settings", {
    p_device_id: id,
    p_name: patch.name ?? null,
    p_allowed_actions: patch.allowedActions ?? null,
    p_readable_dirs: patch.readableDirs ?? null,
    p_can_send_files: patch.canSendFiles ?? null,
    p_allow_arbitrary: patch.allowArbitrary ?? null,
  });
  if (error !== null) {
    throw new Error("No se pudieron guardar los permisos del PC.");
  }
}

type CommandRow = {
  id: string;
  device_id: string;
  owner_id: string;
  workspace_id: string | null;
  chat_id: string;
  message_id: string | null;
  requested_by: string | null;
  action: string;
  params: Record<string, unknown>;
  risk: string;
  status: string;
  result_text: string;
  result_path: string | null;
  result_mime: string;
  confirmed_by: string | null;
  confirmed_at: string | null;
  delivered_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  expires_at: string;
  error: string | null;
  created_at: string;
  updated_at: string;
};

const COMMAND_COLUMNS =
  "id, device_id, owner_id, workspace_id, chat_id, message_id, requested_by, action, params, risk, status, result_text, result_path, result_mime, confirmed_by, confirmed_at, delivered_at, started_at, finished_at, expires_at, error, created_at, updated_at";

function toCommand(row: CommandRow): DeviceCommandDoc | null {
  if (!isDeviceAction(row.action)) return null;
  const status = row.status as DeviceCommandStatus;
  const risk: DeviceCommandDoc["risk"] =
    row.risk === "sensible" ? "sensible" : row.risk === "normal" ? "normal" : "info";
  return {
    id: row.id,
    deviceId: row.device_id,
    ownerId: row.owner_id,
    workspaceId: row.workspace_id,
    chatId: row.chat_id,
    messageId: row.message_id,
    requestedBy: row.requested_by,
    action: row.action,
    params: row.params ?? {},
    risk,
    status,
    resultText: row.result_text,
    resultPath: row.result_path,
    resultMime: row.result_mime,
    confirmedBy: row.confirmed_by,
    confirmedAt: toTimestamp(row.confirmed_at),
    deliveredAt: toTimestamp(row.delivered_at),
    startedAt: toTimestamp(row.started_at),
    finishedAt: toTimestamp(row.finished_at),
    expiresAt: mustTimestamp(row.expires_at),
    error: row.error,
    createdAt: mustTimestamp(row.created_at),
    updatedAt: mustTimestamp(row.updated_at),
  };
}

export async function fetchCommand(id: string): Promise<DeviceCommandDoc | null> {
  const { data, error } = await getSupabaseClient()
    .from("device_commands")
    .select(COMMAND_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error !== null || data === null) return null;
  return toCommand(data as CommandRow);
}

export async function listDeviceCommands(
  deviceId: string,
  limit = 50,
): Promise<DeviceCommandDoc[]> {
  const { data, error } = await getSupabaseClient()
    .from("device_commands")
    .select(COMMAND_COLUMNS)
    .eq("device_id", deviceId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error !== null) {
    throw new Error("No se pudo cargar el historial del PC.");
  }
  const out: DeviceCommandDoc[] = [];
  for (const row of (data ?? []) as CommandRow[]) {
    const cmd = toCommand(row);
    if (cmd !== null) out.push(cmd);
  }
  return out;
}

/** Pide un comando al PC (el dueño, desde un chat permitido). */
export async function requestDeviceCommand(input: {
  deviceId: string;
  action: DeviceAction;
  params: Json;
  workspaceId: string | null;
  chatId: string;
  messageId?: string | null;
}): Promise<{ id: string; status: DeviceCommandStatus }> {
  const { data, error } = await getSupabaseClient().rpc("request_device_command", {
    p_device_id: input.deviceId,
    p_action: input.action,
    p_params: input.params,
    p_workspace_id: input.workspaceId,
    p_chat_id: input.chatId,
    p_message_id: input.messageId ?? null,
  });
  if (error !== null || data === null || typeof data !== "object") {
    throw new Error(friendlyRpcError(error?.message ?? ""));
  }
  const rec = data as Record<string, unknown>;
  if (typeof rec["id"] !== "string") {
    throw new Error("No se pudo mandar la orden al PC.");
  }
  return { id: rec["id"], status: (rec["status"] as DeviceCommandStatus) ?? "queued" };
}

function friendlyRpcError(message: string): string {
  if (message.includes("Demasiados pedidos")) {
    return "Demasiados pedidos seguidos. Espera un minuto.";
  }
  if (message.includes("revocado")) return "Ese PC está revocado.";
  if (message.includes("apagada")) {
    return "Esa acción está apagada en este PC.";
  }
  if (message.includes("carpeta") || message.includes("ruta")) {
    return "Esa carpeta o ruta no está permitida en este PC.";
  }
  if (message.includes("no se puede ordenar")) {
    return "Desde este chat no se puede ordenar a ese PC.";
  }
  if (message.includes("Solo URLs https")) return "Solo URLs https válidas.";
  return "No se pudo mandar la orden al PC.";
}

/** Aprueba o rechaza un comando sensible (el dueño, dentro de 5 min). */
export async function confirmDeviceCommand(id: string, ok: boolean): Promise<boolean> {
  const { data, error } = await getSupabaseClient().rpc("confirm_device_command", {
    p_command_id: id,
    p_ok: ok,
  });
  if (error !== null) {
    throw new Error("No se pudo registrar tu decisión. Quizás ya venció.");
  }
  return data === true;
}

type AuditRow = {
  id: string;
  device_id: string;
  owner_id: string;
  command_id: string | null;
  actor_id: string | null;
  action: string;
  detail: string;
  created_at: string;
};

const AUDIT_ACTIONS = new Set([
  "paired",
  "revoked",
  "requested",
  "confirmed",
  "rejected",
  "claimed",
  "delivered",
  "done",
  "error",
  "expired",
  "settings",
]);

export async function listDeviceAudit(
  deviceId: string,
  limit = 100,
): Promise<DeviceAuditDoc[]> {
  const { data, error } = await getSupabaseClient()
    .from("device_audit_log")
    .select("id, device_id, owner_id, command_id, actor_id, action, detail, created_at")
    .eq("device_id", deviceId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error !== null) {
    throw new Error("No se pudo cargar la auditoría del PC.");
  }
  const out: DeviceAuditDoc[] = [];
  for (const row of (data ?? []) as AuditRow[]) {
    if (!AUDIT_ACTIONS.has(row.action)) continue;
    out.push({
      id: row.id,
      deviceId: row.device_id,
      ownerId: row.owner_id,
      commandId: row.command_id,
      actorId: row.actor_id,
      action: row.action as DeviceAuditDoc["action"],
      detail: row.detail,
      createdAt: mustTimestamp(row.created_at),
    });
  }
  return out;
}

/** URL firmada para ver un resultado guardado en Storage (captura/archivo). */
export async function signDeviceResult(
  path: string,
  expiresIn = 3600,
): Promise<string | null> {
  const { data, error } = await getSupabaseClient()
    .storage.from("device-results")
    .createSignedUrl(path, expiresIn);
  if (error !== null || data === null) return null;
  return data.signedUrl;
}

/** Un solo canal realtime por comando (el PC y la app ven el estado en vivo). */
export function listenCommand(
  commandId: string,
  cb: (cmd: DeviceCommandDoc | null) => void,
): Unsubscribe {
  const supabase = getSupabaseClient();
  const channel = supabase.channel(`loki:device-cmd:${commandId}`);
  let cancelled = false;
  channel.on(
    "postgres_changes",
    {
      event: "*",
      schema: "public",
      table: "device_commands",
      filter: `id=eq.${commandId}`,
    },
    () => {
      if (cancelled) return;
      void fetchCommand(commandId)
        .then((cmd) => {
          if (!cancelled) cb(cmd);
        })
        .catch(() => undefined);
    },
  );
  channel.subscribe();
  return () => {
    cancelled = true;
    void supabase.removeChannel(channel);
  };
}

/** Cambios de un PC (revocación, latido) + sus comandos, en un canal. */
export function listenDevice(
  deviceId: string,
  cb: () => void,
): Unsubscribe {
  const supabase = getSupabaseClient();
  const channel = supabase.channel(`loki:device:${deviceId}`);
  let cancelled = false;
  const reload = (): void => {
    if (!cancelled) cb();
  };
  channel.on(
    "postgres_changes",
    {
      event: "*",
      schema: "public",
      table: "device_commands",
      filter: `device_id=eq.${deviceId}`,
    },
    reload,
  );
  channel.on(
    "postgres_changes",
    {
      event: "*",
      schema: "public",
      table: "user_devices",
      filter: `id=eq.${deviceId}`,
    },
    reload,
  );
  channel.subscribe();
  return () => {
    cancelled = true;
    void supabase.removeChannel(channel);
  };
}
