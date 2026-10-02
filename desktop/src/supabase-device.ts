/**
 * Cliente Supabase del dispositivo: entra con su propia credencial
 * (email + secreto largo), nunca con la contraseña del dueño.
 *
 * Todo pasa por RPC con su JWT: `device_heartbeat`, `device_claim_command` y
 * `device_report_result`. Si alguna responde "revocado", la app lo respeta al
 * instante (ver `agent.ts`). La subida de capturas/archivos va al bucket
 * `device-results` (`{owner}/{device}/…`), que la app lee con URL firmada.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { isDeviceAction, type DeviceAction } from "./catalog.js";

export type DeviceClient = SupabaseClient;

export interface DeviceFicha {
  ownerId: string;
  allowedActions: DeviceAction[];
  readableDirs: string[];
  canSendFiles: boolean;
  allowArbitrary: boolean;
  revokedAt: string | null;
}

export interface PendingCommand {
  id: string;
  action: DeviceAction;
  params: Record<string, unknown>;
  risk: string;
  status: string;
  expiresAt: string;
}

export interface ClaimTicket {
  action: DeviceAction;
  params: Record<string, unknown>;
  risk: string;
}

export function createDeviceClient(url: string, anonKey: string): DeviceClient {
  return createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    realtime: { params: { eventsPerSecond: 5 } },
  });
}

function friendlyClaimError(message: string): string {
  if (/revocad/i.test(message)) return "PC revocado. Vuelve a vincularlo.";
  if (/confirmaci/i.test(message)) return "Falta la confirmación del dueño en el teléfono.";
  if (/apagad/i.test(message)) return "Esa acción está apagada en este PC.";
  if (/pendiente|ya no está/i.test(message)) return "El comando ya no está pendiente (venció o se resolvió).";
  if (/expir/i.test(message)) return "El comando venció antes de ejecutarse.";
  return message === "" ? "No se pudo tomar el comando." : message.slice(0, 200);
}

export function isRevokedError(message: string): boolean {
  return /revocad/i.test(message);
}

export async function signInDevice(
  client: DeviceClient,
  email: string,
  secret: string,
): Promise<void> {
  const { error } = await client.auth.signInWithPassword({ email, password: secret });
  if (error !== null) {
    if (/invalid login|invalid.*credential/i.test(error.message)) {
      throw new Error("La credencial ya no vale. Desvincula y vuelve a vincular este PC.");
    }
    throw new Error(`No se pudo entrar: ${error.message.slice(0, 160)}`);
  }
}

/** Ficha propia (la RLS solo deja ver la fila de este dispositivo). */
export async function fetchDeviceFicha(
  client: DeviceClient,
  deviceId: string,
): Promise<DeviceFicha | null> {
  const { data, error } = await client
    .from("user_devices")
    .select("id, owner_id, allowed_actions, readable_dirs, can_send_files, allow_arbitrary, revoked_at")
    .eq("id", deviceId)
    .maybeSingle();
  if (error !== null || data === null) return null;
  const row = data as Record<string, unknown>;
  const actions = Array.isArray(row["allowed_actions"])
    ? (row["allowed_actions"] as unknown[]).filter(
        (a): a is DeviceAction => typeof a === "string" && isDeviceAction(a),
      )
    : [];
  const dirs = Array.isArray(row["readable_dirs"])
    ? (row["readable_dirs"] as unknown[]).filter((d): d is string => typeof d === "string")
    : [];
  return {
    ownerId: typeof row["owner_id"] === "string" ? row["owner_id"] : "",
    allowedActions: actions,
    readableDirs: dirs,
    canSendFiles: row["can_send_files"] === true,
    allowArbitrary: row["allow_arbitrary"] === true,
    revokedAt: typeof row["revoked_at"] === "string" ? row["revoked_at"] : null,
  };
}

/** Pendientes no vencidos al reconectar (en orden de llegada, hasta 20). */
export async function fetchPendingCommands(
  client: DeviceClient,
  deviceId: string,
): Promise<PendingCommand[]> {
  const { data, error } = await client
    .from("device_commands")
    .select("id, action, params, risk, status, expires_at")
    .eq("device_id", deviceId)
    .in("status", ["queued", "delivered"])
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: true })
    .limit(20);
  if (error !== null) {
    throw new Error(`No se pudieron recoger los pendientes: ${error.message.slice(0, 160)}`);
  }
  const out: PendingCommand[] = [];
  const rows = (data ?? []) as Record<string, unknown>[];
  for (const row of rows) {
    if (typeof row["id"] !== "string") continue;
    if (typeof row["action"] !== "string" || !isDeviceAction(row["action"])) continue;
    const params =
      typeof row["params"] === "object" && row["params"] !== null
        ? (row["params"] as Record<string, unknown>)
        : {};
    out.push({
      id: row["id"],
      action: row["action"],
      params,
      risk: typeof row["risk"] === "string" ? row["risk"] : "sensible",
      status: typeof row["status"] === "string" ? row["status"] : "queued",
      expiresAt: typeof row["expires_at"] === "string" ? row["expires_at"] : "",
    });
  }
  return out;
}

/**
 * Reclama un comando: la base vuelve a comprobar riesgo + confirmación
 * (doble control; no se confía en lo que llegó por Realtime).
 */
export async function claimCommand(
  client: DeviceClient,
  commandId: string,
): Promise<ClaimTicket> {
  const { data, error } = await client.rpc("device_claim_command", {
    p_command_id: commandId,
  });
  if (error !== null) {
    throw new Error(friendlyClaimError(error.message));
  }
  const rec = (data ?? {}) as Record<string, unknown>;
  if (rec["ok"] !== true) {
    if (rec["code"] === "expired") throw new Error("El comando venció antes de ejecutarse.");
    throw new Error("El comando ya no está pendiente (venció o se resolvió).");
  }
  if (typeof rec["action"] !== "string" || !isDeviceAction(rec["action"])) {
    throw new Error("Esa acción no existe en el catálogo.");
  }
  const params =
    typeof rec["params"] === "object" && rec["params"] !== null
      ? (rec["params"] as Record<string, unknown>)
      : {};
  return {
    action: rec["action"],
    params,
    risk: typeof rec["risk"] === "string" ? rec["risk"] : "sensible",
  };
}

export async function reportResult(
  client: DeviceClient,
  commandId: string,
  ok: boolean,
  text: string,
  path: string | null,
  mime: string,
): Promise<void> {
  const { error } = await client.rpc("device_report_result", {
    p_command_id: commandId,
    p_ok: ok,
    p_result_text: text.slice(0, 8000),
    p_result_path: path,
    p_result_mime: mime.slice(0, 127),
  });
  if (error !== null) {
    throw new Error(`No se pudo informar el resultado: ${error.message.slice(0, 160)}`);
  }
}

/** Latido: se llama al conectar y con cada comando (sin consultas periódicas). */
export async function heartbeat(
  client: DeviceClient,
  deviceId: string,
  appVersion: string,
  platform: string,
): Promise<void> {
  const { error } = await client.rpc("device_heartbeat", {
    p_device_id: deviceId,
    p_app_version: appVersion.slice(0, 32),
    p_platform: platform,
  });
  if (error !== null) {
    throw new Error(error.message);
  }
}

/** Sube capturas/archivos a `device-results` (`{owner}/{device}/…`). */
export async function uploadResultFile(
  client: DeviceClient,
  ownerId: string,
  deviceId: string,
  bytes: Uint8Array,
  filename: string,
  mime: string,
): Promise<string> {
  const clean = filename.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  const path = `${ownerId}/${deviceId}/${Date.now()}-${clean}`;
  const { error } = await client.storage
    .from("device-results")
    .upload(path, bytes, { contentType: mime, upsert: false });
  if (error !== null) {
    throw new Error(`No se pudo subir el archivo: ${error.message.slice(0, 160)}`);
  }
  return path;
}

export function platformName(): string {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  if (process.platform === "linux") return "linux";
  return "other";
}
